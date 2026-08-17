/**
 * Loading and checking authored content.
 *
 * Shared by the validate CLI and the publish script, so a mission cannot be
 * published having passed a weaker set of checks than CI ran.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';

import {
  bentengEngine,
  checkGreedyTrap,
  congklakEngine,
  estimateDifficulty,
  hasErrors,
  solve,
  validateMissionSet,
  verifyLine,
} from '../packages/core/dist/index.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const contentDir = join(root, 'content');

export function engineFor(game) {
  return game === 'benteng' ? bentengEngine : congklakEngine;
}

/** Read every mission file for a game, in ladder order. */
export function loadMissions(game) {
  const dir = join(contentDir, 'missions', game);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => {
      const parsed = yaml.load(readFileSync(join(dir, f), 'utf8'));
      return { file: f, mission: parsed };
    });
}

/**
 * Teaching notes, one per skill node (PRD-TCH-012).
 *
 * Authored alongside the missions rather than written into the dashboard,
 * because a note about what students typically get wrong is content that has
 * to be reviewed by someone who has taught the age group — and a wrong note
 * sends a lesson in the wrong direction with more confidence than no note.
 */
/**
 * Read a YAML file that is allowed not to exist, and allowed to be empty.
 *
 * `yaml.load('')` throws in this version rather than returning nothing, so a
 * content file somebody has created but not written yet would take down every
 * check with a parse error instead of being treated as the absent content it
 * is.
 */
function loadYaml(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (text.trim().length === 0) return {};
  return yaml.load(text) ?? {};
}

export function loadTeachingNotes() {
  return loadYaml(join(contentDir, 'teaching', 'notes.yaml'));
}

/**
 * Check the notes against the missions that actually exist.
 *
 * A note pointing at an unauthored mission is a warning, not an error: content
 * ships incrementally, and a Benteng note written before the Benteng ladder is
 * correct in advance rather than broken.
 */
export function checkTeachingNotes(allMissionIds) {
  const notes = loadTeachingNotes();
  const issues = [];
  const known = new Set(allMissionIds);

  for (const [node, note] of Object.entries(notes)) {
    if (!note || typeof note !== 'object') {
      issues.push({ severity: 'error', check: 'teaching', missionId: node, message: 'note is not an object' });
      continue;
    }
    for (const field of ['misconception', 'howToTeach']) {
      const value = note[field];
      if (typeof value !== 'string' || value.trim().length < 40) {
        // A one-line note is worse than none: it reads as guidance and is not.
        issues.push({
          severity: 'error',
          check: 'teaching',
          missionId: node,
          message: `${field} is missing or too short to be useful`,
        });
      }
    }
    for (const missionId of note.missions ?? []) {
      if (!known.has(missionId)) {
        issues.push({
          severity: 'warning',
          check: 'teaching',
          missionId: node,
          message: `suggests "${missionId}", which is not authored yet`,
        });
      }
    }
  }

  return issues;
}

export function loadStrings(locale) {
  return loadYaml(join(contentDir, 'strings', `${locale}.yaml`));
}

/** @param dir Overridden by tests, so a candidate catalogue can be checked without editing the real one. */
export function loadRewards(dir = contentDir) {
  return loadYaml(join(dir, 'rewards', 'catalog.yaml'));
}

function loadStringsFrom(dir, locale) {
  return loadYaml(join(dir, 'strings', `${locale}.yaml`));
}

/** What a reward may be. Anything affecting play is deliberately absent. */
const REWARD_KINDS = ['avatar_color', 'board_skin', 'title'];

/**
 * Check the reward catalogue.
 *
 * The cost check is an error rather than a warning because of what the server
 * does with it: `rewardRedeem` debits `item.cost` from a ledger. A zero would
 * make an item free forever, and a negative one would *award* points for taking
 * it — a balance that grows every time a student redeems.
 *
 * A missing string is an error too. The name is the only thing a student sees;
 * an item whose name is missing renders as its id, and `board.congklak.kayu` in
 * a shop is indistinguishable from a bug.
 */
export function checkRewards(dir = contentDir, locales = ['id', 'en']) {
  const rewards = loadRewards(dir);
  const issues = [];
  const ids = Object.keys(rewards);

  if (ids.length === 0) {
    // Not an error. The catalogue is optional content, and the server refuses
    // redemptions cleanly when no part is published.
    return { rewards, issues };
  }

  const strings = {};
  for (const locale of locales) strings[locale] = flattenKeys(loadStringsFrom(dir, locale));

  for (const [id, item] of Object.entries(rewards)) {
    const where = `reward ${id}`;

    if (!item || typeof item !== 'object') {
      issues.push({ level: 'error', rule: 'reward_shape', where, message: 'is not a mapping' });
      continue;
    }

    if (!Number.isInteger(item.cost) || item.cost <= 0) {
      issues.push({
        level: 'error',
        rule: 'reward_cost',
        where,
        message: `cost must be a positive whole number, got ${JSON.stringify(item.cost)}`,
      });
    }

    if (!REWARD_KINDS.includes(item.kind)) {
      issues.push({
        level: 'error',
        rule: 'reward_kind',
        where,
        message: `kind must be one of ${REWARD_KINDS.join(', ')}, got ${JSON.stringify(item.kind)}`,
      });
    }

    if (typeof item.value !== 'string' || item.value.length === 0) {
      issues.push({ level: 'error', rule: 'reward_value', where, message: 'value must be a string' });
    }

    for (const locale of locales) {
      if (typeof strings[locale][`reward.${id}`] !== 'string') {
        issues.push({
          level: locale === 'id' ? 'error' : 'warning',
          rule: 'reward_string',
          where,
          // Indonesian is the source locale (ADR-010): a missing English name
          // is a gap somebody notices, a missing Indonesian one is a hole in
          // the version the audience actually reads.
          message: `no reward.${id} string in ${locale}`,
        });
      }
    }
  }

  const values = ids.map((id) => `${rewards[id]?.kind}:${rewards[id]?.value}`);
  for (let i = 0; i < values.length; i += 1) {
    if (values.indexOf(values[i]) !== i) {
      issues.push({
        level: 'error',
        rule: 'reward_duplicate',
        where: `reward ${ids[i]}`,
        message: `duplicates the effect of ${ids[values.indexOf(values[i])]}`,
      });
    }
  }

  return { rewards, issues };
}

/** Flatten `{a: {b: 'x'}}` to `{'a.b': 'x'}` so key lookups are direct. */
export function flattenKeys(object, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenKeys(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

/**
 * Every check in the content validation table (10-12 PRD-CNT-002).
 *
 * Returns issues rather than throwing, so one broken mission does not hide the
 * other nineteen — an author fixing content wants the whole list.
 */
export function checkAll(game, { skipSolver = false } = {}) {
  const loaded = loadMissions(game);
  const missions = loaded.map((entry) => entry.mission);
  const issues = [];

  // --- schema, weights, rationale, diagnostics, ladder ---------------------
  for (const issue of validateMissionSet(missions)) issues.push(issue);

  // --- strings -------------------------------------------------------------
  const id = flattenKeys(loadStrings('id'));
  const en = flattenKeys(loadStrings('en'));

  for (const mission of missions) {
    const referenced = [
      mission.titleKey,
      mission.briefKey,
      ...(mission.hintKeys ?? []),
      ...Object.values(mission.failureKeys ?? {}),
    ].filter(Boolean);

    for (const key of referenced) {
      if (id[key] === undefined) {
        issues.push({
          severity: 'error',
          check: 'strings',
          missionId: mission.id,
          message: `missing Indonesian string for "${key}"`,
        });
      } else if (en[key] === undefined) {
        // English is allowed to lag: Indonesian is the source locale.
        issues.push({
          severity: 'warning',
          check: 'strings',
          missionId: mission.id,
          message: `missing English string for "${key}"`,
        });
      }
    }
  }

  if (skipSolver) return { missions, issues, solved: new Map(), traps: new Set() };

  // --- solvability, difficulty, greedy traps -------------------------------
  const engine = engineFor(game);
  const solved = new Map();
  const traps = new Set();

  for (const mission of missions) {
    // An authored line is checked first and is authoritative for "is this
    // winnable". Search still runs where it is tractable, because the two
    // answer different questions: the line proves a win exists, the search
    // proves the obvious move is not always it.
    if (mission.referenceLine) {
      const verified = verifyLine(engine, mission, mission.referenceLine);
      if (!verified.achieved) {
        issues.push({
          severity: 'error',
          check: 'solvability',
          missionId: mission.id,
          message:
            `the authored solution does not win: ${verified.reason}` +
            (verified.failedAtMove === null ? '' : ` (move ${verified.failedAtMove})`),
        });
      }
      const cap = mission.constraints?.maxMoves;
      if (cap !== undefined && verified.playerMoves > cap) {
        issues.push({
          severity: 'error',
          check: 'solvability',
          missionId: mission.id,
          message: `the authored solution needs ${verified.playerMoves} moves but maxMoves is ${cap}`,
        });
      }
      solved.set(mission.id, {
        solvable: verified.achieved,
        line: mission.referenceLine,
        nodesVisited: 0,
        exhausted: false,
        fromReferenceLine: true,
      });
      continue;
    }

    let result;
    try {
      result = solve(engine, mission, { maxDepth: 10, maxNodes: 120_000 });
    } catch (err) {
      issues.push({
        severity: 'error',
        check: 'solvability',
        missionId: mission.id,
        message: `engine threw: ${err.message}`,
      });
      continue;
    }
    solved.set(mission.id, result);

    if (!result.solvable) {
      // A mission nobody can beat is broken, not hard. A student who fails it
      // six times has learned only that the product is unfair.
      issues.push({
        severity: 'error',
        check: 'solvability',
        missionId: mission.id,
        message: result.exhausted
          ? `no winning line found within the search budget (${result.nodesVisited} nodes)`
          : `proven unsolvable (${result.nodesVisited} nodes searched)`,
      });
      continue;
    }

    const estimate = estimateDifficulty(engine, mission, 300);
    const drift = Math.abs(estimate.impliedElo - mission.eloDifficulty);
    // Skipped when the mission offers almost no choice: random play beats a
    // one-move mission every time and tells us nothing about how hard the
    // *computation* is, which is what an early-ladder mission actually asks.
    if (estimate.informative && drift > 200) {
      issues.push({
        severity: 'warning',
        check: 'difficulty_sanity',
        missionId: mission.id,
        message:
          `declared ELO ${mission.eloDifficulty}, play suggests ~${estimate.impliedElo} ` +
          `(${(estimate.successRate * 100).toFixed(0)}% of naive playouts win)`,
      });
    }

    if (mission.greedyTrap === true) {
      const trap = checkGreedyTrap(engine, mission, { maxDepth: 8, maxNodes: 60_000 });
      if (trap.isTrap) traps.add(mission.id);
      else {
        issues.push({
          severity: 'error',
          check: 'greedy_trap',
          missionId: mission.id,
          message: `declared a greedy trap but is not one: ${trap.reason}`,
        });
      }
    }
  }

  return { missions, issues, solved, traps };
}

export function report(issues) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  for (const issue of errors) {
    console.error(`  ✖ [${issue.check}] ${issue.missionId}: ${issue.message}`);
  }
  for (const issue of warnings) {
    console.warn(`  ! [${issue.check}] ${issue.missionId}: ${issue.message}`);
  }
  return { errors: errors.length, warnings: warnings.length };
}

export { hasErrors };
