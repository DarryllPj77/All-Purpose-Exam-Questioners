# Learning platform: architecture and progress

This document tracks the multi-mode learning platform work. It describes
only what is implemented and verified; planned work is listed separately.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Repository audit and plan | Done |
| 0.5 | Static files restricted to an allow-list (`.env`, source and `.git` were public) | Committed (`9d39483`) |
| 1 | Foundation: question ids, progress data model and API, shared JS core, scoped sessions, tests | Committed (`b6a9e2e`) |
| 2 | Flashcards | Committed (`a98df25`) |
| 3 | Practice test; exam and training answers logged | Committed (`dd19277`) |
| 4 | Mistake review | Committed |
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
  study mode in `js/modes/` (`flashcards.js`, `practice.js`, `mistakes.js`).
* **Study mode views:** each mode is a full-page `.mode-view` inside the app
  shell, opened from a tile in the dashboard's "Study modes" section or from
  the sidebar. `js/shell.js` keeps the list (`MODE_VIEWS`): opening a mode
  calls `closeModeViews(key)` so only one is ever open, and `showModeView()`
  swaps it in for the dashboard. Any sidebar link closes an open mode.
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

## Practice test (Phase 3)

* **Setup:** question count (capped to the questions that match the chosen
  types), one-answer and several-answer question types, optional timer
  (1–300 minutes), pass mark (1–100%), shuffle questions (on by default),
  shuffle answer choices (off by default, because it breaks "All of the
  above" options), feedback after submitting or after each question, and
  free or forward-only navigation. Each invalid field gets its own message.
  Difficulty is not offered: questions have no difficulty field yet.
* **During the test:** question number, progress bar, numbered navigator
  (display-only in forward-only mode), live timer with 5-minute and
  1-minute warnings, unanswered questions allowed, submit at any time with a
  confirmation that names the unanswered count, letter keys A–D to choose.
* **Scoring:** the shared grading rule; partial multi-answer selections are
  incorrect; unanswered questions are reported separately and count as not
  correct. Pass/fail compares the exact ratio, so 69.6% never passes a 70%
  mark even though it displays as 70%.
* **Timer:** decides only when the test ends. On expiry, or when the deadline
  passed while the page was closed, the saved answers are submitted; time
  spent is capped at the limit. The deadline is a wall-clock time, so a
  refresh never resets the clock.
* **No duplicates:** each test has one `attemptId`. The result is saved as
  "submitted" before anything is sent, so a refresh shows the results
  instead of running the test again. The history entry uses it as
  `clientAttemptId` (the server returns the original row on a repeat) and
  each answer-log row uses `attemptId_<n>`. A failed save shows a retry
  button and is retried automatically on the next open.
* **Saved test integrity:** a saved test is resumed only if every question
  still exists with the same choices; otherwise it is cleared rather than
  scored against changed questions.
* **Results:** pass or fail, score ring, totals for correct, incorrect and
  unanswered, time spent against the limit, and a filterable review of every
  question with the correct answer and explanation. History records mode
  `Practice` with the settings and duration.

## Exam and training answers

On submit, Exam and Training now write one answer-log row per question
(`correct`, `incorrect`, or `skipped` when unanswered). Only questions from a
saved set are logged; the built-in demo bank has no ids. Logging is
fire-and-forget and never affects the score or the results screen.

## Mistake review (Phase 4)

* **Source of truth:** the answer log. A question is open for review when it
  has an `incorrect` answer from any mode other than Mistake Review that is
  newer than its last review change. This is reconciled on every read, so
  mistakes made before this phase are included and nothing is duplicated
  (one `question_progress` row per question). `skipped` (unanswered) and
  `revealed` answers are not mistakes; a partial multi-answer pick is.
* **Retries are graded on the server** against the stored answer and logged
  with mode `mistakes`. Correct retries build a streak; the question is
  resolved after `MISTAKES["correct_retries_to_resolve"]` (2) in a row. A
  wrong or partial retry resets the streak. A new mistake in any mode
  reopens a resolved question. A resent retry (same `clientAttemptId`) is
  not counted twice.
* **History is never deleted.** "Clear from review" (with confirmation, for
  all sets or the selected set) only closes items; a cleared question comes
  back the next time it is answered wrong. Deleting a set still deletes its
  data, as everywhere else.
* **Screen:** filter by set, To review / Resolved tabs, totals and retry
  accuracy, each question's miss count, last mode and date, and a streak
  indicator. Review runs over every open question (most missed first) or a
  single one from its Retry button, with the correct answer and explanation
  after each check. Questions edited or removed from their set are hidden
  and counted in a note; their history stays.
* **Not resumable by design:** each retry is saved the moment it is checked,
  so stopping mid-round loses nothing; a new round starts from the current
  list.
* **Topic filter:** not available, because questions carry no topic field;
  filtering is by set.

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
| GET | `/api/mistakes` | Mistakes with question content, stats, summary and per-set counts (`setId` filter) |
| POST | `/api/mistakes/<setId>/<questionId>/retry` | Grade a retry on the server (`selected`, `clientAttemptId`) |
| POST | `/api/mistakes/reset` | Close open items for all sets, one set or one question; history is kept |
| POST | `/api/history` | Now also accepts mode `Practice`, `config`, `durationSeconds` and `clientAttemptId` (a repeat returns the original row with `duplicate: true`) |

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
* Practice tests have no difficulty filter because questions carry no
  difficulty field.
