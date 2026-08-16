-- 0005 — Teacher operations, telemetry, consent, moderation, idempotency.
--
-- Every action an adult takes on a child's account is audited. That is a
-- requirement of 20-14, not a nice-to-have.

BEGIN;

CREATE TABLE IF NOT EXISTS lenterra_assignment (
  id              UUID PRIMARY KEY,
  class_id        UUID NOT NULL REFERENCES lenterra_class(id) ON DELETE CASCADE,
  teacher_user_id UUID NOT NULL REFERENCES users(id),
  target_user_id  UUID REFERENCES users(id),   -- NULL = whole class
  kind            TEXT NOT NULL CHECK (kind IN ('mission','lesson')),
  target_id       TEXT NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lenterra_assignment_class_idx
  ON lenterra_assignment (class_id) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS lenterra_audit_log (
  id            UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  action        TEXT NOT NULL,        -- 'class.member.remove', 'reclaim.approve'
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_audit_log_subject_idx
  ON lenterra_audit_log (subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lenterra_audit_log_actor_idx
  ON lenterra_audit_log (actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lenterra_event (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,               -- 'attempt.validated', 'session.start'
  payload        JSONB NOT NULL DEFAULT '{}', -- never contains PII (20-13 rule 3)
  occurred_at    TIMESTAMPTZ NOT NULL,        -- corrected server-side
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_seq     BIGINT,
  client_version TEXT
);

CREATE INDEX IF NOT EXISTS lenterra_event_name_idx
  ON lenterra_event (name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lenterra_event_user_idx
  ON lenterra_event (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS lenterra_consent (
  id           UUID PRIMARY KEY,
  school_id    UUID NOT NULL REFERENCES lenterra_school(id),
  class_id     UUID REFERENCES lenterra_class(id),
  confirmed_by UUID NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL,                -- 'school_participation'
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lenterra_consent_school_idx
  ON lenterra_consent (school_id) WHERE withdrawn_at IS NULL;

CREATE TABLE IF NOT EXISTS lenterra_moderation_report (
  id               UUID PRIMARY KEY,
  reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  context          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','actioned','dismissed')),
  resolved_by      UUID REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_moderation_report_status_idx
  ON lenterra_moderation_report (status, created_at);

-- Idempotency lives in the rpc() wrapper, not in handlers: offline sync
-- retries constantly, and making each handler responsible for its own
-- deduplication guarantees one of them forgets.
CREATE TABLE IF NOT EXISTS lenterra_idempotency (
  key        TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rpc        TEXT NOT NULL,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_idempotency_created_idx
  ON lenterra_idempotency (created_at);

-- Rate limiting (20-04 "Rate limits"). Fixed windows are sufficient: the
-- limits exist to stop brute force and runaway retries, not to shape traffic.
CREATE TABLE IF NOT EXISTS lenterra_rate_limit (
  bucket       TEXT NOT NULL,        -- '<rpc>:<subject>'
  window_start TIMESTAMPTZ NOT NULL,
  count        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS lenterra_rate_limit_window_idx
  ON lenterra_rate_limit (window_start);

COMMIT;
