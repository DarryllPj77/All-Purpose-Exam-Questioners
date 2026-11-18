"""Smart Review API: spaced repetition (Phase 7).

Routes (login_required, filtered by the signed-in user):
  GET  /api/review/overview?setId=&tzOffset=   → due, overdue, upcoming, history
  POST /api/review/<set_id>/<question_id>/answer → grade a review, reschedule

Scheduling (learning_config.SRS; initial defaults, not proven-optimal):
* Correct:  one step further along SRS["intervals_days"] (1, 3, 7, 14, 30
            days), then the previous interval x growth_after_last, capped at
            max_interval_days.
* Partial:  repeat the current interval (step unchanged).
* Incorrect: back to the first step (1 day).
Reviews fall due at local midnight of the target day, so "due today" and
"overdue" follow the learner's clock. The browser sends its UTC offset
(Date.getTimezoneOffset(), minutes); nothing depends on a timezone database.

Integration without conflicting states:
* Only Smart Review answers change the schedule (srs_* columns).
* A question joins the schedule, due immediately, once it has any answer in
  another mode (it has been studied).
* An incorrect answer elsewhere after the last review makes the question due
  now; its step and interval are left for the next review to decide.
Every review is logged to the answer log with mode "review".
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from flask import Blueprint, jsonify, request
from psycopg2.extras import Json

from auth import current_user_id, login_required
from db import cursor, fetch_all, fetch_one
from learning_config import SRS
from mistakes_routes import is_correct
from question_ids import QUESTION_ID_RE

bp = Blueprint("review", __name__)

SET_ID_RE = re.compile(r"^qs_[A-Za-z0-9_-]{1,64}$")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_TZ_OFFSET = 14 * 60
HISTORY_DAYS = 14
UPCOMING_DAYS = 7


# ---- Pure scheduling helpers (unit-tested) -----------------------------------

def next_schedule(outcome: str, step: int, interval: int | None) -> tuple[int, int]:
    """(step, interval_days) after a review outcome."""
    steps = SRS["intervals_days"]
    if outcome == "correct":
        step += 1
        if step <= len(steps):
            return step, steps[step - 1]
        previous = interval or steps[-1]
        return step, min(int(round(previous * SRS["growth_after_last"])), SRS["max_interval_days"])
    if outcome == "partial":
        return step, interval or steps[0]
    return 0, steps[0]


def local_today(now_utc: datetime, tz_offset: int) -> date:
    """The learner's calendar date. tz_offset = UTC minus local, in minutes."""
    return (now_utc - timedelta(minutes=tz_offset)).date()


def local_midnight_utc(day: date, tz_offset: int) -> datetime:
    """UTC instant of local midnight at the start of `day`."""
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(minutes=tz_offset)


def due_at_for(now_utc: datetime, tz_offset: int, interval_days: int) -> datetime:
    return local_midnight_utc(local_today(now_utc, tz_offset) + timedelta(days=interval_days), tz_offset)


def maturity(interval: int | None) -> str:
    if not interval or interval < 7:
        return "learning"
    if interval < 21:
        return "young"
    return "mature"


# ---- Request helpers -----------------------------------------------------------

def _error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message}), status


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _tz_offset(raw: Any) -> int | None:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if -MAX_TZ_OFFSET <= value <= MAX_TZ_OFFSET else None


def _code_fields(q: dict[str, Any]) -> dict[str, Any]:
    """Optional code-challenge fields, passed through when present."""
    out: dict[str, Any] = {}
    for key in ("code", "language", "challenge", "expectedOutput"):
        if isinstance(q.get(key), str) and q.get(key):
            out[key] = q[key]
    return out


def _public_question(q: dict[str, Any]) -> dict[str, Any]:
    answers = q.get("answer")
    answers = [str(a) for a in (answers if isinstance(answers, list) else [answers])]
    return {
        "id": q.get("id"), "text": q.get("text") or "", "choices": q.get("choices") or {},
        "answer": answers, "answerDescriptions": q.get("answerDescriptions") or {},
        "maxSelections": q.get("maxSelections") or max(1, len(answers)),
        **_code_fields(q),
    }


def _sync_schedule(uid: int, set_id: str | None) -> None:
    """Enrol studied questions and pull forward ones missed elsewhere."""
    set_clause_a = "AND a.set_id = %s" if set_id else ""
    set_clause_p = "AND p.set_id = %s" if set_id else ""
    params: list[Any] = [uid] + ([set_id] if set_id else [])
    with cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO question_progress (owner_id, set_id, question_id, srs_due_at)
            SELECT DISTINCT a.owner_id, a.set_id, a.question_id, NOW()
            FROM question_attempts AS a
            WHERE a.owner_id = %s {set_clause_a} AND a.mode <> 'review'
            ON CONFLICT (owner_id, set_id, question_id) DO UPDATE
                SET srs_due_at = NOW(), updated_at = NOW()
                WHERE question_progress.srs_due_at IS NULL
                  AND question_progress.srs_last_reviewed_at IS NULL
            """,
            params,
        )
        cur.execute(
            f"""
            UPDATE question_progress AS p SET srs_due_at = NOW(), updated_at = NOW()
            WHERE p.owner_id = %s {set_clause_p}
              AND p.srs_last_reviewed_at IS NOT NULL AND p.srs_due_at > NOW()
              AND EXISTS (
                SELECT 1 FROM question_attempts AS a
                WHERE a.owner_id = p.owner_id AND a.set_id = p.set_id AND a.question_id = p.question_id
                  AND a.mode <> 'review' AND a.outcome = 'incorrect'
                  AND a.created_at > p.srs_last_reviewed_at)
            """,
            params,
        )


# ---- Overview ------------------------------------------------------------------

@bp.route("/api/review/overview", methods=["GET"])
@login_required
def overview():
    uid = current_user_id()
    tz_offset = _tz_offset(request.args.get("tzOffset", 0))
    if tz_offset is None:
        return _error("tzOffset must be minutes between -840 and 840.")
    set_id = request.args.get("setId") or None
    if set_id:
        if not SET_ID_RE.match(set_id):
            return _error("Bad set id.")
        if not fetch_one("SELECT 1 AS ok FROM question_sets WHERE id = %s AND owner_id = %s", (set_id, uid)):
            return _error("Not found.", 404)

    _sync_schedule(uid, None)  # all sets, so the set filter counts stay current

    now = datetime.now(timezone.utc)
    today = local_today(now, tz_offset)
    start_today = local_midnight_utc(today, tz_offset)
    end_today = start_today + timedelta(days=1)

    set_rows = fetch_all("SELECT id, title, questions FROM question_sets WHERE owner_id = %s ORDER BY title", (uid,))
    sets = {r["id"]: {"title": r["title"],
                      "questions": {q["id"]: q for q in (r["questions"] or [])
                                    if isinstance(q, dict) and isinstance(q.get("id"), str)}}
            for r in set_rows}

    rows = fetch_all(
        "SELECT set_id, question_id, srs_step, srs_interval_days, srs_due_at, srs_last_reviewed_at, srs_last_outcome "
        "FROM question_progress WHERE owner_id = %s AND srs_due_at IS NOT NULL",
        (uid,),
    )
    per_set_due = Counter()
    scheduled = []
    for r in rows:
        info = sets.get(r["set_id"])
        q = info["questions"].get(r["question_id"]) if info else None
        if not q:
            continue  # question edited or removed; its history is kept
        if r["srs_due_at"] < end_today:
            per_set_due[r["set_id"]] += 1
        if set_id and r["set_id"] != set_id:
            continue
        scheduled.append((r, info, q))

    overdue = due_today = 0
    upcoming = Counter()
    mastery = Counter()
    due_items = []
    for r, info, q in scheduled:
        mastery[maturity(r["srs_interval_days"])] += 1
        due = r["srs_due_at"]
        if due < start_today:
            overdue += 1
        elif due < end_today:
            due_today += 1
        else:
            day = local_today(due, tz_offset)
            if (day - today).days <= UPCOMING_DAYS:
                upcoming[day.isoformat()] += 1
        if due < end_today:
            due_items.append({
                "setId": r["set_id"], "setTitle": info["title"], "questionId": r["question_id"],
                "dueAt": _iso(due), "overdue": due < start_today,
                "step": r["srs_step"], "intervalDays": r["srs_interval_days"],
                "lastOutcome": r["srs_last_outcome"], "lastReviewedAt": _iso(r["srs_last_reviewed_at"]),
                "question": _public_question(q),
            })
    due_items.sort(key=lambda i: i["dueAt"])

    total_questions = sum(len(s["questions"]) for sid, s in sets.items() if not set_id or sid == set_id)
    mastery["notStarted"] = max(0, total_questions - len(scheduled))

    hist_params: list[Any] = [uid, start_today - timedelta(days=HISTORY_DAYS - 1)]
    hist_set = ""
    if set_id:
        hist_set = "AND set_id = %s"
        hist_params.append(set_id)
    history_rows = fetch_all(
        f"SELECT created_at, outcome FROM question_attempts WHERE owner_id = %s AND mode = 'review' "
        f"AND created_at >= %s {hist_set}",
        hist_params,
    )
    by_day: dict[str, Counter] = {}
    for h in history_rows:
        key = local_today(h["created_at"], tz_offset).isoformat()
        by_day.setdefault(key, Counter())[h["outcome"]] += 1
    history = []
    for i in range(HISTORY_DAYS - 1, -1, -1):
        day = (today - timedelta(days=i)).isoformat()
        c = by_day.get(day, Counter())
        history.append({"date": day, "reviews": sum(c.values()), "correct": c.get("correct", 0),
                        "partial": c.get("partial", 0), "incorrect": c.get("incorrect", 0)})
    reviewed_today = history[-1]

    return jsonify({
        "ok": True,
        "today": today.isoformat(),
        "counts": {
            "overdue": overdue, "dueToday": due_today, "due": overdue + due_today,
            "scheduled": len(scheduled), "reviewedToday": reviewed_today["reviews"],
            "correctToday": reviewed_today["correct"],
        },
        "upcoming": [{"date": (today + timedelta(days=d)).isoformat(),
                      "count": upcoming.get((today + timedelta(days=d)).isoformat(), 0)}
                     for d in range(1, UPCOMING_DAYS + 1)],
        "mastery": {k: mastery.get(k, 0) for k in ("notStarted", "learning", "young", "mature")},
        "history": history,
        "dueItems": due_items,
        "sets": [{"setId": sid, "title": s["title"], "due": per_set_due.get(sid, 0)} for sid, s in sets.items()],
        "intervalsDays": SRS["intervals_days"],
    })


# ---- Answer --------------------------------------------------------------------

@bp.route("/api/review/<set_id>/<question_id>/answer", methods=["POST"])
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
    tz_offset = _tz_offset(payload.get("tzOffset", 0))
    if tz_offset is None:
        return _error("tzOffset must be minutes between -840 and 840.")
    fmt = payload.get("format")
    if fmt == "choice":
        selected = payload.get("selected")
        choices = question.get("choices") or {}
        if not isinstance(selected, list) or not selected or len(selected) > 20:
            return _error("selected must be a non-empty list of choice keys.")
        selected = [str(s) for s in selected]
        if any(s not in choices for s in selected):
            return _error("selected contains an unknown choice.")
        outcome = "correct" if is_correct(question, selected) else "incorrect"
        response = {"format": fmt, "selected": selected}
    elif fmt == "recall":
        outcome = payload.get("rating")
        if outcome not in ("incorrect", "partial", "correct"):
            return _error("rating must be 'incorrect', 'partial' or 'correct'.")
        response = {"format": fmt, "rating": outcome, "selfAssessed": True}
    else:
        return _error("format must be 'choice' or 'recall'.")
    client_id = payload.get("clientAttemptId")
    if client_id is not None and (not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id)):
        return _error("Malformed clientAttemptId.")

    now = datetime.now(timezone.utc)
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO question_attempts
                (owner_id, set_id, question_id, mode, outcome, response, client_attempt_id)
            VALUES (%s, %s, %s, 'review', %s, %s, %s)
            ON CONFLICT (owner_id, client_attempt_id) WHERE client_attempt_id IS NOT NULL DO NOTHING
            """,
            (uid, set_id, question_id, outcome, Json(response), client_id),
        )
        duplicate = cur.rowcount == 0
        cur.execute(
            "SELECT srs_step, srs_interval_days, srs_due_at FROM question_progress "
            "WHERE owner_id = %s AND set_id = %s AND question_id = %s FOR UPDATE",
            (uid, set_id, question_id),
        )
        row = cur.fetchone()
        step = (row and row["srs_step"]) or 0
        interval = row and row["srs_interval_days"]
        due_at = row and row["srs_due_at"]
        if not duplicate:
            step, interval = next_schedule(outcome, step, interval)
            due_at = due_at_for(now, tz_offset, interval)
            cur.execute(
                """
                INSERT INTO question_progress
                    (owner_id, set_id, question_id, srs_step, srs_interval_days, srs_due_at,
                     srs_last_reviewed_at, srs_last_outcome)
                VALUES (%s, %s, %s, %s, %s, %s, NOW(), %s)
                ON CONFLICT (owner_id, set_id, question_id) DO UPDATE SET
                    srs_step = EXCLUDED.srs_step,
                    srs_interval_days = EXCLUDED.srs_interval_days,
                    srs_due_at = EXCLUDED.srs_due_at,
                    srs_last_reviewed_at = NOW(),
                    srs_last_outcome = EXCLUDED.srs_last_outcome,
                    updated_at = NOW()
                """,
                (uid, set_id, question_id, step, interval, due_at, outcome),
            )

    answers = question.get("answer")
    return jsonify({
        "ok": True, "duplicate": duplicate, "outcome": outcome,
        "correctAnswer": [str(a) for a in (answers if isinstance(answers, list) else [answers])],
        "step": step, "intervalDays": interval, "dueAt": _iso(due_at),
        "maturity": maturity(interval),
    })
