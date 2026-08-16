-- 0003 — Content catalog, attempts, and the mastery model.
--
-- The core of the system. lenterra_mastery_event is the most valuable table in
-- the schema: it is what lets a teacher see the evidence chain, lets the engine
-- be re-run over history after a parameter change, and lets an engine bug be
-- repaired by recomputation rather than by guesswork.

BEGIN;

-- --------------------------------------------------------------------------
-- Content catalog
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lenterra_catalog_version (
  version      TEXT PRIMARY KEY,                  -- 'catalog@2026-09-04.3'
  status       TEXT NOT NULL CHECK (status IN ('draft','published','current','rolled_back')),
  manifest     JSONB NOT NULL,                    -- part list, hashes, byte sizes
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES users(id),
  notes        TEXT
);

-- The rollback mechanism: promoting a version is one UPDATE, and the database
-- guarantees exactly one current version exists (PRD-CNT-008).
CREATE UNIQUE INDEX IF NOT EXISTS lenterra_catalog_version_current_idx
  ON lenterra_catalog_version (status) WHERE status = 'current';

CREATE TABLE IF NOT EXISTS lenterra_catalog_part (
  version    TEXT NOT NULL REFERENCES lenterra_catalog_version(version) ON DELETE CASCADE,
  part       TEXT NOT NULL,                       -- 'missions.congklak', 'strings.id'
  sha256     TEXT NOT NULL,
  bytes      INT NOT NULL,
  body       JSONB NOT NULL,
  PRIMARY KEY (version, part)
);

CREATE TABLE IF NOT EXISTS lenterra_mission (
  mission_id      TEXT NOT NULL,                  -- 'congklak.m11'
  content_version INT  NOT NULL,                  -- bumps on gameplay change (PRD-CNT-004)
  catalog_version TEXT NOT NULL REFERENCES lenterra_catalog_version(version) ON DELETE CASCADE,
  game_id         TEXT NOT NULL,
  rank            INT  NOT NULL,
  skill_weights   JSONB NOT NULL,
  definition      JSONB NOT NULL,                 -- setup, goal, constraints, config
  PRIMARY KEY (mission_id, content_version, catalog_version)
);

CREATE INDEX IF NOT EXISTS lenterra_mission_catalog_game_rank_idx
  ON lenterra_mission (catalog_version, game_id, rank);

-- --------------------------------------------------------------------------
-- Attempts and evidence
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lenterra_attempt (
  id                      UUID PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id              TEXT NOT NULL,
  mission_content_version INT NOT NULL,
  catalog_version         TEXT NOT NULL,
  game_id                 TEXT NOT NULL,

  outcome         TEXT NOT NULL CHECK (outcome IN ('success','failure','abandoned')),
  duration_ms     INT  NOT NULL CHECK (duration_ms >= 0),
  move_count      INT  NOT NULL CHECK (move_count >= 0),
  hint_shown      BOOLEAN NOT NULL DEFAULT false,
  hint_used       BOOLEAN NOT NULL DEFAULT false,
  played_offline  BOOLEAN NOT NULL DEFAULT false,
  two_player      BOOLEAN NOT NULL DEFAULT false,

  replay          JSONB NOT NULL,                 -- ordered moves; re-executable
  metrics         JSONB NOT NULL DEFAULT '{}',    -- greedyMoveTaken, optimalMoveRank, …

  -- Device clock, informational only. Server time is authoritative (20-09).
  client_started_at TIMESTAMPTZ NOT NULL,
  device_seq        BIGINT NOT NULL,              -- monotonic per device
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at      TIMESTAMPTZ,
  validation_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (validation_status IN ('pending','validated','rejected')),
  rejection_reason  TEXT,

  idempotency_key TEXT NOT NULL UNIQUE,
  client_version  TEXT NOT NULL,
  -- Earns its place: when validation rejections spike (M-S01), the first
  -- question is always whether a client is running an older rules core.
  core_version    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS lenterra_attempt_user_submitted_idx
  ON lenterra_attempt (user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS lenterra_attempt_mission_status_idx
  ON lenterra_attempt (mission_id, validation_status);
CREATE INDEX IF NOT EXISTS lenterra_attempt_pending_idx
  ON lenterra_attempt (validation_status) WHERE validation_status = 'pending';
CREATE INDEX IF NOT EXISTS lenterra_attempt_user_mission_status_idx
  ON lenterra_attempt (user_id, mission_id, validation_status);

CREATE TABLE IF NOT EXISTS lenterra_check_result (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  check_id        TEXT NOT NULL,
  course_id       TEXT NOT NULL,
  lesson_id       TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  answers         JSONB NOT NULL,
  score           DOUBLE PRECISION NOT NULL CHECK (score BETWEEN 0 AND 1),
  passed          BOOLEAN NOT NULL,
  attempt_number  INT NOT NULL DEFAULT 1,
  played_offline  BOOLEAN NOT NULL DEFAULT false,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at    TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS lenterra_check_result_user_course_idx
  ON lenterra_check_result (user_id, course_id);

-- --------------------------------------------------------------------------
-- Mastery and ratings
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lenterra_skill_mastery (
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_node_id     TEXT NOT NULL,
  mastery           DOUBLE PRECISION NOT NULL CHECK (mastery BETWEEN 0 AND 1),
  evidence_count    INT  NOT NULL DEFAULT 0,
  distinct_sources  INT  NOT NULL DEFAULT 0,      -- distinct missions/checks (PRD-LRN-005)
  first_evidence_at TIMESTAMPTZ,
  last_evidence_at  TIMESTAMPTZ,
  last_attempt_id   UUID REFERENCES lenterra_attempt(id),
  engine_version    TEXT NOT NULL,
  params_version    TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, skill_node_id)
);

CREATE INDEX IF NOT EXISTS lenterra_skill_mastery_node_idx
  ON lenterra_skill_mastery (skill_node_id, mastery);

-- Append-only audit of every mastery change (PRD-LRN-003, PRD-ADPT-010).
CREATE TABLE IF NOT EXISTS lenterra_mastery_event (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_node_id  TEXT NOT NULL,
  source_type    TEXT NOT NULL CHECK (source_type IN ('attempt','check','recompute')),
  source_id      UUID,
  mastery_before DOUBLE PRECISION NOT NULL,
  mastery_after  DOUBLE PRECISION NOT NULL,
  weight         DOUBLE PRECISION NOT NULL,       -- skill weight × hint discount
  correct        BOOLEAN NOT NULL,
  engine_version TEXT NOT NULL,
  params_version TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_mastery_event_user_node_idx
  ON lenterra_mastery_event (user_id, skill_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lenterra_mastery_event_source_idx
  ON lenterra_mastery_event (source_id);

CREATE TABLE IF NOT EXISTS lenterra_student_rating (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    TEXT NOT NULL,
  rating     DOUBLE PRECISION NOT NULL DEFAULT 1000,
  matches    INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS lenterra_mission_rating (
  mission_id      TEXT NOT NULL,
  content_version INT  NOT NULL,
  rating          DOUBLE PRECISION NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  successes       INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, content_version)
);

CREATE TABLE IF NOT EXISTS lenterra_engine_params (
  params_version TEXT NOT NULL,
  skill_node_id  TEXT NOT NULL DEFAULT '',        -- '' = global defaults
  p_init         DOUBLE PRECISION NOT NULL CHECK (p_init BETWEEN 0 AND 1),
  p_transit      DOUBLE PRECISION NOT NULL CHECK (p_transit BETWEEN 0 AND 1),
  p_slip         DOUBLE PRECISION NOT NULL CHECK (p_slip BETWEEN 0 AND 1),
  p_guess        DOUBLE PRECISION NOT NULL CHECK (p_guess BETWEEN 0 AND 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active         BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (params_version, skill_node_id)
);

-- Exactly one active parameter set. Changing engine parameters is an event
-- (20-06), not a config tweak, and this index makes that structural.
CREATE UNIQUE INDEX IF NOT EXISTS lenterra_engine_params_active_idx
  ON lenterra_engine_params (skill_node_id) WHERE active;

-- --------------------------------------------------------------------------
-- Struggle detection
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lenterra_struggle_event (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_node_id   TEXT NOT NULL,
  attempt_ids     UUID[] NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,                    -- set when mastery rises (M-L04)
  support_offered TEXT[] NOT NULL DEFAULT '{}',
  support_taken   TEXT
);

CREATE INDEX IF NOT EXISTS lenterra_struggle_event_user_idx
  ON lenterra_struggle_event (user_id, resolved_at);
CREATE INDEX IF NOT EXISTS lenterra_struggle_event_open_idx
  ON lenterra_struggle_event (skill_node_id, detected_at DESC) WHERE resolved_at IS NULL;

COMMIT;
