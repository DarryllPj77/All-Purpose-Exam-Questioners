"""Active Recall API (Phase 6).

Route (login_required, filtered by the signed-in user):
  POST /api/recall/<set_id>/<question_id>/rate → save a self-assessment

The learner answers without seeing choices, reveals the reference answer and
rates themselves "correct", "partial" or "incorrect". The rating is the
record: no AI or fuzzy grading decides it. When something was typed, the
server also records whether it matched an accepted answer after
normalize_text(), so the history shows both the self-assessment and the
objective match.

Accepted answers: the correct choice's text when the question has a single,
specific answer, plus any optional "acceptedAnswers" strings stored on the
question. Mirrors acceptedAnswers() in js/core/learning.js.

Progress: question_progress.recall_rating / recall_updated_at. Each rating
is logged to the answer log with mode "recall" (outcome = rating), so an
"incorrect" recall reaches Mistake Review like a wrong answer anywhere else.
"""

from __future__ import annotations

import re
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, fetch_one
from learn_routes import VAGUE_ANSWER_RE, normalize_text
from learning_config import RECALL_RATINGS
from question_ids import QUESTION_ID_RE

bp = Blueprint("recall", __name__)

SET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_TYPED_CHARS = 2000


def accepted_answers(question: dict[str, Any]) -> list[str]:
    out: list[str] = []
    answers = question.get("answer")
    answers = answers if isinstance(answers, list) else ([answers] if answers is not None else [])
    choices = question.get("choices") or {}
    if len(answers) == 1:
        text = choices.get(str(answers[0]))
        if isinstance(text, str) and text.strip() and not VAGUE_ANSWER_RE.search(normalize_text(text)):
            out.append(text.strip())
    extra = question.get("acceptedAnswers")
    if isinstance(extra, list):
        out.extend(a.strip() for a in extra[:20] if isinstance(a, str) and a.strip() and len(a) <= 200)
    return out


def matches_accepted(question: dict[str, Any], typed: str) -> bool | None:
    """True / False when the typed text can be checked, None when it can't."""
    accepted = [normalize_text(a) for a in accepted_answers(question)]
    accepted = [a for a in accepted if a]
    given = normalize_text(typed)
    if not accepted or not given:
        return None
    return given in accepted


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


@bp.route("/api/recall/<set_id>/<question_id>/rate", methods=["POST"])
@login_required
def rate(set_id: str, question_id: str):
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
    rating = payload.get("rating")
    if rating not in RECALL_RATINGS:
        return _error("rating must be 'incorrect', 'partial' or 'correct'.")
    typed = payload.get("text") or ""
    if not isinstance(typed, str) or len(typed) > MAX_TYPED_CHARS:
        return _error("text must be a string.")
    client_id = payload.get("clientAttemptId")
    if client_id is not None and (not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id)):
        return _error("Malformed clientAttemptId.")

    auto = matches_accepted(question, typed)
    response = {"text": typed, "rating": rating, "autoMatched": auto, "selfAssessed": True}

    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO question_attempts
                (owner_id, set_id, question_id, mode, outcome, response, client_attempt_id)
            VALUES (%s, %s, %s, 'recall', %s, %s, %s)
            ON CONFLICT (owner_id, client_attempt_id) WHERE client_attempt_id IS NOT NULL DO NOTHING
            """,
            (uid, set_id, question_id, rating, Json(response), client_id),
        )
        duplicate = cur.rowcount == 0
        if not duplicate:
            cur.execute(
                """
                INSERT INTO question_progress (owner_id, set_id, question_id, recall_rating, recall_updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (owner_id, set_id, question_id) DO UPDATE SET
                    recall_rating = EXCLUDED.recall_rating,
                    recall_updated_at = NOW(),
                    updated_at = NOW()
                """,
                (uid, set_id, question_id, rating),
            )

    return jsonify({"ok": True, "duplicate": duplicate, "rating": rating, "autoMatched": auto})
