-- 0001 — Identity and organisation, plus auth support.
--
-- Creates only lenterra_* objects. Nakama owns `users` and every other table
-- it ships with; we reference `users(id)` but never alter it, so a Nakama
-- upgrade stays a supported operation.
--
-- Runs after `nakama migrate up`, which is what guarantees `users` exists.

BEGIN;

CREATE TABLE IF NOT EXISTS lenterra_school (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  district      TEXT NOT NULL,
  province      TEXT NOT NULL DEFAULT 'NTT',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lenterra_account_profile (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('student','teacher','school_admin','staff')),
  display_name   TEXT NOT NULL,
  -- Rotatable. Replaces the wallet address everywhere a student-visible
  -- identifier is needed; the demo printed the raw address (profile.tsx:481).
  friend_code    TEXT NOT NULL UNIQUE,
  school_id      UUID REFERENCES lenterra_school(id),
  locale         TEXT NOT NULL DEFAULT 'id',
  -- From thirdweb. Never shown to students.
  wallet_address TEXT NOT NULL UNIQUE,
  auth_strategy  TEXT NOT NULL CHECK (auth_strategy IN ('email','google','class_code')),
  onboarded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lenterra_account_profile_school_role_idx
  ON lenterra_account_profile (school_id, role);
CREATE INDEX IF NOT EXISTS lenterra_account_profile_friend_code_idx
  ON lenterra_account_profile (friend_code);

-- Replay protection for the HS256 assertions minted by the verifier (ADR-004).
-- One row per sign-in, alive for two minutes; a scheduled cleanup drops the
-- expired ones.
CREATE TABLE IF NOT EXISTS lenterra_auth_jti (
  jti        TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS lenterra_auth_jti_expires_idx
  ON lenterra_auth_jti (expires_at);

COMMIT;
