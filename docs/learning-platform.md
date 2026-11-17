# Learning platform: architecture and progress

This document tracks the multi-mode learning platform work. It describes
only what is implemented and verified; planned work is listed separately.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Repository audit and plan | Done |
| 0.5 | Static files restricted to an allow-list (`.env`, source and `.git` were public) | Committed (`9d39483`) |
| 1 | Foundation: question ids, progress data model and API, shared JS core, scoped sessions, tests | Committed (`b6a9e2e`) |
| 2 | Flashcards | Committed |
| 3 | Practice test | Planned |
| 4 | Mistake review | Planned |
| 5 | Learn mode | Planned |
| 6 | Active recall | Planned |
| 7 | Smart review (spaced repetition) | Planned |
| 8 | Matching | Planned |
| 9 | Code challenge | Planned |
| 10 | Unified dashboard | Planned |

## Architecture

* **Backend:** Flask blueprints. `progress_routes.py` holds the learning API;
  every route is `login_required` and filters by the signed-in user, and
  every question id is checked against the set it claims to belong to.
* **Rules:** `learning_config.py` is the single source for modes, outcomes,
  mastery thresholds and review intervals. The browser reads it from
  `GET /api/learning/config`; nothing is duplicated in JavaScript.
* **Frontend:** plain scripts, no build step, loaded in this order:
  `js/core/learning.js` (shared helpers and API client, `window.Quizer`),
  `questions.js`, `Cert.js` (existing exam and training engine),
  `js/shell.js` (sidebar, header and question navigator), then one file per
  study mode in `js/modes/` (currently `flashcards.js`).
* **Study mode views:** each mode is a full-page view inside the app shell,
  opened from a tile in the dashboard's "Study modes" section or from the
  sidebar. Opening a view hides the dashboard; any sidebar link closes it.
* **Static files:** only the files listed in `PUBLIC_FILES` in `server.py`
  are served. Add new front-end files there.

## Question ids

Questions live in `question_sets.questions` (JSONB). Each now carries an
`id` (`question_ids.py`):

* An existing well-formed, unique id is always kept.
* Otherwise the id is `q_` + a hash of the text, choices and correct answer,
  so re-importing the same question yields the same id.
* Exact duplicates in one set get `-2`, `-3`, ... suffixes.
* Ids are assigned when a set is saved, and sets saved earlier are backfilled
  the first time they are opened (their `updated_at` is not changed).

## Progress model

Each mode keeps its own measurement. They are related but never merged into
one number.

| Data | Table | Meaning |
|---|---|---|
| Answer history | `question_attempts` | Append-only log of every answer in every mode. Never overwritten; Mistake Review and analytics read it. `client_attempt_id` makes retried requests idempotent. |
| Flashcard familiarity | `question_progress.flashcard_*` | Self-reported "know / still learning". Not evidence of mastery. |
| Learn mastery | `question_progress.learn_*` | Stage from consecutive correct answers. |
| Recall rating | `question_progress.recall_*` | Self-assessment after revealing the answer. |
| Mistake status | `question_progress.mistake_*` | Whether a question is in active review; history stays in attempts. |
| Review schedule | `question_progress.srs_*` | Spaced-repetition step, interval and due date. |
| Resumable state | `study_sessions` | One saved state per user, set and mode. |
| Test results | `session_history` | Exam and training results; new optional `config`, `duration_seconds` and `client_attempt_id` columns for practice tests. |

All tables are created by `schema.sql` with `IF NOT EXISTS`; nothing existing
was altered or dropped. Deleting a question set deletes its learning data.

### Default rules (`learning_config.py`)

* **Learn:** familiar after 1 correct answer in a row, mastered after 3; a
  wrong answer resets the streak and the question returns after 3 others.
* **Smart review:** 1, 3, 7, 14, 30 days after consecutive successes, then
  ×2 up to 180 days; incorrect resets to the first step, partial repeats the
  current interval.
* **Mistake review:** a question leaves active review after 2 correct
  retries in a row; its history is kept.

These are starting defaults, not proven-optimal values.

## Flashcards (Phase 2)

* **Front:** the question. **Back:** each correct choice with its explanation.
* **Labels:** "Know" and "Still learning" are self-reported, saved to
  `question_progress.flashcard_status`, and pressing the same label again
  clears it. They are never treated as mastery by any other mode.
* **Deck:** Previous/Next never wrap or skip. Filters show All, Still
  learning, Know or Not marked; a card whose label changes stays on screen
  until the filter is applied again. Shuffle keeps every card and the current
  one first; turning it off restores the set's order. Restart clears the
  viewed count only, never labels.
* **Resume:** order, filter, current card, viewed cards and shuffle are saved
  to `study_sessions` (mode `flashcards`) 0.6 s after each change and on
  exit. Opening waits for any save still in flight, and a saved session is
  reconciled with the set: removed questions are dropped, new ones appended,
  corrupt values replaced, and an empty saved filter falls back to All.
* **Answer log:** the first flip of a card in a session records a `revealed`
  attempt (batched). It counts as reviewed, never as correct or incorrect.
* **Input:** tap or Space flips; arrows move; K and L set labels; Escape
  exits; on touch screens a horizontal swipe moves between cards.
* **Read aloud:** the browser's built-in speech synthesis reads the visible
  side; no external service. The button is hidden where it is unsupported.
* **Reduced motion:** the faces swap without the 3D turn.

## Grading

`Quizer.learning.isCorrectAnswer` (in `js/core/learning.js`) is the one rule
every mode uses, including the existing exam: the selected choices must be
exactly the correct set, in any order. Partial multi-answer selections are
incorrect.

## Saved exam sessions

The in-progress exam is stored in `localStorage` under a per-user key
(`examSessionData:u<id>`). Nothing is saved while signed out, and sign-out,
set deletion and new generations discard the session before reloading so the
`beforeunload` save cannot write it back. A session saved under the old
shared key is handed to the first account that signs in, then removed.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/learning/config` | Modes, outcomes, mastery and review rules |
| GET | `/api/progress/<setId>` | Per-question progress for one set |
| POST | `/api/progress/<setId>/attempts` | Record up to 200 answers |
| GET | `/api/progress/<setId>/attempts` | Answer history (`questionId`, `mode`, `limit` filters) |
| GET / PUT / DELETE | `/api/study-sessions/<setId>/<mode>` | Resumable state (200 KB max) |
| PUT | `/api/progress/<setId>/flashcards/<questionId>` | Set or clear a flashcard label (`know`, `learning`, `null`) |

## Tests

```bash
python -m unittest discover -s tests -t .
node --test tests/js
```

The API tests use the database in `.env`, create throwaway `apitest_*` users
and delete them afterwards. They are skipped if no database is reachable.

## Known limitations

* Questions are multiple choice only; written answers, code and difficulty or
  topic fields are planned as optional additions in later phases.
* The existing exam and training modes do not record attempts yet; Phase 3
  connects them.
