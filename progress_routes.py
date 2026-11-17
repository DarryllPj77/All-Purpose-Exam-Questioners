"""Learning progress API (Phase 1 foundation).

Routes (all login_required, all filtered by the signed-in user):
  GET    /api/learning/config                    → mastery/review rules
  GET    /api/progress/<set_id>                  → per-question progress rows
  POST   /api/progress/<set_id>/attempts         → record answers (batch)
  GET    /api/progress/<set_id>/attempts         → answer history
  GET    /api/study-sessions/<set_id>/<mode>     → resumable mode state
  PUT    /api/study-sessions/<set_id>/<mode>     → save mode state
  DELETE /api/study-sessions/<set_id>/<mode>     → discard mode state

Mode-specific progress columns (flashcard status, Learn stage, review
schedule, ...) are written by each mode's own endpoint as it is built, so
every rule lives next to the code that applies it.
"""

from __future__ import annotations

import json
import re
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, execute, fetch_all, fetch_one
from learning_config import ATTEMPT_OUTCOMES, STUDY_MODES, public_config
from question_ids import QUESTION_ID_RE

bp = Blueprint("progress", __name__)

SET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_ATTEMPTS_PER_REQUEST = 200
MAX_RESPONSE_BYTES = 4_000
MAX_SESSION_STATE_BYTES = 200_000
MAX_HISTORY_LIMIT = 500


def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def _set_question_ids(uid: int, set_id: str) -> set[str] | None:
    """Ids of the questions in one of this user's sets, or None if not theirs."""
    row = fetch_one(
        "SELECT questions FROM question_sets WHERE id = %s AND owner_id = %s",
        (set_id, uid),
    )
    if not row:
        return None
    return {
        q["id"] for q in (row.get("questions") or [])
        if isinstance(q, dict) and isinstance(q.get("id"), str)
    }


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


# ============================================================
# Config
# ============================================================

@bp.route("/api/learning/config", methods=["GET"])
@login_required
def learning_config():
    return jsonify({"ok": True, "config": public_config()})


# ============================================================
# Per-question progress
# ============================================================

@bp.route("/api/progress/<set_id>", methods=["GET"])
@login_required
def get_progress(set_id: str):
    if not SET_ID_RE.match(set_id):
        return _error("Bad set id.")
    uid = current_user_id()
    if _set_question_ids(uid, set_id) is None:
        return _error("Not found.", 404)
    rows = fetch_all(
        "SELECT * FROM question_progress WHERE owner_id = %s AND set_id = %s",
        (uid, set_id),
    )
    progress = []
    for r in rows:
        progress.append({
            "questionId": r["question_id"],
            "flashcard": {"status": r["flashcard_status"], "updatedAt": _iso(r["flashcard_updated_at"])},
            "learn": {
                "stage": r["learn_stage"], "streak": r["learn_streak"],
                "correct": r["learn_correct"], "incorrect": r["learn_incorrect"],
                "updatedAt": _iso(r["learn_updated_at"]),
            },
            "recall": {"rating": r["recall_rating"], "updatedAt": _iso(r["recall_updated_at"])},
            "mistake": {
                "open": r["mistake_open"], "retryStreak": r["mistake_retry_streak"],
                "updatedAt": _iso(r["mistake_updated_at"]),
            },
            "review": {
                "step": r["srs_step"], "intervalDays": r["srs_interval_days"],
                "dueAt": _iso(r["srs_due_at"]), "lastReviewedAt": _iso(r["srs_last_reviewed_at"]),
                "lastOutcome": r["srs_last_outcome"],
            },
            "updatedAt": _iso(r["updated_at"]),
        })
    return jsonify({"ok": True, "setId": set_id, "progress": progress})


# ============================================================
# Attempts (append-only history)
# ============================================================

def _clean_attempt(raw: Any, index: int, valid_ids: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"attempt {index + 1} must be an object.")
    qid = raw.get("questionId")
    if not isinstance(qid, str) or not QUESTION_ID_RE.match(qid) or qid not in valid_ids:
        raise ValueError(f"attempt {index + 1} names a question that is not in this set.")
    mode = raw.get("mode")
    if mode not in STUDY_MODES:
        raise ValueError(f"attempt {index + 1} has an unknown mode.")
    outcome = raw.get("outcome")
    if outcome not in ATTEMPT_OUTCOMES:
        raise ValueError(f"attempt {index + 1} has an unknown outcome.")
    response = raw.get("response")
    if response is not None:
        if len(json.dumps(response, ensure_ascii=False).encode("utf-8")) > MAX_RESPONSE_BYTES:
            raise ValueError(f"attempt {index + 1} response is too large.")
    client_id = raw.get("clientAttemptId")
    if client_id is not None and (not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id)):
        raise ValueError(f"attempt {index + 1} has a malformed clientAttemptId.")
    return {"question_id": qid, "mode": mode, "outcome": outcome,
            "response": response, "client_attempt_id": client_id}


@bp.route("/api/progress/<set_id>/attempts", methods=["POST"])
@login_required
def record_attempts(set_id: str):
    if not SET_ID_RE.match(set_id):
        return _error("Bad set id.")
    uid = current_user_id()
    valid_ids = _set_question_ids(uid, set_id)
    if valid_ids is None:
        return _error("Not found.", 404)

    payload = request.get_json(silent=True) or {}
    raw_attempts = payload.get("attempts")
    if not isinstance(raw_attempts, list) or not raw_attempts:
        return _error("attempts must be a non-empty list.")
    if len(raw_attempts) > MAX_ATTEMPTS_PER_REQUEST:
        return _error(f"Send at most {MAX_ATTEMPTS_PER_REQUEST} attempts at a time.")
    try:
        attempts = [_clean_attempt(a, i, valid_ids) for i, a in enumerate(raw_attempts)]
    except ValueError as e:
        return _error(str(e))

    recorded = 0
    with cursor() as cur:
        for a in attempts:
            cur.execute(
                """
                INSERT INTO question_attempts
                    (owner_id, set_id, question_id, mode, outcome, response, client_attempt_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (owner_id, client_attempt_id)
                    WHERE client_attempt_id IS NOT NULL
                    DO NOTHING
                """,
                (uid, set_id, a["question_id"], a["mode"], a["outcome"],
                 Json(a["response"]) if a["response"] is not None else None,
                 a["client_attempt_id"]),
            )
            recorded += cur.rowcount
    return jsonify({"ok": True, "recorded": recorded, "duplicates": len(attempts) - recorded})


@bp.route("/api/progress/<set_id>/attempts", methods=["GET"])
@login_required
def list_attempts(set_id: str):
    if not SET_ID_RE.match(set_id):
        return _error("Bad set id.")
    uid = current_user_id()
    if _set_question_ids(uid, set_id) is None:
        return _error("Not found.", 404)

    try:
        limit = max(1, min(MAX_HISTORY_LIMIT, int(request.args.get("limit", 100))))
    except ValueError:
        return _error("limit must be a number.")
    clauses = ["owner_id = %s", "set_id = %s"]
    params: list[Any] = [uid, set_id]
    question_id = request.args.get("questionId")
    if question_id:
        if not QUESTION_ID_RE.match(question_id):
            return _error("Bad question id.")
        clauses.append("question_id = %s")
        params.append(question_id)
    mode = request.args.get("mode")
    if mode:
        if mode not in STUDY_MODES:
            return _error("Unknown mode.")
        clauses.append("mode = %s")
        params.append(mode)

    rows = fetch_all(
        "SELECT id, question_id, mode, outcome, response, created_at FROM question_attempts "
        f"WHERE {' AND '.join(clauses)} ORDER BY created_at DESC, id DESC LIMIT %s",
        (*params, limit),
    )
    return jsonify({"ok": True, "attempts": [
        {"id": r["id"], "questionId": r["question_id"], "mode": r["mode"],
         "outcome": r["outcome"], "response": r["response"], "createdAt": _iso(r["created_at"])}
        for r in rows
    ]})


# ============================================================
# Resumable study sessions (one per user, set and mode)
# ============================================================

def _session_key(set_id: str, mode: str):
    if not SET_ID_RE.match(set_id):
        return None, _error("Bad set id.")
    if mode not in STUDY_MODES:
        return None, _error("Unknown mode.")
    uid = current_user_id()
    if _set_question_ids(uid, set_id) is None:
        return None, _error("Not found.", 404)
    return uid, None


@bp.route("/api/study-sessions/<set_id>/<mode>", methods=["GET"])
@login_required
def get_study_session(set_id: str, mode: str):
    uid, err = _session_key(set_id, mode)
    if err:
        return err
    row = fetch_one(
        "SELECT state, updated_at FROM study_sessions WHERE owner_id = %s AND set_id = %s AND mode = %s",
        (uid, set_id, mode),
    )
    if not row:
        return jsonify({"ok": True, "state": None, "updatedAt": None})
    return jsonify({"ok": True, "state": row["state"], "updatedAt": _iso(row["updated_at"])})


@bp.route("/api/study-sessions/<set_id>/<mode>", methods=["PUT"])
@login_required
def put_study_session(set_id: str, mode: str):
    uid, err = _session_key(set_id, mode)
    if err:
        return err
    payload = request.get_json(silent=True) or {}
    state = payload.get("state")
    if not isinstance(state, dict):
        return _error("state must be an object.")
    if len(json.dumps(state, ensure_ascii=False).encode("utf-8")) > MAX_SESSION_STATE_BYTES:
        return _error("state is too large to save.")
    row = fetch_one(
        """
        INSERT INTO study_sessions (owner_id, set_id, mode, state)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (owner_id, set_id, mode) DO UPDATE
            SET state = EXCLUDED.state, updated_at = NOW()
        RETURNING updated_at
        """,
        (uid, set_id, mode, Json(state)),
    )
    return jsonify({"ok": True, "updatedAt": _iso(row["updated_at"]) if row else None})


@bp.route("/api/study-sessions/<set_id>/<mode>", methods=["DELETE"])
@login_required
def delete_study_session(set_id: str, mode: str):
    uid, err = _session_key(set_id, mode)
    if err:
        return err
    execute(
        "DELETE FROM study_sessions WHERE owner_id = %s AND set_id = %s AND mode = %s",
        (uid, set_id, mode),
    )
    return jsonify({"ok": True})
