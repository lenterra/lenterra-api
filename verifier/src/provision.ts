/**
 * Provisioning an identity for a code sign-in.
 *
 * A student typing a class code, and a teacher typing a staff invite, both need
 * an identifier before they have an account. This is where it comes from.
 *
 * **There used to be two modes**, and the second provisioned a thirdweb wallet
 * headlessly so that a class-code student had an address from their first
 * minute. It existed because sign-in was going to be an email one day, and a
 * wallet had to be waiting when it arrived. Nothing signs in by email any more:
 * a wallet is now something a person opts into from their profile, using a
 * wallet they already control, and `v1.account.upgrade` attaches it to the
 * account they already have.
 *
 * So the mode is gone. It was never exercised against a live integration — the
 * question behind it was never answered — and keeping an unverified second way
 * to mint an identity would be keeping a second front door with an unknown lock.
 * The remaining mode is the one the whole system already runs on.
 *
 * A certificate does not need any of this. It is meaningful off-chain from the
 * day it is issued; on-chain anchoring is a later addition, not a precondition
 * (ADR-009).
 */

import { createHash } from 'node:crypto';

export interface ProvisionedIdentity {
  /** What Nakama's `authenticateCustom` is called with. */
  customId: string;
  /** Null until the account holder attaches a wallet themselves. */
  walletAddress: string | null;
}

export interface CodeProvisioner {
  readonly mode: 'deferred';
  provision(seed: string): Promise<ProvisionedIdentity>;
}

/**
 * No wallet until somebody asks for one.
 *
 * The custom id is a hash of the seed rather than the seed itself, which makes
 * provisioning idempotent within the grant's lifetime: a retry after a dropped
 * response yields the same account rather than a second one, and a student on a
 * bus with one bar retries constantly.
 *
 * The prefix is unchanged from when this was one of two modes. Renaming it would
 * orphan every account already provisioned under it, and the string is an opaque
 * key rather than a description of anything.
 */
export class DeferredProvisioner implements CodeProvisioner {
  readonly mode = 'deferred' as const;

  async provision(seed: string): Promise<ProvisionedIdentity> {
    const digest = createHash('sha256').update(`lenterra:class-code:${seed}`).digest('hex');
    return { customId: `lc_${digest.slice(0, 32)}`, walletAddress: null };
  }
}

/**
 * Refuse to start on a configuration that no longer exists.
 *
 * A deployment still setting `CLASS_CODE_PROVISIONER=thirdweb` is asking for
 * behaviour this service has stopped having. Starting anyway and quietly doing
 * something else would give that deployment class-code students with no wallet
 * while its configuration says otherwise — which is exactly the silent
 * divergence the two-mode design was careful to avoid.
 */
export function provisionerFromEnv(env: NodeJS.ProcessEnv): CodeProvisioner {
  const mode = env['CLASS_CODE_PROVISIONER'];

  if (mode !== undefined && mode !== 'deferred') {
    throw new Error(
      `CLASS_CODE_PROVISIONER must be 'deferred' or unset, not '${mode}'. ` +
        'Wallets are attached by their owner through v1.account.upgrade, not provisioned at sign-in.',
    );
  }

  return new DeferredProvisioner();
}
