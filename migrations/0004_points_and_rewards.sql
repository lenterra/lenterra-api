-- 0004 — Points, streaks, achievements, certificates, courses.
--
-- Points are a ledger, never a counter. Balance is always SUM(delta)
--, so a balance can never drift from the reasons behind it, and
-- a correction is a compensating row rather than an edit.

BEGIN;

CREATE TABLE IF NOT EXISTS lenterra_points_ledger (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta           BIGINT NOT NULL,
  reason          TEXT NOT NULL,        -- 'mission.first', 'streak.day', 'correction.reversal'
  source_type     TEXT NOT NULL,
  source_id       UUID,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_points_ledger_user_idx
  ON lenterra_points_ledger (user_id, created_at DESC);

CREATE OR REPLACE VIEW lenterra_points_balance AS
  SELECT user_id, COALESCE(SUM(delta), 0)::BIGINT AS balance
  FROM lenterra_points_ledger
  GROUP BY user_id;

CREATE TABLE IF NOT EXISTS lenterra_streak (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_days     INT NOT NULL DEFAULT 0,
  longest_days     INT NOT NULL DEFAULT 0,
  last_credit_date DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lenterra_achievement (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  awarded_by     UUID REFERENCES users(id),   -- teacher-awarded, e.g. 'guru_kecil'
  PRIMARY KEY (user_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS lenterra_redemption (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  cost       BIGINT NOT NULL,
  ledger_id  UUID NOT NULL REFERENCES lenterra_points_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_redemption_user_idx
  ON lenterra_redemption (user_id, created_at DESC);

-- The evidence snapshot is taken at issuance and never recomputed: a
-- certificate must stay meaningful after mastery decay, and it
-- must be exactly what gets hashed on-chain at R3.
CREATE TABLE IF NOT EXISTS lenterra_certificate (
  id                UUID PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  definition_id     TEXT NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence          JSONB NOT NULL,
  evidence_hash     TEXT NOT NULL,
  onchain_status    TEXT NOT NULL DEFAULT 'none'
                      CHECK (onchain_status IN ('none','pending','minted','failed')),
  onchain_chain     TEXT,
  onchain_tx        TEXT,
  onchain_token_id  TEXT,
  public_verifiable BOOLEAN NOT NULL DEFAULT false,   -- student-controlled
  UNIQUE (user_id, definition_id)
);

CREATE TABLE IF NOT EXISTS lenterra_course_progress (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    TEXT NOT NULL,
  lesson_id    TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS lenterra_course_progress_user_course_idx
  ON lenterra_course_progress (user_id, course_id);

CREATE TABLE IF NOT EXISTS lenterra_entitlement (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement TEXT NOT NULL,                  -- 'free', 'paket-sekolah'
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, entitlement)
);

COMMIT;
