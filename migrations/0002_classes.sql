-- 0002 — Classes, membership, and account reclaim.
--
-- A class exists twice: as a Nakama group (so leaderboards and membership work
-- natively) and as a lenterra_class row (so teacher aggregates can join).
-- v1.teacher.class.create writes both in one operation, which is what keeps
-- them from diverging.

BEGIN;

CREATE TABLE IF NOT EXISTS lenterra_class (
  id                   UUID PRIMARY KEY,
  school_id            UUID NOT NULL REFERENCES lenterra_school(id),
  teacher_user_id      UUID NOT NULL REFERENCES users(id),
  nakama_group_id      UUID NOT NULL,
  name                 TEXT NOT NULL,
  level                TEXT NOT NULL,             -- 'SMP-8', 'SMA-11', …
  join_code            TEXT,                      -- NULL once revoked
  join_code_expires_at TIMESTAMPTZ,
  max_members          INT NOT NULL DEFAULT 40,
  leaderboard_enabled  BOOLEAN NOT NULL DEFAULT true,   -- PRD-SOC-008
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at          TIMESTAMPTZ
);

-- Partial: a revoked code is NULL, and many classes may be revoked at once.
CREATE UNIQUE INDEX IF NOT EXISTS lenterra_class_join_code_idx
  ON lenterra_class (join_code) WHERE join_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS lenterra_class_teacher_idx
  ON lenterra_class (teacher_user_id) WHERE archived_at IS NULL;

-- removed_at rather than deletion: removing a student from a class must never
-- destroy their learning history (PRD-TCH-003).
CREATE TABLE IF NOT EXISTS lenterra_class_member (
  class_id   UUID NOT NULL REFERENCES lenterra_class(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (class_id, user_id)
);

CREATE INDEX IF NOT EXISTS lenterra_class_member_user_idx
  ON lenterra_class_member (user_id) WHERE removed_at IS NULL;

-- Teacher-approved account reclaim for class-code students (PRD-ONB-005).
CREATE TABLE IF NOT EXISTS lenterra_reclaim_request (
  id                UUID PRIMARY KEY,
  class_id          UUID NOT NULL REFERENCES lenterra_class(id) ON DELETE CASCADE,
  target_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  approved_by       UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lenterra_reclaim_request_class_status_idx
  ON lenterra_reclaim_request (class_id, status);

COMMIT;
