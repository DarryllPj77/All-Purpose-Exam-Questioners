"""Unified progress dashboard (Phase 10).

Route (login_required, filtered by the signed-in user):
  GET /api/dashboard?tzOffset=<minutes> → everything the dashboard shows

Each mode keeps its own measurement, and this endpoint reports them side by
side without merging them into one number:

* Answers (the answer log): questions studied, graded answers and accuracy.
  Accuracy counts only answers the app graded (correct / incorrect /
  partial). Self-ratings (Active recall, and the recall formats in Learn and
  Smart review), flashcard reveals and skipped questions are not graded.
* Flashcards: the learner's own Know / Still learning labels.
* Learn: mastery stages from consecutive correct answers.
* Mistake review: open and resolved items (reconciled first, as on that page).
* Smart review: due by the end of the learner's day, scheduled, mature
  (reconciled first, as on that page).

Only questions that still exist in a set are counted; history of edited or
removed questions is kept but left out of these figures. Nothing here is
estimated: every number is a count of stored records.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from flask import Blueprint, jsonify, request

from auth import current_user_id, login_required
from db import fetch_all, fetch_one
from learning_config import LEARN_MASTERY, MISTAKES
from mistakes_routes import _reconcile as reconcile_mistakes
from review_routes import _sync_schedule as sync_review_schedule
from review_routes import _tz_offset, local_midnight_utc, local_today

bp = Blueprint("dashboard", __name__)

ACTIVITY_DAYS = 14
PRACTICE_HISTORY = 10
CONTINUE_LIMIT = 4
MATURE_DAYS = 21
GRADED_OUTCOMES = ("correct", "incorrect", "partial")
# Study views a "continue" link can open; exam and training have their own
# "Continue session" button on the dashboard.
CONTINUE_MODES = ("flashcards", "learn", "recall", "practice", "matching", "code", "mistakes", "review")

# SQL fragment: true when an answer was self-assessed rather than graded.
SELF_ASSESSED = (
    "(a.mode = 'recall' OR a.mode = 'flashcards' "
    "OR COALESCE(a.response->>'format', '') = 'recall' "
    "OR COALESCE(a.response->>'selfAssessed', '') = 'true')"
)


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _pass_percent(config: Any) -> int | None:
    value = config.get("passPercent") if isinstance(config, dict) else None
    return value if isinstance(value, int) and 1 <= value <= 100 else None


def _latest(*values: Any) -> Any:
    present = [v for v in values if v is not None]
    return max(present) if present else None


@bp.route("/api/dashboard", methods=["GET"])
@login_required
def dashboard():
    uid = current_user_id()
    tz_offset = _tz_offset(request.args.get("tzOffset", 0))
    if tz_offset is None:
        return jsonify({"ok": False, "error": "tzOffset must be minutes between -840 and 840."}), 400

    # Same reconciliation the Mistake review and Smart review pages run, so
    # the dashboard never disagrees with them.
    reconcile_mistakes(uid, None)
    sync_review_schedule(uid, None)

    now = datetime.now(timezone.utc)
    today = local_today(now, tz_offset)
    start_today = local_midnight_utc(today, tz_offset)
    end_today = start_today + timedelta(days=1)
    activity_start = start_today - timedelta(days=ACTIVITY_DAYS - 1)

    set_rows = fetch_all(
        "SELECT id, title, questions, created_at, updated_at FROM question_sets WHERE owner_id = %s",
        (uid,),
    )
    sets: dict[str, dict[str, Any]] = {}
    for r in set_rows:
        ids = {q["id"] for q in (r["questions"] or []) if isinstance(q, dict) and isinstance(q.get("id"), str)}
        sets[r["id"]] = {
            "setId": r["id"], "title": r["title"], "ids": ids,
            "createdAt": r["created_at"], "updatedAt": r["updated_at"], "lastStudiedAt": None,
        }

    # ---- Answer log: studied questions, graded answers, last activity ----
    attempt_rows = fetch_all(
        f"""
        SELECT a.set_id, a.question_id, a.mode,
               COUNT(*) FILTER (WHERE a.outcome IN %s AND NOT {SELF_ASSESSED}) AS graded,
               COUNT(*) FILTER (WHERE a.outcome = 'correct' AND NOT {SELF_ASSESSED}) AS correct,
               MAX(a.created_at) AS last_at
        FROM question_attempts AS a
        WHERE a.owner_id = %s
        GROUP BY a.set_id, a.question_id, a.mode
        """,
        (GRADED_OUTCOMES, uid),
    )
    studied: dict[str, set[str]] = {sid: set() for sid in sets}
    graded = Counter()
    correct = Counter()
    mode_last: dict[tuple[str, str], Any] = {}
    for r in attempt_rows:
        info = sets.get(r["set_id"])
        if not info:
            continue
        info["lastStudiedAt"] = _latest(info["lastStudiedAt"], r["last_at"])
        key = (r["set_id"], r["mode"])
        mode_last[key] = _latest(mode_last.get(key), r["last_at"])
        if r["question_id"] not in info["ids"]:
            continue
        studied[r["set_id"]].add(r["question_id"])
        graded[r["set_id"]] += r["graded"]
        correct[r["set_id"]] += r["correct"]

    for r in fetch_all("SELECT set_id, mode, updated_at FROM study_sessions WHERE owner_id = %s", (uid,)):
        if r["set_id"] in sets:
            sets[r["set_id"]]["lastStudiedAt"] = _latest(sets[r["set_id"]]["lastStudiedAt"], r["updated_at"])
            key = (r["set_id"], r["mode"])
            mode_last[key] = _latest(mode_last.get(key), r["updated_at"])

    # ---- Per-question progress: flashcards, learn, mistakes, review ----
    progress_rows = fetch_all(
        """
        SELECT set_id, question_id, flashcard_status, learn_stage, mistake_open, mistake_updated_at,
               srs_due_at, srs_interval_days
        FROM question_progress WHERE owner_id = %s
        """,
        (uid,),
    )
    per: dict[str, Counter] = {sid: Counter() for sid in sets}
    for r in progress_rows:
        info = sets.get(r["set_id"])
        if not info or r["question_id"] not in info["ids"]:
            continue
        c = per[r["set_id"]]
        if r["flashcard_status"] in ("know", "learning"):
            c["fc_" + r["flashcard_status"]] += 1
        if r["learn_stage"] in ("learning", "familiar", "mastered"):
            c["ln_" + r["learn_stage"]] += 1
        if r["mistake_open"]:
            c["mistakes_open"] += 1
        elif r["mistake_updated_at"] is not None:
            c["mistakes_resolved"] += 1
        if r["srs_due_at"] is not None:
            c["srs_scheduled"] += 1
            if r["srs_due_at"] < end_today:
                c["srs_due"] += 1
            if (r["srs_interval_days"] or 0) >= MATURE_DAYS:
                c["srs_mature"] += 1

    set_list = []
    for sid, info in sets.items():
        c = per[sid]
        total = len(info["ids"])
        set_list.append({
            "setId": sid,
            "title": info["title"],
            "questions": total,
            "lastStudiedAt": _iso(info["lastStudiedAt"]),
            "addedAt": _iso(info["createdAt"]),
            "answers": {
                "studied": len(studied[sid]),
                "graded": graded[sid],
                "correct": correct[sid],
                "accuracy": round(correct[sid] * 100 / graded[sid]) if graded[sid] else None,
            },
            "flashcards": {"know": c["fc_know"], "learning": c["fc_learning"],
                           "unmarked": max(0, total - c["fc_know"] - c["fc_learning"])},
            "learn": {"mastered": c["ln_mastered"], "familiar": c["ln_familiar"], "learning": c["ln_learning"],
                      "new": max(0, total - c["ln_mastered"] - c["ln_familiar"] - c["ln_learning"])},
            "mistakes": {"open": c["mistakes_open"], "resolved": c["mistakes_resolved"]},
            "review": {"due": c["srs_due"], "scheduled": c["srs_scheduled"], "mature": c["srs_mature"]},
        })
    # Most recently studied first; never-studied sets after, newest first.
    set_list.sort(key=lambda s: (s["lastStudiedAt"] is not None, s["lastStudiedAt"] or "", s["addedAt"] or ""),
                  reverse=True)

    # ---- Continue studying: the latest (set, mode) pairs ----
    pairs = [(when, sid, mode) for (sid, mode), when in mode_last.items() if mode in CONTINUE_MODES and when]
    pairs.sort(reverse=True)
    seen = set()
    continue_items = []
    for when, sid, mode in pairs:
        # Mistake review and Smart review span every set: one entry each.
        key = mode if mode in ("mistakes", "review") else (sid, mode)
        if key in seen:
            continue
        seen.add(key)
        continue_items.append({"mode": mode, "setId": sid, "setTitle": sets[sid]["title"], "at": _iso(when)})
        if len(continue_items) >= CONTINUE_LIMIT:
            break

    # ---- Activity: answers per local day (all modes) and graded accuracy ----
    day_rows = fetch_all(
        f"""
        SELECT a.created_at, a.outcome, ({SELF_ASSESSED}) AS self_assessed
        FROM question_attempts AS a
        WHERE a.owner_id = %s AND a.created_at >= %s
        """,
        (uid, activity_start),
    )
    by_day: dict[str, Counter] = {}
    for r in day_rows:
        key = local_today(r["created_at"], tz_offset).isoformat()
        c = by_day.setdefault(key, Counter())
        c["answers"] += 1
        if r["outcome"] in GRADED_OUTCOMES and not r["self_assessed"]:
            c["graded"] += 1
            if r["outcome"] == "correct":
                c["correct"] += 1
    activity = []
    for i in range(ACTIVITY_DAYS - 1, -1, -1):
        day = (today - timedelta(days=i)).isoformat()
        c = by_day.get(day, Counter())
        activity.append({"date": day, "answers": c["answers"], "graded": c["graded"], "correct": c["correct"]})

    # ---- Practice test history (oldest first, for a left-to-right chart) ----
    practice_rows = fetch_all(
        "SELECT id, set_title, score, correct_count, total_count, finished_at, config FROM session_history "
        "WHERE owner_id = %s AND mode = 'Practice' ORDER BY finished_at DESC LIMIT %s",
        (uid, PRACTICE_HISTORY),
    )
    practice_total = fetch_one(
        "SELECT COUNT(*) AS n FROM session_history WHERE owner_id = %s AND mode = 'Practice'", (uid,)
    )["n"]
    practice = [{"id": r["id"], "setTitle": r["set_title"], "score": r["score"], "correct": r["correct_count"],
                 "total": r["total_count"], "finishedAt": _iso(r["finished_at"]),
                 "passPercent": _pass_percent(r["config"])} for r in reversed(practice_rows)]

    total_graded = sum(graded.values())
    totals = {
        "sets": len(sets),
        "questions": sum(s["questions"] for s in set_list),
        "studied": sum(s["answers"]["studied"] for s in set_list),
        "graded": total_graded,
        "accuracy": round(sum(correct.values()) * 100 / total_graded) if total_graded else None,
        "mastered": sum(s["learn"]["mastered"] for s in set_list),
        "needsAttention": sum(s["mistakes"]["open"] for s in set_list),
        "reviewDue": sum(s["review"]["due"] for s in set_list),
    }

    return jsonify({
        "ok": True,
        "today": today.isoformat(),
        "totals": totals,
        "sets": set_list,
        "continue": continue_items,
        "activity": activity,
        "practice": {"recent": practice, "count": practice_total},
        "rules": {
            "masteredStreak": LEARN_MASTERY["correct_streak_for_mastered"],
            "retriesToResolve": MISTAKES["correct_retries_to_resolve"],
            "matureDays": MATURE_DAYS,
        },
    })
