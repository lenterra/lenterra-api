-- 0008 — A class-code account may not have a wallet yet.
--
-- `wallet_address` was NOT NULL because every account arrived through thirdweb
-- and therefore had one before the profile row existed. The class-code path
-- breaks that assumption: its default provisioning mode gives a student an
-- account with no wallet at all, and writes the address only if they later add
-- an email or a Google login.
--
-- That is the point rather than a limitation. A student joining from a code the
-- teacher wrote on the board should not need a third-party wallet service to be
-- reachable during the one hour a class is being onboarded, and an address that
-- is never issued is an address that can never change underneath a certificate.
--
-- The UNIQUE constraint is left exactly as it was. Postgres does not consider
-- two NULLs equal, so any number of accounts may be waiting for an address
-- while no two may ever share one.

BEGIN;

ALTER TABLE lenterra_account_profile
  ALTER COLUMN wallet_address DROP NOT NULL;

-- An upgrade looks the address up before claiming it, and a class-code roster
-- lists the accounts still waiting for one.
CREATE INDEX IF NOT EXISTS lenterra_account_profile_wallet_idx
  ON lenterra_account_profile (wallet_address)
  WHERE wallet_address IS NOT NULL;

COMMIT;
