-- Deletion requests and the moderation queue.
--
-- Both tables back promises the product makes in writing and had no mechanism
-- for: a student can ask for their data to be deleted (TRD-SEC-011), and a
-- student can report another (PRD-SOC-014, TRD-SEC-016). The moderation table
-- shipped in 0005 with nothing writing to it; this adds the queue view it
-- needs and the deletion side that was missing entirely.

-- A deletion is scheduled rather than immediate, for two reasons that pull in
-- the same direction. A child on a borrowed phone can tap the wrong thing, and
-- a 30-day window is what the privacy notice already promises — so the window
-- is the product's commitment, not a convenience.
CREATE TABLE IF NOT EXISTS lenterra_deletion_request (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for  TIMESTAMPTZ NOT NULL,
  -- Set when the student changes their mind inside the window.
  cancelled_at   TIMESTAMPTZ,
  executed_at    TIMESTAMPTZ,
  -- Who asked. A teacher may request on behalf of a guardian, and which of the
  -- two it was has to survive in the record.
  requested_by   UUID NOT NULL REFERENCES users(id),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS lenterra_deletion_due_idx
  ON lenterra_deletion_request (scheduled_for)
  WHERE cancelled_at IS NULL AND executed_at IS NULL;

-- One open report per pair. A student who taps report three times has not
-- reported three things, and three rows would make the queue look busier than
-- it is — which is how a real report gets missed.
CREATE UNIQUE INDEX IF NOT EXISTS lenterra_moderation_open_pair_idx
  ON lenterra_moderation_report (reporter_user_id, subject_user_id)
  WHERE status = 'open';
