"""Plan limits and usage metering helpers."""

from __future__ import annotations

from typing import Any

from db import cursor

PLAN_LIMITS: dict[str, dict[str, int]] = {
    "free": {
        "max_generations_per_month": 3,
        "max_questions_per_gen": 20,
    },
    "pro": {
        "max_generations_per_month": 50,
        "max_questions_per_gen": 100,
    },
}

DEFAULT_PLAN = "free"


def plan_limits(plan_tier: str | None) -> dict[str, int]:
    return PLAN_LIMITS.get((plan_tier or DEFAULT_PLAN).lower(), PLAN_LIMITS[DEFAULT_PLAN])


def ensure_usage_row(owner_id: int) -> None:
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO user_usage (owner_id)
            VALUES (%s)
            ON CONFLICT (owner_id) DO NOTHING
            """,
            (owner_id,),
        )


def _maybe_reset_period(cur, owner_id: int) -> None:
    cur.execute(
        """
        UPDATE user_usage
        SET ai_generations_count = 0,
            questions_generated_count = 0,
            current_period_start = NOW(),
            current_period_end = NOW() + INTERVAL '1 month'
        WHERE owner_id = %s
          AND current_period_end <= NOW()
        """,
        (owner_id,),
    )


def get_usage_row(owner_id: int) -> dict[str, Any]:
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO user_usage (owner_id)
            VALUES (%s)
            ON CONFLICT (owner_id) DO NOTHING
            """,
            (owner_id,),
        )
        _maybe_reset_period(cur, owner_id)
        cur.execute(
            """
            SELECT owner_id, ai_generations_count, questions_generated_count,
                   current_period_start, current_period_end
            FROM user_usage
            WHERE owner_id = %s
            """,
            (owner_id,),
        )
        row = cur.fetchone()
        return dict(row) if row else {
            "owner_id": owner_id,
            "ai_generations_count": 0,
            "questions_generated_count": 0,
            "current_period_start": None,
            "current_period_end": None,
        }


def increment_usage(owner_id: int, produced_questions: int) -> None:
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO user_usage (owner_id)
            VALUES (%s)
            ON CONFLICT (owner_id) DO NOTHING
            """,
            (owner_id,),
        )
        _maybe_reset_period(cur, owner_id)
        cur.execute(
            """
            UPDATE user_usage
            SET ai_generations_count = ai_generations_count + 1,
                questions_generated_count = questions_generated_count + %s
            WHERE owner_id = %s
            """,
            (max(0, int(produced_questions)), owner_id),
        )


def usage_summary(owner_id: int, plan_tier: str | None) -> dict[str, Any]:
    limits = plan_limits(plan_tier)
    row = get_usage_row(owner_id)
    used = int(row.get("ai_generations_count") or 0)
    max_gen = int(limits["max_generations_per_month"])
    remaining = max(0, max_gen - used)
    period_end = row.get("current_period_end")
    return {
        "planTier": (plan_tier or DEFAULT_PLAN).lower(),
        "generationsUsed": used,
        "generationsLimit": max_gen,
        "generationsRemaining": remaining,
        "maxQuestionsPerGeneration": int(limits["max_questions_per_gen"]),
        "periodEnd": period_end.isoformat() if period_end else None,
    }
