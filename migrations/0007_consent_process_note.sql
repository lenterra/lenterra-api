-- 0007 — Record *which* consent process a school followed.
--
-- `lenterra_consent` recorded that somebody confirmed, when, and for which
-- school. What it could not record is the thing a school will actually be asked
-- about later: under what process. "The head teacher signed the participation
-- form on 3 February" and "we announced it at assembly" are both answers a
-- school might give, and they are not the same answer.
--
-- Without it the row attests that a box was ticked. With it the row attests to
-- something a person can be asked to produce (TRD-SEC-014).

ALTER TABLE lenterra_consent
  ADD COLUMN IF NOT EXISTS process_note TEXT;

-- Existing rows predate the column and cannot be reconstructed. They are left
-- null rather than backfilled with a guess: an invented process description is
-- worse than an absent one, because it reads as evidence.

-- One live consent per school. A second active row would make "is consent on
-- file" ambiguous exactly when it matters, and withdrawal would have to find
-- every copy to be effective.
CREATE UNIQUE INDEX IF NOT EXISTS lenterra_consent_one_live_per_school
  ON lenterra_consent (school_id, kind)
  WHERE withdrawn_at IS NULL;
