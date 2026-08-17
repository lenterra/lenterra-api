/**
 * Provisioning an identity for a class-code student.
 *
 * Two modes exist because OQ-04 asked a question this repository could not
 * answer: whether thirdweb can create a wallet headlessly from a server-chosen
 * identifier and later link it to an email *keeping the same address*. Neither
 * mode waits on that answer, and each is wrong in a different direction, so the
 * choice is configuration rather than a guess baked into the code.
 *
 * `deferred` issues no wallet at all. The student gets an opaque server-side
 * identity, plays, and receives an address only if they later add an email —
 * at which point it is a brand-new address that nothing has been minted to, so
 * "the address must not change" is satisfied by there being nothing to change.
 * The cost is that a class-code student cannot hold an on-chain certificate
 * until they upgrade. The gain is that thirdweb is absent from the onboarding
 * hour entirely, which is the concentrated risk in OQ-03: a class of 32
 * students onboarding during one lesson is exactly when a third-party outage
 * cannot be worked around.
 *
 * `thirdweb` provisions through thirdweb's custom-auth flow so the address
 * exists from the first minute and account linking preserves it. It matches
 * TRD-AUTH-005 as literally written, at the price of putting thirdweb back on
 * the critical path.
 *
 * **What both must produce is identical**: a stable custom id and, optionally,
 * a wallet address. Everything downstream — the assertion, the Nakama hook, the
 * profile row — is written once against that shape and never branches on which
 * mode ran. Two identity modes is one more than anybody wants; confining the
 * difference to this file is what keeps it from becoming two auth systems.
 */

import { createHash, createHmac } from 'node:crypto';

export type ProvisionerMode = 'deferred' | 'thirdweb';

export interface ProvisionedIdentity {
  /** What Nakama's `authenticateCustom` is called with. */
  customId: string;
  /** Null when this identity has no wallet yet. */
  walletAddress: string | null;
}

export interface ClassCodeProvisioner {
  readonly mode: ProvisionerMode;
  provision(seed: string): Promise<ProvisionedIdentity>;
}

/**
 * No wallet until the student asks for one.
 *
 * The custom id is a hash of the seed rather than the seed itself. The seed
 * would work, but it is the value a `thirdweb`-mode deployment hands to a third
 * party as an account key, and using the same string as a public identifier in
 * one mode and a secret in the other is the sort of asymmetry that survives
 * until the day the modes are swapped.
 *
 * Hashing also makes provisioning idempotent within the grant's lifetime: a
 * retry after a dropped response yields the same account rather than a second
 * one, and a student on a bus with one bar retries constantly.
 */
export class DeferredProvisioner implements ClassCodeProvisioner {
  readonly mode = 'deferred' as const;

  async provision(seed: string): Promise<ProvisionedIdentity> {
    const digest = createHash('sha256').update(`lenterra:class-code:${seed}`).digest('hex');
    return { customId: `lc_${digest.slice(0, 32)}`, walletAddress: null };
  }
}

/**
 * A wallet from the first minute, via thirdweb's custom-auth flow.
 *
 * thirdweb mints the in-app wallet for whichever `sub` our JWT names, so the
 * seed becomes the account key and the same seed always resolves to the same
 * address. The JWT is signed with the shared secret configured on the thirdweb
 * side; nothing about the student is in it, because there is nothing about the
 * student to put in it — that is the point of a class-code account.
 *
 * **Unverified against a live integration** (OQ-04). This mode is off by
 * default for that reason, and a deployment turning it on is asserting that the
 * spike has been done. It fails loudly rather than falling back: silently
 * dropping to `deferred` would give some students an address and others none
 * with nothing in the logs to say which.
 */
export class ThirdwebProvisioner implements ClassCodeProvisioner {
  readonly mode = 'thirdweb' as const;

  constructor(
    private readonly secretKey: string,
    private readonly authSecret: string,
    private readonly endpoint: string,
  ) {}

  async provision(seed: string): Promise<ProvisionedIdentity> {
    const now = Math.floor(Date.now() / 1000);
    const jwt = signHs256(
      { sub: seed, iat: now, exp: now + 120, iss: 'lenterra-verifier' },
      this.authSecret,
    );

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-secret-key': this.secretKey,
      },
      body: JSON.stringify({ jwt, strategy: 'jwt' }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`thirdweb provisioning failed with ${response.status}`);
    }

    const body = (await response.json()) as { walletAddress?: unknown; address?: unknown };
    const address = typeof body.walletAddress === 'string' ? body.walletAddress : body.address;

    if (typeof address !== 'string' || !address.startsWith('0x')) {
      // A response we cannot read is not a wallet we can hand a student. Better
      // a failed sign-in now than an account keyed to something that is not an
      // address, discovered when a certificate is minted a year later.
      throw new Error('thirdweb provisioning returned no address');
    }

    return { customId: address.toLowerCase(), walletAddress: address.toLowerCase() };
  }
}

/** Compact HS256 JWS. thirdweb's custom-auth expects exactly this shape. */
function signHs256(claims: Record<string, unknown>, secret: string): string {
  const b64 = (value: string) => Buffer.from(value).toString('base64url');
  const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/**
 * Pick the mode from the environment, and refuse to start if it cannot work.
 *
 * Validated here rather than at the first sign-in, for the same reason the
 * assertion secret is: a service that starts happily and then fails every
 * student is a service whose configuration error is discovered by a classroom.
 */
export function provisionerFromEnv(env: NodeJS.ProcessEnv): ClassCodeProvisioner {
  const mode = (env['CLASS_CODE_PROVISIONER'] ?? 'deferred') as ProvisionerMode;

  if (mode === 'deferred') return new DeferredProvisioner();

  if (mode === 'thirdweb') {
    const secretKey = env['THIRDWEB_SECRET_KEY'];
    const authSecret = env['THIRDWEB_AUTH_JWT_SECRET'];
    if (!secretKey || !authSecret) {
      throw new Error(
        'CLASS_CODE_PROVISIONER=thirdweb requires THIRDWEB_SECRET_KEY and THIRDWEB_AUTH_JWT_SECRET',
      );
    }
    return new ThirdwebProvisioner(
      secretKey,
      authSecret,
      env['THIRDWEB_AUTH_ENDPOINT'] ?? 'https://in-app-wallet.thirdweb.com/api/2023-11-30/embedded-wallet/authenticate',
    );
  }

  throw new Error(`CLASS_CODE_PROVISIONER must be 'deferred' or 'thirdweb', not '${mode}'`);
}
