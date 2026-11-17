"""Stable identifiers for questions inside a question set.

Questions live in the question_sets.questions JSONB array and were only ever
addressed by position. Per-question progress (attempts, mastery, review
schedules) needs an id that survives re-saves, so every question gets an
"id" field:

* An id the question already carries is kept as long as it is well formed
  and unique in the set, so ids stay put across edits and re-saves.
* A question without one gets "q_" + a hash of its text, choices and correct
  answer. The same question therefore gets the same id when it is imported
  again, and two sets never share ids by accident with different content.
* Exact duplicates inside one set get "-2", "-3", ... suffixes.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

QUESTION_ID_RE = re.compile(r"^q_[A-Za-z0-9_-]{1,48}$")


def content_hash_id(question: dict[str, Any]) -> str:
    text = str(question.get("text") or "").strip()
    choices = question.get("choices") if isinstance(question.get("choices"), dict) else {}
    answer = question.get("answer")
    answers = answer if isinstance(answer, list) else ([answer] if answer is not None else [])
    material = json.dumps(
        {
            "text": text,
            "choices": {str(k): str(v) for k, v in sorted(choices.items(), key=lambda kv: str(kv[0]))},
            "answer": sorted(str(a) for a in answers),
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return "q_" + hashlib.sha1(material.encode("utf-8")).hexdigest()[:16]


def assign_question_ids(questions: list[Any]) -> tuple[list[Any], bool]:
    """Return (questions with ids, whether anything changed).

    Non-dict entries are passed through untouched; validating question shape
    is the caller's job. The input list is not mutated.
    """
    used: set[str] = set()
    changed = False
    result: list[Any] = []

    # Keep valid, unique ids first so a new question can never steal one.
    keep: list[bool] = []
    for q in questions:
        qid = q.get("id") if isinstance(q, dict) else None
        ok = isinstance(qid, str) and bool(QUESTION_ID_RE.match(qid)) and qid not in used
        if ok:
            used.add(qid)
        keep.append(ok)

    for q, kept in zip(questions, keep):
        if not isinstance(q, dict):
            result.append(q)
            continue
        if kept:
            result.append(q)
            continue
        base = content_hash_id(q)
        qid, n = base, 2
        while qid in used:
            qid = f"{base}-{n}"
            n += 1
        used.add(qid)
        result.append({**q, "id": qid})
        changed = True

    return result, changed
