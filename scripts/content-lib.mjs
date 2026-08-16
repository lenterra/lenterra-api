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

export function loadStrings(locale) {
  const path = join(contentDir, 'strings', `${locale}.yaml`);
  if (!existsSync(path)) return {};
  return yaml.load(readFileSync(path, 'utf8')) ?? {};
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
