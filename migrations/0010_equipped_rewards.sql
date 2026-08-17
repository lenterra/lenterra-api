-- 0010 — What a student is wearing, as opposed to what they own.
--
-- `lenterra_redemption` records a purchase and nothing else, so the shop could
-- take 800 points for a title and leave every screen unchanged. Ownership and
-- display are genuinely different facts: a student may own four colours and
-- wear one, and clearing a slot must not look like a refund.
--
-- Three nullable columns rather than a table, because the cardinality is fixed
-- by the catalogue's `kind` enum and one row per student is the whole extent of
-- it. A join table would model a many-to-many that cannot occur.
--
-- Nothing here references the catalogue. The columns hold the redeemed *item
-- id*, and what that id means is resolved from whichever catalogue version is
-- current when it is read. A student keeps wearing an item through a content
-- republish, and an item withdrawn from the catalogue stops rendering without
-- anybody having to rewrite these rows.
--
-- **Ownership is enforced in the handler, not by a constraint here.** The
-- obvious constraint — a CHECK that the equipped id appears in
-- `lenterra_redemption` — needs a subquery, which means wrapping it in a
-- function, and a CHECK that reads another table is re-evaluated on restore
-- against whatever has been loaded so far. `pg_restore` does not guarantee
-- redemptions land before profiles, so that constraint would turn a backup
-- into one that only restores sometimes. For a database the deployment notes
-- call "the product", a restore that fails on ordering is a worse failure than
-- the one the constraint prevents, and `v1.reward.equip` is the only writer.

BEGIN;

ALTER TABLE lenterra_account_profile
  ADD COLUMN IF NOT EXISTS equipped_avatar_color TEXT,
  ADD COLUMN IF NOT EXISTS equipped_board_skin   TEXT,
  ADD COLUMN IF NOT EXISTS equipped_title        TEXT;

COMMIT;
