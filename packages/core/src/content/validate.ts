/**
 * Content validation (10-12 PRD-CNT-002).
 *
 * Runs in CI before a mission can be merged, and again server-side before a
 * catalog version can be published. Both call this function, because content
 * that reached production without passing is content nobody validated.
 *
 * The checks that need a solver — solvability, difficulty sanity, greedy-trap
 * verification — live in `content/solver.ts`, since they need to play the game
 * and these do not.
 */

import type { Mission } from '../types/mission';
import { primaryNodeOf } from '../types/mission';
import { isSkillNodeId, type SkillNodeId } from '../types/taxonomy';

export type ContentIssueSeverity = 'error' | 'warning';

export interface ContentIssue {
  severity: ContentIssueSeverity;
  check: string;
  missionId: string;
  message: string;
}

export const WEIGHT_SUM_TOLERANCE = 0.001;
export const PRIMARY_WEIGHT_MIN = 0.4;
/** Below this a node is incidental; above it the mechanic must require the skill. */
export const INCIDENTAL_WEIGHT_MAX = 0.2;

/**
 * Validate one mission.
 *
 * @param known Rationales already seen, so duplicates across missions are
 *   caught. A rationale copy-pasted between missions is the tell that the skill
 *   mapping was not thought about for the second one.
 */
export function validateMission(mission: Mission, known?: Set<string>): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const add = (severity: ContentIssueSeverity, check: string, message: string): void => {
    issues.push({ severity, check, missionId: mission.id, message });
  };

  // --- schema-ish shape --------------------------------------------------
  if (!mission.id || mission.id.indexOf('.') < 0) {
    add('error', 'schema', 'mission id must be "<game>.<slug>"');
  }
  if (mission.id && mission.id.slice(0, mission.id.indexOf('.')) !== mission.game) {
    add('error', 'schema', `id prefix does not match game "${mission.game}"`);
  }
  if (!Number.isInteger(mission.rank) || mission.rank < 1) {
    add('error', 'schema', 'rank must be a positive integer');
  }
  if (!Number.isInteger(mission.contentVersion) || mission.contentVersion < 1) {
    add('error', 'schema', 'contentVersion must be a positive integer');
  }
  if (!Number.isFinite(mission.eloDifficulty)) {
    add('error', 'schema', 'eloDifficulty must be a number');
  }
  if (!Number.isInteger(mission.seed)) {
    // Mission design rule 5: no randomness outside a seeded PRNG whose seed is
    // part of the definition — otherwise replay validation is impossible.
    add('error', 'schema', 'seed must be an integer; determinism depends on it');
  }
  if (mission.setup.game !== mission.game) {
    add('error', 'schema', 'setup.game does not match the mission game');
  }

  // --- weights -----------------------------------------------------------
  const nodes = Object.keys(mission.skillWeights) as SkillNodeId[];
  let total = 0;
  let primaryCount = 0;

  if (nodes.length === 0) {
    add('error', 'weights', 'skillWeights is empty; a mission with no weights evidences nothing');
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as SkillNodeId;
    const weight = mission.skillWeights[node] ?? 0;

    if (!isSkillNodeId(node)) {
      add('error', 'node_references', `unknown skill node "${node}"`);
    }
    if (!(weight > 0) || weight > 1) {
      add('error', 'weights', `weight for "${node}" must be in (0, 1]`);
    }
    total += weight;
    if (weight >= PRIMARY_WEIGHT_MIN) primaryCount++;
  }

  if (Math.abs(total - 1) > WEIGHT_SUM_TOLERANCE) {
    add('error', 'weights', `skillWeights sums to ${total.toFixed(4)}, expected 1.0`);
  }

  // Design rule 1: one primary node. A mission that teaches "a bit of
  // everything" produces uninformative evidence.
  if (primaryCount !== 1) {
    add(
      'error',
      'primary_skill',
      `expected exactly one node with weight ≥ ${PRIMARY_WEIGHT_MIN}, found ${primaryCount}`,
    );
  }

  // --- rationale ---------------------------------------------------------
  const rationale = (mission.rationale ?? '').trim();
  if (rationale.length === 0) {
    add('error', 'rationale', 'rationale is required');
  } else {
    if (rationale.length < 20) {
      add('error', 'rationale', 'rationale is too short to name a mechanic');
    }
    if (known) {
      const key = rationale.toLowerCase();
      if (known.has(key)) {
        add('error', 'rationale', 'rationale is duplicated from another mission');
      } else {
        known.add(key);
      }
    }
    // The anti-skin rule (PRD-LRN-002): a mission may not claim a skill
    // because its artwork mentions it. The rationale has to name the mechanic.
    if (!namesAMechanic(rationale)) {
      add(
        'warning',
        'rationale',
        'rationale does not appear to name a game mechanic; review the skill mapping',
      );
    }
  }

  // --- diagnostics -------------------------------------------------------
  // Design rule 2: a student who cannot name their mistake cannot correct it.
  const diagnostics = Object.keys(mission.failureKeys ?? {});
  if (diagnostics.length === 0) {
    add('error', 'diagnostics', 'at least one authored failure diagnostic is required');
  }

  // --- strings -----------------------------------------------------------
  if (!mission.titleKey) add('error', 'strings', 'titleKey is required');
  if (!mission.briefKey) add('error', 'strings', 'briefKey is required');

  // --- bounded length ----------------------------------------------------
  // Design rule 4: a mission fits in 2–5 minutes. A student on a borrowed
  // phone has a 40-minute window and shares the device.
  const maxMoves = mission.constraints.maxMoves;
  if (maxMoves !== undefined && (!Number.isInteger(maxMoves) || maxMoves < 1)) {
    add('error', 'schema', 'constraints.maxMoves must be a positive integer when present');
  }
  if (maxMoves !== undefined && maxMoves > 200) {
    add('warning', 'reading_time', `maxMoves ${maxMoves} is unlikely to fit a 2–5 minute session`);
  }

  return issues;
}

/**
 * Validate a whole catalog of missions, including cross-mission rules.
 */
export function validateMissionSet(missions: Mission[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const rationales = new Set<string>();
  const seenIds = new Set<string>();
  const ranksByGame: Record<string, number[]> = {};

  for (let i = 0; i < missions.length; i++) {
    const mission = missions[i] as Mission;
    const missionIssues = validateMission(mission, rationales);
    for (let j = 0; j < missionIssues.length; j++) {
      issues.push(missionIssues[j] as ContentIssue);
    }

    const key = `${mission.id}@${mission.contentVersion}`;
    if (seenIds.has(key)) {
      issues.push({
        severity: 'error',
        check: 'schema',
        missionId: mission.id,
        message: 'duplicate mission id and content version',
      });
    }
    seenIds.add(key);

    const ranks = ranksByGame[mission.game] ?? [];
    ranks.push(mission.rank);
    ranksByGame[mission.game] = ranks;
  }

  // Ladder integrity: ranks must be contiguous from 1. A gap means a mission
  // was removed and the selector's "highest unlocked rank + 1" (PRD-LRN-007)
  // would silently stop unlocking.
  const games = Object.keys(ranksByGame).sort();
  for (let i = 0; i < games.length; i++) {
    const game = games[i] as string;
    const ranks = (ranksByGame[game] as number[]).slice().sort((a, b) => a - b);
    for (let r = 0; r < ranks.length; r++) {
      if ((ranks[r] as number) !== r + 1) {
        issues.push({
          severity: 'error',
          check: 'schema',
          missionId: game,
          message: `ladder ranks are not contiguous from 1 (saw ${ranks.join(',')})`,
        });
        break;
      }
    }
  }

  return issues;
}

/**
 * Congklak's greedy-trap quota: at least a third of the ladder must be
 * constructed so the highest-seed pit is the wrong choice.
 *
 * `algo.greedy` is the single most valuable transfer concept in the game —
 * discovering that the fullest pit loses is discovering the limits of greedy
 * algorithms — and a quota is the only thing that stops it eroding as content
 * is added.
 */
export function checkGreedyTrapQuota(
  missions: Mission[],
  verifiedTraps: Set<string>,
): ContentIssue[] {
  const congklak = missions.filter((m) => m.game === 'congklak');
  if (congklak.length === 0) return [];

  let traps = 0;
  for (let i = 0; i < congklak.length; i++) {
    if (verifiedTraps.has((congklak[i] as Mission).id)) traps++;
  }

  const required = Math.ceil(congklak.length / 3);
  if (traps >= required) return [];

  return [
    {
      severity: 'error',
      check: 'greedy_trap_quota',
      missionId: 'congklak',
      message: `${traps} verified greedy traps of ${congklak.length} missions; at least ${required} required`,
    },
  ];
}

export function hasErrors(issues: ContentIssue[]): boolean {
  for (let i = 0; i < issues.length; i++) {
    if ((issues[i] as ContentIssue).severity === 'error') return true;
  }
  return false;
}

/** Primary node of a mission, or null when weights are malformed. */
export function primaryNodeOfMission(mission: Mission): SkillNodeId | null {
  return primaryNodeOf(mission.skillWeights);
}

/**
 * Does the rationale reference an actual game mechanic?
 *
 * A keyword check, deliberately. It cannot judge pedagogy — that is what the
 * two-reviewer rule is for (PRD-CNT-005) — but it does catch the specific
 * failure it is aimed at: a rationale that restates the skill name instead of
 * naming the mechanic that produces the evidence.
 */
const MECHANIC_TERMS = [
  'sow', 'sowing', 'seed', 'seeds', 'pit', 'pits', 'store', 'lumbung', 'biji',
  'capture', 'menembak', 'chain', 'continuation', 'extra turn', 'wrap', 'lap',
  'landing', 'opposite', 'sweep', 'row',
  'base', 'benteng', 'freshness', 'fresh', 'stale', 'refresh', 'touch',
  'prisoner', 'tawanan', 'rescue', 'exposure', 'exposed', 'grid', 'unit',
  'move', 'turn', 'board',
];

function namesAMechanic(rationale: string): boolean {
  const lower = rationale.toLowerCase();
  for (let i = 0; i < MECHANIC_TERMS.length; i++) {
    if (lower.indexOf(MECHANIC_TERMS[i] as string) >= 0) return true;
  }
  return false;
}
