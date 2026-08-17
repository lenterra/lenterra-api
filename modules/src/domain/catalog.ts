/**
 * Catalog access.
 *
 * Missions are content, not code (PRD-LRN-001). The server reads them from the
 * catalog tables and hands them to the shared engine, so a mission can be
 * retuned or a label corrected without a server deploy — and so the definition
 * the server validates against is exactly the one the client played.
 */

import type { Mission, MissionSummary, SkillNodeId } from '@lenterra/core';
import { primaryNodeOf } from '@lenterra/core';

import { catalogStale, notFound } from '../lib/errors';
import type { Ctx } from '../lib/ctx';
import { Q } from '../db/queries';

export interface CatalogVersion {
  version: string;
  manifest: Record<string, unknown>;
}

export function currentCatalog(c: Ctx): CatalogVersion {
  const rows = c.nk.sqlQuery(Q.currentCatalog, []);
  if (rows.length === 0) {
    // No published content at all. This is an operational failure, not a
    // client error, and saying so plainly beats an empty mission list that
    // looks like the student has finished everything.
    throw notFound('No content has been published yet');
  }
  const row = rows[0] as { version: string; manifest: Record<string, unknown> };
  return { version: row.version, manifest: row.manifest ?? {} };
}

interface MissionRow {
  mission_id: string;
  content_version: number;
  game_id: string;
  rank: number;
  skill_weights: Partial<Record<SkillNodeId, number>>;
  definition: Record<string, unknown>;
  rating?: number;
}

/**
 * Rebuild a Mission from its stored definition.
 *
 * The definition column holds exactly what content authoring produced, so the
 * shape here mirrors the authored file rather than the database columns.
 */
function toMission(row: MissionRow): Mission {
  const definition = row.definition as Partial<Mission>;
  return {
    id: row.mission_id,
    game: row.game_id as Mission['game'],
    rank: row.rank,
    contentVersion: row.content_version,
    skillWeights: row.skill_weights,
    eloDifficulty: (definition.eloDifficulty as number) ?? 1000,
    goal: definition.goal as Mission['goal'],
    setup: definition.setup as Mission['setup'],
    constraints: (definition.constraints as Mission['constraints']) ?? {},
    config: (definition.config as Mission['config']) ?? {},
    seed: (definition.seed as number) ?? 0,
    rationale: (definition.rationale as string) ?? '',
    titleKey: (definition.titleKey as string) ?? '',
    briefKey: (definition.briefKey as string) ?? '',
    hintKeys: (definition.hintKeys as string[]) ?? [],
    failureKeys: (definition.failureKeys as Record<string, string>) ?? {},
  };
}

/**
 * Load a mission for validation.
 *
 * A replay declaring a catalog version that is no longer current is not an
 * error — the student may have been offline for a week. It is only an error if
 * that version's definition is gone, which is why CATALOG_STALE is separate
 * from VALIDATION_FAILED: the first is recoverable and must not lose the
 * attempt, the second is terminal (20-09).
 */
export function loadMission(
  c: Ctx,
  missionId: string,
  contentVersion: number,
  catalogVersion: string,
): Mission {
  const rows = c.nk.sqlQuery(Q.missionById, [missionId, contentVersion, catalogVersion]);
  if (rows.length === 0) {
    const current = currentCatalog(c);
    if (current.version !== catalogVersion) throw catalogStale(current.version);
    throw notFound('Unknown mission');
  }
  return toMission(rows[0] as MissionRow);
}

/** Compact summaries for the selector — full definitions are not needed to rank. */
export function missionSummaries(c: Ctx, catalogVersion: string): MissionSummary[] {
  const rows = c.nk.sqlQuery(Q.missionsForCatalog, [catalogVersion]) as MissionRow[];
  const out: MissionSummary[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as MissionRow;
    const primary = primaryNodeOf(row.skill_weights);
    if (!primary) continue; // malformed content; content validation rejects it

    out.push({
      id: row.mission_id,
      gameId: row.game_id as MissionSummary['gameId'],
      contentVersion: row.content_version,
      rank: row.rank,
      rating: Number(row.rating ?? 1000),
      primaryNode: primary,
      skillWeights: row.skill_weights,
    });
  }
  return out;
}

export interface ManifestPart {
  part: string;
  sha256: string;
  bytes: number;
}

export function catalogParts(c: Ctx, version: string): ManifestPart[] {
  const rows = c.nk.sqlQuery(Q.catalogParts, [version]) as ManifestPart[];
  const out: ManifestPart[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as ManifestPart;
    out.push({ part: row.part, sha256: row.sha256, bytes: Number(row.bytes) });
  }
  return out;
}

/**
 * Read one catalog part on the server.
 *
 * Used for content the *server* needs rather than the device — teaching notes
 * are read by the dashboard through an RPC, because the dashboard has no
 * catalog cache and no reason to grow one for seventeen paragraphs.
 */
export function catalogPart<T>(c: Ctx, version: string, part: string): T | null {
  const rows = c.nk.sqlQuery(Q.catalogPartBody, [version, part]) as { body: T }[];
  return rows.length > 0 ? (rows[0] as { body: T }).body : null;
}
