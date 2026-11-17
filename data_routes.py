"""User-scoped data routes.

Every route here is gated by `login_required` and filters by the current
user's id, so no client can read or mutate another user's records.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, fetch_all, fetch_one, execute
from question_ids import assign_question_ids

bp = Blueprint("data", __name__)

QSET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
MAX_SETS_PER_USER = 200
MAX_HISTORY_REVIEW_QUESTIONS = 500
MAX_HISTORY_REVIEW_BYTES = 2_000_000


def _normalize_history_review(value: Any, expected_total: int) -> dict[str, Any] | None:
    """Validate and trim the client review snapshot before storing it."""
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("questions"), list):
        raise ValueError("review must contain a questions array.")

    raw_questions = value["questions"]
    if len(raw_questions) != expected_total:
        raise ValueError("review question count must match total.")
    if len(raw_questions) > MAX_HISTORY_REVIEW_QUESTIONS:
        raise ValueError(f"review cannot exceed {MAX_HISTORY_REVIEW_QUESTIONS} questions.")

    normalized_questions: list[dict[str, Any]] = []
    for index, raw_question in enumerate(raw_questions):
        if not isinstance(raw_question, dict):
            raise ValueError(f"review question {index + 1} must be an object.")

        text = raw_question.get("text")
        choices = raw_question.get("choices")
        correct_answer = raw_question.get("answer")
        user_answer = raw_question.get("userAnswer")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"review question {index + 1} needs text.")
        if not isinstance(choices, dict) or not 2 <= len(choices) <= 20:
            raise ValueError(f"review question {index + 1} needs 2 to 20 choices.")

        clean_choices: dict[str, str] = {}
        for raw_key, raw_choice in choices.items():
            key = str(raw_key).strip()[:20]
            if not key or not isinstance(raw_choice, str):
                raise ValueError(f"review question {index + 1} contains an invalid choice.")
            clean_choices[key] = raw_choice[:10_000]

        def clean_answers(raw_answers: Any, label: str) -> list[str]:
            if not isinstance(raw_answers, list):
                raise ValueError(f"review question {index + 1} {label} must be an array.")
            answers = [str(answer).strip()[:20] for answer in raw_answers]
            if any(not answer or answer not in clean_choices for answer in answers):
                raise ValueError(f"review question {index + 1} {label} contains an unknown choice.")
            return list(dict.fromkeys(answers))

        clean_correct = clean_answers(correct_answer, "answer")
        clean_user = clean_answers(user_answer, "userAnswer")
        if not clean_correct:
            raise ValueError(f"review question {index + 1} needs a correct answer.")

        raw_descriptions = raw_question.get("answerDescriptions")
        clean_descriptions: dict[str, str] = {}
        if isinstance(raw_descriptions, dict):
            for raw_key, raw_description in raw_descriptions.items():
                key = str(raw_key).strip()[:20]
                if key in clean_choices and isinstance(raw_description, str) and raw_description.strip():
                    clean_descriptions[key] = raw_description[:20_000]

        normalized_questions.append({
            "number": index + 1,
            "text": text[:20_000],
            "choices": clean_choices,
            "answer": clean_correct,
            "userAnswer": clean_user,
            "answerDescriptions": clean_descriptions,
        })

    normalized = {"version": 1, "questions": normalized_questions}
    encoded_size = len(json.dumps(normalized, ensure_ascii=False).encode("utf-8"))
    if encoded_size > MAX_HISTORY_REVIEW_BYTES:
        raise ValueError("review details are too large to save.")
    return normalized


# ============================================================
# Question sets
# ============================================================

def _summarize(row: dict[str, Any]) -> dict[str, Any]:
    stats = row.get("stats") or {}
    source = row.get("source") or {}
    return {
        "id": row["id"],
        "title": row["title"],
        "createdAt": row["created_at"].isoformat() if row.get("created_at") else None,
        "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "questionCount": row["question_count"],
        "sourceFilename": source.get("filename"),
        "lastPlayedAt": stats.get("lastPlayedAt"),
        "bestScore": stats.get("bestScore"),
    }


def _full_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "schemaVersion": row["schema_version"],
        "ownerId": row["owner_id"],
        "title": row["title"],
        "createdAt": row["created_at"].isoformat() if row.get("created_at") else None,
        "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "source": row.get("source") or {},
        "questions": row.get("questions") or [],
        "questionCount": row["question_count"],
        "stats": row.get("stats") or {},
    }


@bp.route("/api/sets", methods=["GET"])
@login_required
def list_sets():
    uid = current_user_id()
    rows = fetch_all(
        "SELECT id, title, created_at, updated_at, question_count, source, stats "
        "FROM question_sets WHERE owner_id = %s ORDER BY updated_at DESC",
        (uid,),
    )
    return jsonify({"ok": True, "sets": [_summarize(r) for r in rows]})


@bp.route("/api/sets/<set_id>", methods=["GET"])
@login_required
def get_set(set_id: str):
    if not QSET_ID_RE.match(set_id):
        return jsonify({"ok": False, "error": "Bad set id."}), 400
    uid = current_user_id()
    row = fetch_one(
        "SELECT id, owner_id, schema_version, title, source, questions, "
        "       question_count, stats, created_at, updated_at "
        "FROM question_sets WHERE id = %s AND owner_id = %s",
        (set_id, uid),
    )
    if not row:
        return jsonify({"ok": False, "error": "Not found."}), 404

    # Sets saved before question ids existed get them once, on first read.
    # updated_at is left alone: the content did not change.
    questions, changed = assign_question_ids(row.get("questions") or [])
    if changed:
        execute(
            "UPDATE question_sets SET questions = %s WHERE id = %s AND owner_id = %s",
            (Json(questions), set_id, uid),
        )
        row = {**row, "questions": questions}
    return jsonify({"ok": True, "set": _full_record(row)})


@bp.route("/api/sets", methods=["POST"])
@login_required
def upsert_set():
    uid = current_user_id()
    payload = request.get_json(silent=True) or {}

    set_id = payload.get("id") or _new_set_id()
    if not QSET_ID_RE.match(set_id):
        return jsonify({"ok": False, "error": "Bad set id."}), 400

    title = (payload.get("title") or "Untitled set").strip()[:200]
    source = payload.get("source") or {}
    questions = payload.get("questions") or []
    if not isinstance(questions, list) or not questions:
        return jsonify({"ok": False, "error": "questions must be a non-empty list."}), 400
    questions, _ = assign_question_ids(questions)

    stats = payload.get("stats") or {
        "sessionsRun": 0,
        "lastPlayedAt": None,
        "bestScore": None,
        "averageScore": None,
    }

    # Enforce a per-user cap so a runaway script can't fill the DB.
    count = fetch_one(
        "SELECT COUNT(*) AS n FROM question_sets WHERE owner_id = %s", (uid,)
    )
    if count and count["n"] >= MAX_SETS_PER_USER:
        existing = fetch_one(
            "SELECT id FROM question_sets WHERE id = %s AND owner_id = %s",
            (set_id, uid),
        )
        if not existing:
            return jsonify({
                "ok": False,
                "error": f"Per-user limit of {MAX_SETS_PER_USER} saved sets reached."
            }), 409

    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO question_sets (id, owner_id, title, source, questions,
                                       question_count, stats)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                source = EXCLUDED.source,
                questions = EXCLUDED.questions,
                question_count = EXCLUDED.question_count,
                stats = EXCLUDED.stats,
                updated_at = NOW()
            WHERE question_sets.owner_id = %s
            RETURNING id, owner_id, schema_version, title, source, questions,
                      question_count, stats, created_at, updated_at
            """,
            (
                set_id, uid, title, Json(source), Json(questions),
                len(questions), Json(stats), uid,
            ),
        )
        row = cur.fetchone()
        if not row:
            return jsonify({"ok": False, "error": "Save conflicted with another owner."}), 403
        return jsonify({"ok": True, "set": _full_record(dict(row))})


@bp.route("/api/sets/<set_id>", methods=["DELETE"])
@login_required
def delete_set(set_id: str):
    if not QSET_ID_RE.match(set_id):
        return jsonify({"ok": False, "error": "Bad set id."}), 400
    uid = current_user_id()
    n = execute(
        "DELETE FROM question_sets WHERE id = %s AND owner_id = %s",
        (set_id, uid),
    )
    if not n:
        return jsonify({"ok": False, "error": "Not found."}), 404
    return jsonify({"ok": True})


@bp.route("/api/sets/<set_id>/stats", methods=["POST"])
@login_required
def update_set_stats(set_id: str):
    if not QSET_ID_RE.match(set_id):
        return jsonify({"ok": False, "error": "Bad set id."}), 400
    uid = current_user_id()
    payload = request.get_json(silent=True) or {}
    score = payload.get("score")
    if not isinstance(score, (int, float)) or not (0 <= score <= 100):
        return jsonify({"ok": False, "error": "score must be 0..100."}), 400

    row = fetch_one(
        "SELECT stats FROM question_sets WHERE id = %s AND owner_id = %s",
        (set_id, uid),
    )
    if not row:
        return jsonify({"ok": False, "error": "Not found."}), 404

    stats = row["stats"] or {}
    sessions_run = int(stats.get("sessionsRun") or 0) + 1
    prev_best = stats.get("bestScore")
    new_best = score if prev_best is None else max(prev_best, score)
    prev_avg = stats.get("averageScore")
    new_avg = (
        score if prev_avg is None
        else round(((prev_avg * (sessions_run - 1)) + score) / sessions_run)
    )
    stats.update({
        "sessionsRun": sessions_run,
        "lastPlayedAt": _now_iso(),
        "bestScore": new_best,
        "averageScore": new_avg,
    })

    execute(
        "UPDATE question_sets SET stats = %s, updated_at = NOW() "
        "WHERE id = %s AND owner_id = %s",
        (Json(stats), set_id, uid),
    )
    return jsonify({"ok": True, "stats": stats})


# ============================================================
# Active set pointer
# ============================================================

@bp.route("/api/active-set", methods=["GET"])
@login_required
def get_active_set():
    uid = current_user_id()
    row = fetch_one("SELECT set_id FROM user_active_set WHERE owner_id = %s", (uid,))
    return jsonify({"ok": True, "activeId": row["set_id"] if row else None})


@bp.route("/api/active-set", methods=["PUT"])
@login_required
def put_active_set():
    uid = current_user_id()
    payload = request.get_json(silent=True) or {}
    set_id = payload.get("activeId")
    if set_id is not None:
        if not QSET_ID_RE.match(set_id):
            return jsonify({"ok": False, "error": "Bad set id."}), 400
        # Verify it belongs to this user.
        existing = fetch_one(
            "SELECT id FROM question_sets WHERE id = %s AND owner_id = %s",
            (set_id, uid),
        )
        if not existing:
            return jsonify({"ok": False, "error": "Set does not belong to this user."}), 403

    execute(
        "INSERT INTO user_active_set (owner_id, set_id) VALUES (%s, %s) "
        "ON CONFLICT (owner_id) DO UPDATE SET set_id = EXCLUDED.set_id, updated_at = NOW()",
        (uid, set_id),
    )
    return jsonify({"ok": True, "activeId": set_id})


# ============================================================
# Session history
# ============================================================

@bp.route("/api/history", methods=["GET"])
@login_required
def list_history():
    uid = current_user_id()
    rows = fetch_all(
        "SELECT history.id, history.set_id, "
        "       COALESCE(history.set_title, sets.title) AS set_title, "
        "       history.mode, history.score, history.correct_count, "
        "       history.total_count, history.finished_at, "
        "       (history.review_data IS NOT NULL) AS has_details "
        "FROM session_history AS history "
        "LEFT JOIN question_sets AS sets "
        "  ON sets.id = history.set_id AND sets.owner_id = history.owner_id "
        "WHERE history.owner_id = %s "
        "ORDER BY history.finished_at DESC LIMIT 100",
        (uid,),
    )
    return jsonify({
        "ok": True,
        "history": [
            {
                "id": r["id"],
                "setId": r["set_id"],
                "setTitle": r["set_title"],
                "mode": r["mode"],
                "score": r["score"],
                "correct": r["correct_count"],
                "total": r["total_count"],
                "date": r["finished_at"].isoformat() if r["finished_at"] else None,
                "hasDetails": bool(r["has_details"]),
            }
            for r in rows
        ],
    })


@bp.route("/api/history", methods=["POST"])
@login_required
def append_history():
    uid = current_user_id()
    payload = request.get_json(silent=True) or {}
    mode = (payload.get("mode") or "").strip()
    if mode not in ("Exam", "Training"):
        return jsonify({"ok": False, "error": "mode must be 'Exam' or 'Training'."}), 400
    score = payload.get("score")
    correct = payload.get("correct")
    total = payload.get("total")
    set_id = payload.get("setId")
    if not all(isinstance(v, (int, float)) for v in (score, correct, total)):
        return jsonify({"ok": False, "error": "score/correct/total must be numbers."}), 400
    if set_id is not None and not QSET_ID_RE.match(set_id):
        return jsonify({"ok": False, "error": "Bad set id."}), 400

    set_title = None
    if set_id is not None:
        owned_set = fetch_one(
            "SELECT title FROM question_sets WHERE id = %s AND owner_id = %s",
            (set_id, uid),
        )
        if not owned_set:
            return jsonify({"ok": False, "error": "Set does not belong to this user."}), 403
        set_title = owned_set["title"]
    else:
        raw_title = payload.get("setTitle")
        supplied_title = raw_title.strip() if isinstance(raw_title, str) else "Default question set"
        set_title = supplied_title[:200] or "Default question set"

    score_int = int(score)
    correct_int = int(correct)
    total_int = int(total)
    if not 0 <= score_int <= 100 or total_int < 0 or not 0 <= correct_int <= total_int:
        return jsonify({"ok": False, "error": "Invalid score totals."}), 400

    try:
        review = _normalize_history_review(payload.get("review"), total_int)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    row = fetch_one(
        "INSERT INTO session_history "
        "(owner_id, set_id, set_title, mode, score, correct_count, total_count, review_data) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
        "RETURNING id, finished_at",
        (uid, set_id, set_title, mode, score_int, correct_int, total_int,
         Json(review) if review is not None else None),
    )
    return jsonify({
        "ok": True,
        "entry": {
            "id": row["id"],
            "setId": set_id,
            "setTitle": set_title,
            "date": row["finished_at"].isoformat(),
            "hasDetails": review is not None,
        },
    })


@bp.route("/api/history/<int:history_id>", methods=["GET"])
@login_required
def get_history_details(history_id: int):
    uid = current_user_id()
    row = fetch_one(
        "SELECT id, set_id, set_title, mode, score, correct_count, total_count, "
        "       finished_at, review_data "
        "FROM session_history WHERE id = %s AND owner_id = %s",
        (history_id, uid),
    )
    if not row:
        return jsonify({"ok": False, "error": "Session history entry not found."}), 404

    return jsonify({
        "ok": True,
        "entry": {
            "id": row["id"],
            "setId": row["set_id"],
            "setTitle": row["set_title"],
            "mode": row["mode"],
            "score": row["score"],
            "correct": row["correct_count"],
            "total": row["total_count"],
            "date": row["finished_at"].isoformat() if row["finished_at"] else None,
            "review": row["review_data"],
        },
    })


@bp.route("/api/history", methods=["DELETE"])
@login_required
def clear_history():
    uid = current_user_id()
    execute("DELETE FROM session_history WHERE owner_id = %s", (uid,))
    return jsonify({"ok": True})


# ============================================================
# Active (in-progress) session — mirrors the old examSessionData
# ============================================================

@bp.route("/api/active-session", methods=["GET"])
@login_required
def get_active_session():
    uid = current_user_id()
    row = fetch_one(
        "SELECT state, updated_at FROM active_sessions WHERE owner_id = %s",
        (uid,),
    )
    if not row:
        return jsonify({"ok": True, "state": None})
    return jsonify({
        "ok": True,
        "state": row["state"],
        "updatedAt": row["updated_at"].isoformat() if row["updated_at"] else None,
    })


@bp.route("/api/active-session", methods=["PUT"])
@login_required
def put_active_session():
    uid = current_user_id()
    payload = request.get_json(silent=True) or {}
    state = payload.get("state")
    if not isinstance(state, dict):
        return jsonify({"ok": False, "error": "state must be an object."}), 400
    execute(
        "INSERT INTO active_sessions (owner_id, state) VALUES (%s, %s) "
        "ON CONFLICT (owner_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()",
        (uid, Json(state)),
    )
    return jsonify({"ok": True})


@bp.route("/api/active-session", methods=["DELETE"])
@login_required
def clear_active_session():
    uid = current_user_id()
    execute("DELETE FROM active_sessions WHERE owner_id = %s", (uid,))
    return jsonify({"ok": True})


# ============================================================
# Helpers
# ============================================================

def _new_set_id() -> str:
    # qs_<base36 ts>_<short random>
    import random, string
    ts = format(int(time.time() * 1000), "x")
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"qs_{ts}_{rand}"


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
