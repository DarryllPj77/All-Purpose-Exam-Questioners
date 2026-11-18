"""Code Challenge API (Phase 9).

Route (login_required, filtered by the signed-in user):
  POST /api/code/<set_id>/<question_id>/answer → grade one code challenge

Security: nothing is executed. Code in a question is only displayed; an
answer is compared with what the question set stores:
* format "choice": the selected choices must be exactly the correct set
  (same rule as every other mode).
* format "output": only for "output" (predict the output) challenges. The
  typed output must equal the expected output after normalize_output():
  line endings unified, trailing spaces on each line and blank lines at the
  start and end ignored. Everything else, including letter case, counts.
  The expected output is the question's "expectedOutput", or the text of
  its single correct choice. Mirrors normalizeOutput() in js/core/code.js.

Each answer is logged with mode "code", so a miss reaches Mistake Review
and brings Smart Review forward like a miss anywhere else.
"""

from __future__ import annotations

import re
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, fetch_one
from learning_config import CODE
from question_ids import QUESTION_ID_RE

bp = Blueprint("code", __name__)

SET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MODE = "code"


def _answer_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    return [] if value is None else [str(value)]


def challenge_of(question: dict[str, Any]) -> str:
    kind = question.get("challenge")
    return kind if kind in CODE["challenges"] else "choice"


def normalize_output(text: str) -> str:
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [line.rstrip() for line in lines]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def expected_output(question: dict[str, Any]) -> str | None:
    """The output a learner must type, or None when it can't be typed."""
    if challenge_of(question) != "output":
        return None
    given = question.get("expectedOutput")
    if isinstance(given, str) and given.strip():
        return given
    answers = _answer_list(question.get("answer"))
    if len(answers) == 1:
        text = (question.get("choices") or {}).get(answers[0])
        if isinstance(text, str) and text.strip():
            return text
    return None


def grade(question: dict[str, Any], payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Return (outcome, response) or raise ValueError for a bad request."""
    fmt = payload.get("format")
    if fmt == "choice":
        selected = payload.get("selected")
        if not isinstance(selected, list) or not selected or len(selected) > 20:
            raise ValueError("selected must be a non-empty list of choice keys.")
        selected = sorted({str(s) for s in selected})
        choices = question.get("choices") or {}
        if any(s not in choices for s in selected):
            raise ValueError("selected contains an unknown choice.")
        expected = sorted(set(_answer_list(question.get("answer"))))
        return ("correct" if selected == expected else "incorrect"), {"format": fmt, "selected": selected}
    if fmt == "output":
        expected = expected_output(question)
        if expected is None:
            raise ValueError("This question can't be answered by typing the output.")
        typed = payload.get("text")
        if not isinstance(typed, str) or len(typed) > CODE["max_output_chars"]:
            raise ValueError("text must be a string.")
        ok = normalize_output(typed) == normalize_output(expected) and normalize_output(typed) != ""
        return ("correct" if ok else "incorrect"), {"format": fmt, "text": typed}
    raise ValueError("format must be 'choice' or 'output'.")


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


@bp.route("/api/code/<set_id>/<question_id>/answer", methods=["POST"])
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
    client_id = payload.get("clientAttemptId")
    if client_id is not None and (not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id)):
        return _error("Malformed clientAttemptId.")
    try:
        outcome, response = grade(question, payload)
    except ValueError as e:
        return _error(str(e))
    response["challenge"] = challenge_of(question)

    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO question_attempts
                (owner_id, set_id, question_id, mode, outcome, response, client_attempt_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (owner_id, client_attempt_id) WHERE client_attempt_id IS NOT NULL DO NOTHING
            """,
            (uid, set_id, question_id, MODE, outcome, Json(response), client_id),
        )
        duplicate = cur.rowcount == 0

    body: dict[str, Any] = {
        "ok": True,
        "duplicate": duplicate,
        "outcome": outcome,
        "correctAnswer": sorted(set(_answer_list(question.get("answer")))),
    }
    expected = expected_output(question)
    if expected is not None:
        body["expectedOutput"] = expected
    return jsonify(body)
