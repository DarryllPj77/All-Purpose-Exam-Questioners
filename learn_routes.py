"""Learn mode API (Phase 5).

Route (login_required, filtered by the signed-in user):
  POST /api/learn/<set_id>/<question_id>/answer → grade one answer, update mastery

Formats
* "choice":  selected choice keys; graded by the shared rule (exact set).
* "written": typed text, for single-answer questions whose correct choice
             is short and specific; matched after normalize_text().
* "recall":  the learner revealed the answer and rated themselves
             ("correct" / "incorrect"). Self-reported, logged as such.

Mastery (learning_config.LEARN_MASTERY): a correct answer extends the
streak; the stage is "familiar" at correct_streak_for_familiar and
"mastered" at correct_streak_for_mastered. A wrong answer resets the streak
and the stage to "learning". Every answer is also logged to the answer log
with mode "learn", so Learn mistakes reach Mistake Review.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, fetch_one
from learning_config import LEARN_MASTERY
from mistakes_routes import is_correct
from question_ids import QUESTION_ID_RE

bp = Blueprint("learn", __name__)

SET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_WRITTEN_ANSWER_CHARS = 80
MAX_TYPED_CHARS = 500
FORMATS = ("choice", "written", "recall")
VAGUE_ANSWER_RE = re.compile(r"(of the above|^both\b|^neither\b|^all\b|^none\b)")


def normalize_text(value: str) -> str:
    """Case, quotes, punctuation, spacing and a leading article never matter.

    Mirrored exactly by normalizeText() in js/modes/learn.js.
    """
    s = unicodedata.normalize("NFKC", str(value or "")).lower().strip()
    s = re.sub(r"[\"'“”‘’`]", "", s)
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^(a|an|the) ", "", s)
    return s


def written_answer(question: dict[str, Any]) -> str | None:
    """The text a learner would type, or None when typing makes no sense."""
    answers = question.get("answer")
    answers = answers if isinstance(answers, list) else [answers]
    if len(answers) != 1:
        return None
    choices = question.get("choices") or {}
    text = choices.get(str(answers[0]))
    if not isinstance(text, str):
        return None
    norm = normalize_text(text)
    if not norm or len(text.strip()) > MAX_WRITTEN_ANSWER_CHARS or VAGUE_ANSWER_RE.search(norm):
        return None
    # Typing must identify one choice: no other choice may normalize the same.
    others = [normalize_text(v) for k, v in choices.items() if k != str(answers[0]) and isinstance(v, str)]
    if norm in others:
        return None
    return text.strip()


def next_progress(correct: bool, streak: int) -> tuple[str, int]:
    """(stage, streak) after an answer, per LEARN_MASTERY."""
    if not correct:
        return "learning", 0
    streak += 1
    if streak >= LEARN_MASTERY["correct_streak_for_mastered"]:
        return "mastered", streak
    if streak >= LEARN_MASTERY["correct_streak_for_familiar"]:
        return "familiar", streak
    return "learning", streak


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


@bp.route("/api/learn/<set_id>/<question_id>/answer", methods=["POST"])
@login_required
def answer(set_id: str, question_id: str):
    if not SET_ID_RE.match(set_id):
        return _error("Bad set id.")
    if not QUESTION_ID_RE.match(question_id):
        return _error("Bad question id.")
    uid = current_user_id()
    owned = fetch_one("SELECT questions FROM question_sets WHERE id = %s AND owner_id = %s", (set_id, uid))
    if not owned:
        return _error("Not found.", 404)
    question = next((q for q in (owned["questions"] or [])
                     if isinstance(q, dict) and q.get("id") == question_id), None)
    if not question:
        return _error("That question is not in this set.")

    payload = request.get_json(silent=True) or {}
    fmt = payload.get("format")
    if fmt not in FORMATS:
        return _error("format must be 'choice', 'written' or 'recall'.")
    client_id = payload.get("clientAttemptId")
    if client_id is not None and (not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id)):
        return _error("Malformed clientAttemptId.")

    choices = question.get("choices") or {}
    expected_text = None
    if fmt == "choice":
        selected = payload.get("selected")
        if not isinstance(selected, list) or not selected or len(selected) > 20:
            return _error("selected must be a non-empty list of choice keys.")
        selected = [str(s) for s in selected]
        if any(s not in choices for s in selected):
            return _error("selected contains an unknown choice.")
        correct = is_correct(question, selected)
        response = {"format": fmt, "selected": selected}
    elif fmt == "written":
        expected_text = written_answer(question)
        if expected_text is None:
            return _error("This question can't be answered by typing.")
        typed = payload.get("text")
        if not isinstance(typed, str) or len(typed) > MAX_TYPED_CHARS:
            return _error("text must be a string.")
        correct = bool(normalize_text(typed)) and normalize_text(typed) == normalize_text(expected_text)
        response = {"format": fmt, "text": typed}
    else:
        rating = payload.get("rating")
        if rating not in ("correct", "incorrect"):
            return _error("rating must be 'correct' or 'incorrect'.")
        correct = rating == "correct"
        response = {"format": fmt, "rating": rating, "selfAssessed": True}

    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO question_attempts
                (owner_id, set_id, question_id, mode, outcome, response, client_attempt_id)
            VALUES (%s, %s, %s, 'learn', %s, %s, %s)
            ON CONFLICT (owner_id, client_attempt_id) WHERE client_attempt_id IS NOT NULL DO NOTHING
            """,
            (uid, set_id, question_id, "correct" if correct else "incorrect", Json(response), client_id),
        )
        duplicate = cur.rowcount == 0
        cur.execute(
            "SELECT learn_stage, learn_streak FROM question_progress "
            "WHERE owner_id = %s AND set_id = %s AND question_id = %s FOR UPDATE",
            (uid, set_id, question_id),
        )
        row = cur.fetchone()
        prev_stage = (row and row["learn_stage"]) or "new"
        streak = (row and row["learn_streak"]) or 0
        stage = prev_stage
        if not duplicate:
            stage, streak = next_progress(correct, streak)
            cur.execute(
                """
                INSERT INTO question_progress
                    (owner_id, set_id, question_id, learn_stage, learn_streak,
                     learn_correct, learn_incorrect, learn_updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (owner_id, set_id, question_id) DO UPDATE SET
                    learn_stage = EXCLUDED.learn_stage,
                    learn_streak = EXCLUDED.learn_streak,
                    learn_correct = question_progress.learn_correct + EXCLUDED.learn_correct,
                    learn_incorrect = question_progress.learn_incorrect + EXCLUDED.learn_incorrect,
                    learn_updated_at = NOW(),
                    updated_at = NOW()
                """,
                (uid, set_id, question_id, stage, streak, 1 if correct else 0, 0 if correct else 1),
            )

    answers = question.get("answer")
    return jsonify({
        "ok": True,
        "duplicate": duplicate,
        "correct": correct,
        "stage": stage,
        "previousStage": prev_stage,
        "streak": streak,
        "masteredAt": LEARN_MASTERY["correct_streak_for_mastered"],
        "correctAnswer": [str(a) for a in (answers if isinstance(answers, list) else [answers])],
        "acceptedText": expected_text,
    })
