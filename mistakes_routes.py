"""Mistake Review API (Phase 4).

Routes (all login_required, all filtered by the signed-in user):
  GET  /api/mistakes                              → mistakes with question content
  POST /api/mistakes/<set_id>/<question_id>/retry → grade a retry on the server
  POST /api/mistakes/reset                        → close items (history is kept)

Rules (thresholds in learning_config.MISTAKES):
* The answer log (question_attempts) is the source of truth. A question is
  open for review when it has an "incorrect" answer from any mode other than
  Mistake Review that is newer than its last review change. This is
  reconciled on every read, so answers recorded before this phase count too.
* A retry is graded here, against the stored answer, and logged with mode
  "mistakes". Correct retries build a streak; the question is resolved only
  after MISTAKES["correct_retries_to_resolve"] correct retries in a row.
  A wrong retry resets the streak. A new mistake anywhere reopens it.
* Nothing is ever deleted: resolving or resetting only changes the status in
  question_progress; every attempt stays in the history.
"""

from __future__ import annotations

import re
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, fetch_all, fetch_one
from learning_config import MISTAKES
from question_ids import QUESTION_ID_RE

bp = Blueprint("mistakes", __name__)

SET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
REVIEW_MODE = "mistakes"


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _answer_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    return [] if value is None else [str(value)]


def is_correct(question: dict[str, Any], selected: Any) -> bool:
    """Same rule as js/core/learning.js: exactly the correct set, any order."""
    expected = sorted(set(_answer_list(question.get("answer"))))
    given = sorted(set(_answer_list(selected)))
    return bool(expected) and expected == given


def _owned_set(uid: int, set_id: str) -> dict[str, Any] | None:
    return fetch_one(
        "SELECT id, title, questions FROM question_sets WHERE id = %s AND owner_id = %s",
        (set_id, uid),
    )


def _reconcile(uid: int, set_id: str | None) -> None:
    """Open every question with a mistake newer than its last review change."""
    params: list[Any] = [uid]
    set_clause = ""
    if set_id:
        set_clause = "AND a.set_id = %s"
        params.append(set_id)
    with cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO question_progress
                (owner_id, set_id, question_id, mistake_open, mistake_retry_streak, mistake_updated_at)
            SELECT a.owner_id, a.set_id, a.question_id, TRUE, 0, MAX(a.created_at)
            FROM question_attempts AS a
            LEFT JOIN question_progress AS p
              ON p.owner_id = a.owner_id AND p.set_id = a.set_id AND p.question_id = a.question_id
            WHERE a.owner_id = %s {set_clause}
              AND a.outcome = 'incorrect' AND a.mode <> '{REVIEW_MODE}'
              AND (p.mistake_updated_at IS NULL OR a.created_at > p.mistake_updated_at)
            GROUP BY a.owner_id, a.set_id, a.question_id
            ON CONFLICT (owner_id, set_id, question_id) DO UPDATE SET
                mistake_open = TRUE,
                mistake_retry_streak = 0,
                mistake_updated_at = EXCLUDED.mistake_updated_at,
                updated_at = NOW()
            """,
            params,
        )


def _public_question(q: dict[str, Any]) -> dict[str, Any]:
    answers = _answer_list(q.get("answer"))
    return {
        "id": q.get("id"),
        "text": q.get("text") or "",
        "choices": q.get("choices") or {},
        "answer": answers,
        "answerDescriptions": q.get("answerDescriptions") or {},
        "maxSelections": q.get("maxSelections") or max(1, len(answers)),
    }


# ============================================================
# List
# ============================================================

@bp.route("/api/mistakes", methods=["GET"])
@login_required
def list_mistakes():
    uid = current_user_id()
    set_id = request.args.get("setId") or None
    if set_id:
        if not SET_ID_RE.match(set_id):
            return _error("Bad set id.")
        if not _owned_set(uid, set_id):
            return _error("Not found.", 404)

    _reconcile(uid, None)  # all sets, so the per-set counts below are current

    set_filter = "AND p.set_id = %s" if set_id else ""
    params: list[Any] = [uid] + ([set_id] if set_id else [])

    # Every question that has ever been a mistake (open or resolved).
    rows = fetch_all(
        f"""
        SELECT p.set_id, p.question_id, p.mistake_open, p.mistake_retry_streak, p.mistake_updated_at
        FROM question_progress AS p
        WHERE p.owner_id = %s {set_filter}
          AND (p.mistake_open OR EXISTS (
                SELECT 1 FROM question_attempts AS a
                WHERE a.owner_id = p.owner_id AND a.set_id = p.set_id AND a.question_id = p.question_id
                  AND a.outcome = 'incorrect' AND a.mode <> '{REVIEW_MODE}'))
        """,
        params,
    )

    stats_filter = "AND set_id = %s" if set_id else ""
    stats = fetch_all(
        f"""
        SELECT set_id, question_id,
               COUNT(*) FILTER (WHERE outcome = 'incorrect' AND mode <> '{REVIEW_MODE}') AS times_wrong,
               MAX(created_at) FILTER (WHERE outcome = 'incorrect' AND mode <> '{REVIEW_MODE}') AS last_wrong_at,
               COUNT(*) FILTER (WHERE mode = '{REVIEW_MODE}') AS review_attempts,
               COUNT(*) FILTER (WHERE mode = '{REVIEW_MODE}' AND outcome = 'correct') AS review_correct
        FROM question_attempts
        WHERE owner_id = %s {stats_filter}
        GROUP BY set_id, question_id
        """,
        params,
    )
    stat_by_key = {(s["set_id"], s["question_id"]): s for s in stats}

    last_modes = fetch_all(
        f"""
        SELECT DISTINCT ON (set_id, question_id) set_id, question_id, mode
        FROM question_attempts
        WHERE owner_id = %s {stats_filter}
          AND outcome = 'incorrect' AND mode <> '{REVIEW_MODE}'
        ORDER BY set_id, question_id, created_at DESC, id DESC
        """,
        params,
    )
    mode_by_key = {(m["set_id"], m["question_id"]): m["mode"] for m in last_modes}

    set_ids = sorted({r["set_id"] for r in rows})
    sets = {}
    if set_ids:
        for s in fetch_all(
            "SELECT id, title, questions FROM question_sets WHERE owner_id = %s AND id = ANY(%s)",
            (uid, set_ids),
        ):
            sets[s["id"]] = {
                "title": s["title"],
                "questions": {q["id"]: q for q in (s["questions"] or [])
                              if isinstance(q, dict) and isinstance(q.get("id"), str)},
            }

    needed = MISTAKES["correct_retries_to_resolve"]
    items = []
    unavailable = 0
    for r in rows:
        key = (r["set_id"], r["question_id"])
        set_info = sets.get(r["set_id"])
        question = set_info["questions"].get(r["question_id"]) if set_info else None
        if not question:
            unavailable += 1  # edited or removed from its set; history is kept
            continue
        st = stat_by_key.get(key) or {}
        items.append({
            "setId": r["set_id"],
            "setTitle": set_info["title"],
            "questionId": r["question_id"],
            "open": r["mistake_open"],
            "retryStreak": r["mistake_retry_streak"],
            "needed": needed,
            "timesWrong": st.get("times_wrong", 0),
            "lastWrongAt": _iso(st.get("last_wrong_at")),
            "lastWrongMode": mode_by_key.get(key),
            "reviewAttempts": st.get("review_attempts", 0),
            "reviewCorrect": st.get("review_correct", 0),
            "updatedAt": _iso(r["mistake_updated_at"]),
            "question": _public_question(question),
        })
    items.sort(key=lambda i: (not i["open"], -(i["timesWrong"] or 0), i["lastWrongAt"] or ""), reverse=False)

    # Open counts per set (always across all sets) for the set filter.
    per_set = fetch_all(
        """
        SELECT p.set_id, s.title, COUNT(*) FILTER (WHERE p.mistake_open) AS open_count
        FROM question_progress AS p
        JOIN question_sets AS s ON s.id = p.set_id AND s.owner_id = p.owner_id
        WHERE p.owner_id = %s AND (p.mistake_open OR p.mistake_updated_at IS NOT NULL)
        GROUP BY p.set_id, s.title
        ORDER BY s.title
        """,
        (uid,),
    )

    open_items = [i for i in items if i["open"]]
    return jsonify({
        "ok": True,
        "needed": needed,
        "items": items,
        "summary": {
            "open": len(open_items),
            "resolved": len(items) - len(open_items),
            "reviewAttempts": sum(i["reviewAttempts"] for i in items),
            "reviewCorrect": sum(i["reviewCorrect"] for i in items),
            "unavailable": unavailable,
        },
        "sets": [{"setId": s["set_id"], "title": s["title"], "open": s["open_count"]} for s in per_set],
    })


# ============================================================
# Retry (graded on the server)
# ============================================================

@bp.route("/api/mistakes/<set_id>/<question_id>/retry", methods=["POST"])
@login_required
def retry_mistake(set_id: str, question_id: str):
    if not SET_ID_RE.match(set_id):
        return _error("Bad set id.")
    if not QUESTION_ID_RE.match(question_id):
        return _error("Bad question id.")
    uid = current_user_id()
    owned = _owned_set(uid, set_id)
    if not owned:
        return _error("Not found.", 404)
    question = next((q for q in (owned["questions"] or [])
                     if isinstance(q, dict) and q.get("id") == question_id), None)
    if not question:
        return _error("That question is not in this set.")

    payload = request.get_json(silent=True) or {}
    selected = payload.get("selected")
    if not isinstance(selected, list) or not selected or len(selected) > 20:
        return _error("selected must be a non-empty list of choice keys.")
    choices = question.get("choices") or {}
    selected = [str(s) for s in selected]
    if any(s not in choices for s in selected):
        return _error("selected contains an unknown choice.")
    client_id = payload.get("clientAttemptId")
    if client_id is not None and (not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id)):
        return _error("Malformed clientAttemptId.")

    correct = is_correct(question, selected)
    needed = MISTAKES["correct_retries_to_resolve"]
    _reconcile(uid, set_id)  # make sure recent mistakes are open before grading

    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO question_attempts
                (owner_id, set_id, question_id, mode, outcome, response, client_attempt_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (owner_id, client_attempt_id) WHERE client_attempt_id IS NOT NULL DO NOTHING
            """,
            (uid, set_id, question_id, REVIEW_MODE, "correct" if correct else "incorrect",
             Json({"selected": selected}), client_id),
        )
        duplicate = cur.rowcount == 0

        cur.execute(
            "SELECT mistake_open, mistake_retry_streak FROM question_progress "
            "WHERE owner_id = %s AND set_id = %s AND question_id = %s FOR UPDATE",
            (uid, set_id, question_id),
        )
        row = cur.fetchone()
        was_open = bool(row and row["mistake_open"])
        streak = row["mistake_retry_streak"] if row else 0

        if not duplicate:
            if correct:
                streak += 1
                now_open = was_open and streak < needed
            else:
                streak = 0
                now_open = True  # a wrong retry always keeps (or puts) it in review
            cur.execute(
                """
                INSERT INTO question_progress
                    (owner_id, set_id, question_id, mistake_open, mistake_retry_streak, mistake_updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (owner_id, set_id, question_id) DO UPDATE SET
                    mistake_open = EXCLUDED.mistake_open,
                    mistake_retry_streak = EXCLUDED.mistake_retry_streak,
                    mistake_updated_at = NOW(),
                    updated_at = NOW()
                """,
                (uid, set_id, question_id, now_open, streak),
            )
        else:
            now_open = was_open

    return jsonify({
        "ok": True,
        "duplicate": duplicate,
        "correct": correct,
        "correctAnswer": _answer_list(question.get("answer")),
        "streak": streak,
        "needed": needed,
        "open": now_open,
        "resolved": was_open and not now_open,
    })


# ============================================================
# Reset (status only; history is kept)
# ============================================================

@bp.route("/api/mistakes/reset", methods=["POST"])
@login_required
def reset_mistakes():
    uid = current_user_id()
    payload = request.get_json(silent=True) or {}
    set_id = payload.get("setId")
    question_id = payload.get("questionId")
    clauses = ["owner_id = %s", "mistake_open"]
    params: list[Any] = [uid]
    if set_id is not None:
        if not isinstance(set_id, str) or not SET_ID_RE.match(set_id):
            return _error("Bad set id.")
        if not _owned_set(uid, set_id):
            return _error("Not found.", 404)
        clauses.append("set_id = %s")
        params.append(set_id)
    if question_id is not None:
        if set_id is None:
            return _error("questionId needs a setId.")
        if not isinstance(question_id, str) or not QUESTION_ID_RE.match(question_id):
            return _error("Bad question id.")
        clauses.append("question_id = %s")
        params.append(question_id)

    _reconcile(uid, set_id)
    with cursor() as cur:
        cur.execute(
            "UPDATE question_progress SET mistake_open = FALSE, mistake_retry_streak = 0, "
            f"mistake_updated_at = NOW(), updated_at = NOW() WHERE {' AND '.join(clauses)}",
            params,
        )
        closed = cur.rowcount
    return jsonify({"ok": True, "closed": closed})
