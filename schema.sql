-- All Purpose Exam Questioners — PostgreSQL schema.
-- Idempotent: safe to run on every server start.

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    email           TEXT UNIQUE,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS question_sets (
    id              TEXT PRIMARY KEY,                       -- "qs_<...>" client-friendly id
    owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    schema_version  INT NOT NULL DEFAULT 1,
    title           TEXT NOT NULL,
    source          JSONB NOT NULL DEFAULT '{}'::jsonb,
    questions       JSONB NOT NULL,
    question_count  INT NOT NULL DEFAULT 0,
    stats           JSONB NOT NULL
        DEFAULT '{"sessionsRun":0,"lastPlayedAt":null,"bestScore":null,"averageScore":null}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_question_sets_owner_updated
    ON question_sets(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_active_set (
    owner_id   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    set_id     TEXT REFERENCES question_sets(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session_history (
    id            BIGSERIAL PRIMARY KEY,
    owner_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id        TEXT REFERENCES question_sets(id) ON DELETE SET NULL,
    set_title     TEXT,
    mode          TEXT NOT NULL,            -- 'Exam' | 'Training'
    score         INT NOT NULL,             -- percentage 0..100
    correct_count INT NOT NULL,
    total_count   INT NOT NULL,
    review_data   JSONB,
    finished_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS set_title TEXT;
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS review_data JSONB;
UPDATE session_history AS history
SET set_title = sets.title
FROM question_sets AS sets
WHERE history.set_title IS NULL
  AND history.set_id = sets.id
  AND history.owner_id = sets.owner_id;
CREATE INDEX IF NOT EXISTS idx_session_history_owner_finished
    ON session_history(owner_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS active_sessions (
    owner_id   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state      JSONB NOT NULL,              -- mirrors the client's examSessionData
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_usage (
    owner_id                  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ai_generations_count      INT NOT NULL DEFAULT 0,
    questions_generated_count INT NOT NULL DEFAULT 0,
    current_period_start      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end        TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 month'
);

-- ============================================================
-- Learning platform (Phase 1). Additive only: nothing above changes.
-- Each mode keeps its own measurement; see docs/learning-platform.md.
-- Deleting a question set deletes its learning data with it.
-- ============================================================

-- Append-only log of every answer, in every mode. Mistake Review and
-- analytics read history from here, so nothing is ever overwritten.
CREATE TABLE IF NOT EXISTS question_attempts (
    id                BIGSERIAL PRIMARY KEY,
    owner_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id            TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
    question_id       TEXT NOT NULL,
    mode              TEXT NOT NULL,          -- learning_config.STUDY_MODES
    outcome           TEXT NOT NULL,          -- learning_config.ATTEMPT_OUTCOMES
    response          JSONB,                  -- what was answered (choices, text, rating)
    client_attempt_id TEXT,                   -- makes retried requests idempotent
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attempts_owner_set_question
    ON question_attempts(owner_id, set_id, question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_owner_created
    ON question_attempts(owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_owner_client_id
    ON question_attempts(owner_id, client_attempt_id)
    WHERE client_attempt_id IS NOT NULL;

-- Current per-question state. One row per (user, set, question); each mode
-- owns its own columns and never writes another mode's.
CREATE TABLE IF NOT EXISTS question_progress (
    owner_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id                TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
    question_id           TEXT NOT NULL,
    -- Flashcards: self-reported familiarity, not mastery.
    flashcard_status      TEXT,
    flashcard_updated_at  TIMESTAMPTZ,
    -- Learn mode mastery.
    learn_stage           TEXT,
    learn_streak          INT NOT NULL DEFAULT 0,
    learn_correct         INT NOT NULL DEFAULT 0,
    learn_incorrect       INT NOT NULL DEFAULT 0,
    learn_updated_at      TIMESTAMPTZ,
    -- Active recall self-assessment.
    recall_rating         TEXT,
    recall_updated_at     TIMESTAMPTZ,
    -- Mistake review status (history itself stays in question_attempts).
    mistake_open          BOOLEAN NOT NULL DEFAULT FALSE,
    mistake_retry_streak  INT NOT NULL DEFAULT 0,
    mistake_updated_at    TIMESTAMPTZ,
    -- Smart review (spaced repetition) schedule.
    srs_step              INT NOT NULL DEFAULT 0,
    srs_interval_days     INT,
    srs_due_at            TIMESTAMPTZ,
    srs_last_reviewed_at  TIMESTAMPTZ,
    srs_last_outcome      TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, set_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_owner_due
    ON question_progress(owner_id, srs_due_at)
    WHERE srs_due_at IS NOT NULL;

-- Resumable state per (user, set, mode): deck position, queue, settings.
CREATE TABLE IF NOT EXISTS study_sessions (
    owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id     TEXT NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
    mode       TEXT NOT NULL,
    state      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, set_id, mode)
);

-- Practice tests reuse session_history; these columns are optional.
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS config JSONB;
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS duration_seconds INT;
ALTER TABLE session_history ADD COLUMN IF NOT EXISTS client_attempt_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_history_owner_client_id
    ON session_history(owner_id, client_attempt_id)
    WHERE client_attempt_id IS NOT NULL;
