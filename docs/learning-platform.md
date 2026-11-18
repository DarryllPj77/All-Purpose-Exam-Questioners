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
| 4 | Mistake review | Committed (`a09cf44`) |
| 5 | Learn mode | Committed (`f55bad3`) |
| 6 | Active recall | Committed (`a4458d6`) |
| 7 | Smart review (spaced repetition) | Committed (`3827276`) |
| 8 | Matching | Committed (`bca38dc`) |
| 9 | Code challenge | Implemented, not yet committed |
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
  `js/core/code.js` (code display and highlighting, `Quizer.code`),
  `questions.js`, `Cert.js` (existing exam and training engine),
  `js/shell.js` (sidebar, header and question navigator), then one file per
  study mode in `js/modes/` (`flashcards.js`, `learn.js`, `recall.js`,
  `review.js`, `practice.js`, `mistakes.js`, `matching.js`, `code.js`).
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

## Learn (Phase 5)

* **Rounds:** each round takes up to N unmastered questions (5, 10, 15 or
  20): missed ("learning") first, then new, then familiar, in set order.
  A miss comes back `requeue_after_incorrect` (3) questions later in the
  same round; a correct answer leaves the round and returns in a later one.
  So mastery needs correct answers across rounds, never one lucky streak.
* **Stages** (`LEARN_MASTERY`): new → learning (after a miss) → familiar
  (1 correct in a row) → mastered (3 correct in a row). Any miss resets the
  streak and the stage to learning.
* **Formats by stage:** new and learning questions use multiple choice;
  familiar ones use a typed answer when the correct choice is short and
  specific, otherwise recall with a self-check. Questions with several
  answers always use multi-select; two-choice questions work as true/false.
  Typed answers and recall can each be turned off.
* **Grading on the server** (`learn_routes.py`): choice answers use the
  shared rule; typed answers match the correct choice after
  `normalize_text()` (case, quotes, punctuation, spacing and a leading
  "a/an/the" are ignored), and the JS mirror is tested against the same
  table. A question is offered for typing only when one choice can be
  identified unambiguously and it is not a vague answer such as "All of
  the above". Recall ratings are self-reported and stored as such.
* **Records:** each answer updates the `learn_*` columns and is logged with
  mode `learn` (so Learn misses reach Mistake Review); resent answers are
  not counted twice.
* **Pause and resume:** the round (queue, position, per-question results,
  settings) is saved to `study_sessions` (mode `learn`) after each answer;
  a saved round is discarded if any of its questions no longer exists.
* **Summaries:** after each round (right first time, needed another go,
  mastered so far) and when the whole set is mastered.
* **Not included:** "I was right" overrides for typed answers; a near-miss
  typo counts as incorrect.

## Active recall (Phase 6)

* **No choices:** the question is shown alone. The learner may type an
  answer (optional), reveals the reference answer with its explanation, and
  rates themselves Incorrect, Partially correct or Correct (keys 1–3).
* **Self-assessment decides.** No AI or fuzzy grading. When something was
  typed, it is also compared with the accepted answers after
  `normalizeText()` (case, quotes, punctuation, spacing, leading article):
  a match is pointed out and "Correct" is highlighted, a mismatch asks the
  learner to judge, and answers that can't be checked say so. The server
  stores both the rating and the objective match (`autoMatched`).
* **Accepted answers:** the correct choice's text when a question has a
  single, specific answer, plus an optional `acceptedAnswers` list on the
  question (up to 20 short strings, validated on import). Multi-answer and
  "All of the above" style questions match only explicit `acceptedAnswers`.
  Python (`recall_routes.accepted_answers`) and JS
  (`Quizer.learning.acceptedAnswers`) are tested against one shared table.
* **Hardest first:** sessions order questions by the last rating:
  Incorrect, then Partially correct, then not yet tried, then Correct,
  oldest first within each group.
* **Records:** `question_progress.recall_rating` and each rating in the
  answer log (mode `recall`, outcome = rating). An Incorrect recall reaches
  Mistake Review; Partially correct does not.
* **Resume:** the session (queue, position, ratings) is saved to
  `study_sessions` (mode `recall`). No timer.
* **Shared text rule:** `normalizeText` now lives in `js/core/learning.js`;
  Learn uses the same function.

## Smart review (Phase 7)

* **Algorithm** (`review_routes.next_schedule`, values in `SRS`): a correct
  review moves one step along 1, 3, 7, 14, 30 days, then multiplies the
  previous interval by 2 up to 180 days. Partially correct repeats the
  current interval. Incorrect returns to the first step (1 day). These are
  initial defaults, not proven-optimal intervals.
* **Due dates follow the learner's day:** a review falls due at local
  midnight of the target day. The browser sends `Date.getTimezoneOffset()`
  with each request, so "due today", "overdue" and the 7-day / 14-day views
  use the learner's calendar; no timezone database is needed. Tested for
  UTC+8 and UTC-5 across date boundaries.
* **Data per question** (`question_progress`): `srs_step` (consecutive
  successes), `srs_interval_days`, `srs_due_at`, `srs_last_reviewed_at`,
  `srs_last_outcome`; full history in the answer log (mode `review`).
* **Integration without conflicts:** only Smart Review answers change the
  schedule. A question joins the schedule, due immediately, once it has any
  answer in another mode. An incorrect answer elsewhere after the last
  review makes it due now without changing its step or interval. A missed
  review also reaches Mistake Review, like a miss in any mode. Learn
  mastery, flashcard labels and recall ratings remain separate measures.
* **Formats:** multiple choice graded on the server, or recall with a
  self-rating (Forgot / Partly / Remembered).
* **Screen:** overdue, due today, reviewed today and next 7 days; today's
  progress; a 7-day upcoming chart; a 14-day history with accuracy;
  maturity bands (learning under 7 days, young 7–20, mature 21+, not
  studied yet); a set filter; the next review date after each answer.
* **No resume needed:** each answer is scheduled the moment it is checked,
  so stopping loses nothing; the next visit continues with what is due.

## Matching (Phase 8)

* **Pairs come from existing questions** (`js/modes/matching.js`, no new
  backend): question text on the left, the text of its correct answer on
  the right (several correct answers are joined with "; "). Only short,
  specific answers are used: answers over 120 characters, "All of the
  above", "Both", "Neither", "None..." and repeated question texts are left
  out. A set needs at least 2 pairable questions.
* **Identical labels are safe:** pairs are tracked by question id, and an
  answer tile whose text is the same as the correct answer is also
  accepted. Two questions both answered "True" can be matched either way,
  so a round can always be finished.
* **Input:** pick a question then an answer, or an answer then a question.
  Every tile is a button, so mouse, touch and keyboard (Tab, Enter, Space)
  all work; Escape clears a selection. No drag-and-drop is needed. A wrong
  pair flashes on both tiles and only adds to the miss count.
* **Rounds:** 4, 6 or 8 pairs; relaxed (no clock) or timed. Per round size
  the app keeps plays, last and best accuracy, and a best time from timed
  rounds only (`study_sessions` mode `matching`; the last size and pace are
  remembered). Accuracy is matches divided by tries.
* **Answer log:** each pair is logged with mode `matching`: correct if
  matched on the first try, otherwise incorrect, so missed pairs reach
  Mistake Review and pull Smart Review forward like any other miss.
* **No resume:** a round takes a minute or two, so a stopped or abandoned
  round is not saved; nothing is logged until a round is finished.

## Code challenge (Phase 9)

* **Content model (no migration):** four optional question fields, stored in
  the set's existing JSON: `code` (the snippet, up to 20,000 characters),
  `language` (`csharp`, `java`, `javascript`, `python`, `c`, `cpp`, `sql`;
  aliases such as `C#`, `js`, `py` are accepted; anything else shows as plain
  code), `challenge` and `expectedOutput`. Questions without them behave
  exactly as before. The importer validates the fields, and the AI prompt
  has a fourth type, "Code Challenge" (C# unless the topic is another
  language).
* **Challenge types** (`learning_config.CODE`): predict the output, find the
  syntax error, find the bug, complete the code, explain the code, identify
  the concept, multiple choice. A question with code but no type counts as
  multiple choice.
* **Security: nothing is executed.** Code is only displayed, as text nodes
  (never parsed as HTML). Answers are graded on the server
  (`code_routes.py`) against the stored answer: choices must match exactly,
  like every other mode. For "predict the output" the learner can type the
  output instead; it must equal `expectedOutput` (or the single correct
  choice) after unifying line endings and ignoring spaces at line ends and
  blank lines at the start and end. Letter case and everything else count.
  Any future execution would need an isolated sandbox with resource limits;
  none exists.
* **Display everywhere:** `Quizer.code.attach()` puts a code block after the
  question text in every mode (exam, training, practice, learn, recall,
  review, mistakes, flashcards, code challenge). Blocks have line numbers, a
  small built-in highlighter (keywords, strings, comments, numbers,
  preprocessor lines), a Copy button that also works on plain-HTTP pages,
  and horizontal scrolling inside the block so long lines never widen the
  page. On flashcards, taps and swipes that start on code scroll the code
  instead of flipping or changing the card. Matching skips questions with
  code, since "What does this print?" means nothing without it.
* **Sessions:** choose challenge types, 10 / 20 / all questions, shuffle,
  and whether to type output. The queue, position and results are saved
  after every answer (`study_sessions` mode `code`), so a session can be
  paused and continued, even after a reload. The summary shows the score by
  challenge type and offers to retry the missed questions.
* **Integration:** each answer is logged with mode `code`; misses reach
  Mistake Review (which shows the code) and bring Smart Review forward.
* **Sample set:** "Add a C# sample set" (shown when a set has no code
  questions) adds nine C# questions covering every challenge type.

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
| POST | `/api/learn/<setId>/<questionId>/answer` | Grade a Learn answer (`choice`, `written` or `recall`) and update mastery |
| POST | `/api/recall/<setId>/<questionId>/rate` | Save an Active Recall self-assessment (`rating`, optional `text`) |
| GET | `/api/review/overview` | Due, overdue, upcoming, maturity and 14-day history (`tzOffset`, optional `setId`) |
| POST | `/api/review/<setId>/<questionId>/answer` | Grade a review (`choice` or `recall`) and reschedule it |
| POST | `/api/code/<setId>/<questionId>/answer` | Grade a code challenge (`choice`, or typed `output` for output challenges); nothing is executed |
| POST | `/api/history` | Now also accepts mode `Practice`, `config`, `durationSeconds` and `clientAttemptId` (a repeat returns the original row with `duplicate: true`) |

## Tests

```bash
python -m unittest discover -s tests -t .
node --test tests/js
```

The API tests use the database in `.env`, create throwaway `apitest_*` users
and delete them afterwards. They are skipped if no database is reachable.

## Known limitations

* Questions are multiple choice only (code challenges add typed output);
  written answers and difficulty or topic fields are not supported yet.
* Practice tests have no difficulty filter because questions carry no
  difficulty field.
* Matching skips questions whose answer is long or vague ("All of the
  above"), so a set made mostly of those may not have enough pairs.
* The highlighter is a small tokenizer, not a full parser: it colours
  keywords, strings, comments and numbers, and does not understand
  regular expressions or nested string interpolation.
* Code challenge answers are checked against the answer key; the app cannot
  tell whether a question's own snippet really behaves as its answer says.
