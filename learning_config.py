"""Shared learning rules: one place for every threshold and interval.

Each study mode keeps its own measurement (see docs/learning-platform.md):
quiz attempts, flashcard familiarity, Learn mastery, mistake status and
spaced-repetition scheduling are related but never the same number.

Values here are initial defaults, not proven-optimal settings. The browser
reads them through GET /api/learning/config, so nothing is duplicated in JS.
"""

from __future__ import annotations

from typing import Any

# Every mode that can write a question attempt.
STUDY_MODES: tuple[str, ...] = (
    "exam",
    "training",
    "flashcards",
    "learn",
    "practice",
    "mistakes",
    "matching",
    "recall",
    "code",
    "review",
)

# Outcomes an attempt can record. "revealed" = the learner looked at the
# answer without committing one (flashcards, active recall).
ATTEMPT_OUTCOMES: tuple[str, ...] = ("correct", "incorrect", "partial", "revealed", "skipped")

# Flashcards: a self-reported label, never evidence of mastery.
FLASHCARD_STATUSES: tuple[str, ...] = ("learning", "know")

# Learn mode: a question needs several correct answers, not one lucky guess.
LEARN_MASTERY: dict[str, Any] = {
    "stages": ["new", "learning", "familiar", "mastered"],
    # Consecutive correct answers needed to reach each stage.
    "correct_streak_for_familiar": 1,
    "correct_streak_for_mastered": 3,
    # A wrong answer drops the streak to 0 and the stage back to "learning".
    "reset_streak_on_incorrect": True,
    # How many other questions to show before a missed one returns.
    "requeue_after_incorrect": 3,
}

# Active recall self-assessment.
RECALL_RATINGS: tuple[str, ...] = ("incorrect", "partial", "correct")

# Smart Review (spaced repetition): interval-based, documented defaults.
SRS: dict[str, Any] = {
    # Days until the next review after the 1st, 2nd, ... consecutive success.
    "intervals_days": [1, 3, 7, 14, 30],
    # After the last step, keep multiplying the previous interval.
    "growth_after_last": 2.0,
    "max_interval_days": 180,
    # Incorrect: back to the first step. Partial: repeat the current interval.
    "on_incorrect": "reset",
    "on_partial": "repeat",
}

# Mistake Review: a question leaves the active review list only after this
# many correct retries in a row. History is never deleted.
MISTAKES: dict[str, Any] = {
    "correct_retries_to_resolve": 2,
}


# Practice tests: defaults and limits for the setup form.
PRACTICE: dict[str, Any] = {
    "default_question_count": 20,
    "max_question_count": 200,
    "default_pass_percent": 70,
    "default_minutes": 30,
    "max_minutes": 300,
    # Shuffling answer choices breaks "All of the above" style options,
    # so it starts off and the learner opts in.
    "shuffle_questions_by_default": True,
    "shuffle_answers_by_default": False,
}


def public_config() -> dict[str, Any]:
    """Everything the browser needs, as plain JSON."""
    return {
        "modes": list(STUDY_MODES),
        "outcomes": list(ATTEMPT_OUTCOMES),
        "flashcardStatuses": list(FLASHCARD_STATUSES),
        "learn": {
            "stages": LEARN_MASTERY["stages"],
            "correctStreakForFamiliar": LEARN_MASTERY["correct_streak_for_familiar"],
            "correctStreakForMastered": LEARN_MASTERY["correct_streak_for_mastered"],
            "resetStreakOnIncorrect": LEARN_MASTERY["reset_streak_on_incorrect"],
            "requeueAfterIncorrect": LEARN_MASTERY["requeue_after_incorrect"],
        },
        "recallRatings": list(RECALL_RATINGS),
        "srs": {
            "intervalsDays": SRS["intervals_days"],
            "growthAfterLast": SRS["growth_after_last"],
            "maxIntervalDays": SRS["max_interval_days"],
            "onIncorrect": SRS["on_incorrect"],
            "onPartial": SRS["on_partial"],
        },
        "mistakes": {
            "correctRetriesToResolve": MISTAKES["correct_retries_to_resolve"],
        },
        "practice": {
            "defaultQuestionCount": PRACTICE["default_question_count"],
            "maxQuestionCount": PRACTICE["max_question_count"],
            "defaultPassPercent": PRACTICE["default_pass_percent"],
            "defaultMinutes": PRACTICE["default_minutes"],
            "maxMinutes": PRACTICE["max_minutes"],
            "shuffleQuestionsByDefault": PRACTICE["shuffle_questions_by_default"],
            "shuffleAnswersByDefault": PRACTICE["shuffle_answers_by_default"],
        },
    }
