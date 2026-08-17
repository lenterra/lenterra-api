-- 0009 — Staff invites, and an auth strategy that needs no mailbox.
--
-- Teachers previously signed in with a code sent to their email. Nothing in
-- this system reads a mailbox any more, so a teacher needs another way to come
-- into existence — and the mechanism that already works for students is a code
-- somebody trusted hands them.
--
-- A staff invite is that code, with three differences from a class code:
-- it is single-use, it names the role it confers, and it can only be issued by
-- an account that already holds authority. A class code admits a child to a
-- class; this one admits an adult to other people's children's records.

BEGIN;

-- The strategy a profile was created under. 'email' and 'google' remain legal
-- because rows created under them still exist; nothing issues them any more.
ALTER TABLE lenterra_account_profile
  DROP CONSTRAINT IF EXISTS lenterra_account_profile_auth_strategy_check;
ALTER TABLE lenterra_account_profile
  ADD CONSTRAINT lenterra_account_profile_auth_strategy_check
  CHECK (auth_strategy IN ('email','google','class_code','staff_code','wallet'));

CREATE TABLE IF NOT EXISTS lenterra_staff_invite (
  id             UUID PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  role           TEXT NOT NULL CHECK (role IN ('teacher','school_admin','staff')),

  -- Platform staff belong to no school; a teacher must belong to one, because
  -- every authorisation check below the staff role is scoped by school.
  school_id      UUID REFERENCES lenterra_school(id),
  CONSTRAINT lenterra_staff_invite_school_required
    CHECK (role = 'staff' OR school_id IS NOT NULL),

  -- NULL for the bootstrap invite, which is written by a script on the server
  -- because at that point no account exists that could have issued it.
  issued_by      UUID REFERENCES users(id) ON DELETE SET NULL,

  -- When set, redeeming this invite moves the named teacher's standing — their
  -- role, their school, and ownership of their classes — onto whoever redeems
  -- it. It exists for the teacher who has lost access to their account and
  -- would otherwise lose every class with it.
  --
  -- Transfer is never automatic and never inferred: an administrator names the
  -- account, exactly as approving a student's reclaim requires a teacher to
  -- name the profile. Merging accounts on a guess is how the wrong child's
  -- term gets erased.
  transfers_from UUID REFERENCES users(id) ON DELETE CASCADE,

  expires_at     TIMESTAMPTZ NOT NULL,
  redeemed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at    TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The lookup on the redemption path: by code, unredeemed, unrevoked, unexpired.
CREATE INDEX IF NOT EXISTS lenterra_staff_invite_open_idx
  ON lenterra_staff_invite (code)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- The administrator's list view, newest first, scoped to one school.
CREATE INDEX IF NOT EXISTS lenterra_staff_invite_school_idx
  ON lenterra_staff_invite (school_id, created_at DESC);

COMMIT;
