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
    mode          TEXT NOT NULL,            -- 'Exam' | 'Training'
    score         INT NOT NULL,             -- percentage 0..100
    correct_count INT NOT NULL,
    total_count   INT NOT NULL,
    finished_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
