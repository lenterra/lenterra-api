/**
 * Catalog manifest and pull.
 *
 * `changed` in the manifest is what makes the difference between a 40 KB and a
 * 4 MB update on a metered connection, which for the target student is the
 * difference between updating and not updating (PRD-ACC-007).
 */

import { invalidArgument } from '../lib/errors';
import { optionalString, requireArray, requireString, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { catalogParts, currentCatalog, type ManifestPart } from '../domain/catalog';

/** Responses are capped so a slow connection is never handed an unbounded body. */
export const MAX_PULL_BYTES = 2 * 1024 * 1024;

/**
 * Parts the client may never pull.
 *
 * Course checks are graded server-side, so the answer key must not be in the
 * bundle on the device — otherwise a student can read the answers out of the
 * cache and the check stops being evidence of anything. The part still appears
 * in the manifest, because hiding its existence would make a byte-count
 * mismatch look like corruption.
 */
export const SERVER_ONLY_PARTS = ['checks.answers'];

export interface ManifestReq {
  haveVersion?: string;
}

export interface ManifestRes {
  version: string;
  parts: {
    part: string;
    sha256: string;
    bytes: number;
    changed: boolean;
    /**
     * Whether a client may pull this part.
     *
     * The flag is on the wire rather than a constant the client also keeps,
     * because a duplicated list of what must stay server-side is a list that
     * eventually disagrees with itself — and the half that is wrong is the
     * client's, which is the one an attacker reads.
     */
    available: boolean;
  }[];
  totalBytes: number;
  changedBytes: number;
}

export function catalogManifest(c: Ctx, req: ManifestReq): ManifestRes {
  const catalog = currentCatalog(c);
  const parts = catalogParts(c, catalog.version);

  const have = optionalString(req.haveVersion, 'haveVersion', 128);
  const previous: Record<string, string> = {};

  if (have && have !== catalog.version) {
    const previousParts = catalogParts(c, have);
    for (let i = 0; i < previousParts.length; i++) {
      const part = previousParts[i] as ManifestPart;
      previous[part.part] = part.sha256;
    }
  }

  const out: ManifestRes['parts'] = [];
  let totalBytes = 0;
  let changedBytes = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as ManifestPart;
    // No `haveVersion` means a first install: everything is changed.
    const changed = !have || previous[part.part] !== part.sha256;
    totalBytes += part.bytes;
    if (changed) changedBytes += part.bytes;
    out.push({
      part: part.part,
      sha256: part.sha256,
      bytes: part.bytes,
      changed,
      available: SERVER_ONLY_PARTS.indexOf(part.part) < 0,
    });
  }

  return { version: catalog.version, parts: out, totalBytes, changedBytes };
}

export interface CatalogPullReq {
  version: string;
  parts: string[];
}

export interface CatalogPullRes {
  version: string;
  parts: { part: string; sha256: string; body: unknown }[];
}

export function catalogPull(c: Ctx, req: CatalogPullReq): CatalogPullRes {
  const version = requireString(req.version, 'version', 128);
  const parts = requireArray<string>(req.parts, 'parts', 64);

  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const name = requireString(parts[i], 'parts[]', 128);
    if (SERVER_ONLY_PARTS.indexOf(name) >= 0) {
      throw invalidArgument('That content part is not available to clients', { part: name });
    }
    names.push(name);
  }
  if (names.length === 0) throw invalidArgument('parts must not be empty');

  // Reject an oversized request rather than truncating it. A client that
  // silently receives half a catalog will fail validation later with a
  // confusing reason instead of a clear one now.
  const available = catalogParts(c, version);
  let requestedBytes = 0;
  for (let i = 0; i < available.length; i++) {
    const part = available[i] as ManifestPart;
    if (names.indexOf(part.part) >= 0) requestedBytes += part.bytes;
  }
  if (requestedBytes > MAX_PULL_BYTES) {
    throw invalidArgument('Requested parts exceed the response limit; split the request', {
      limitBytes: MAX_PULL_BYTES,
      requestedBytes,
    });
  }

  const rows = c.nk.sqlQuery(Q.catalogPull, [version, names]) as {
    part: string;
    sha256: string;
    body: unknown;
  }[];

  const out: CatalogPullRes['parts'] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { part: string; sha256: string; body: unknown };
    out.push({ part: row.part, sha256: row.sha256, body: row.body });
  }

  return { version, parts: out };
}
