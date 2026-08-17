#!/usr/bin/env node
// Replay fixtures for the cross-runtime conformance suite (TRD-TEST-002).
//
// The shared core runs in two places that share no code path: Hermes on the
// phone, where a student's attempt is scored for immediate feedback, and goja
// inside Nakama, where the same attempt is re-executed to decide what it was
// actually worth. Those two agreeing is the entire basis of offline play. If
// they disagree, the failure does not look like a bug — it looks like the
// server calling students cheats, and the students it happens to are the
// offline ones the design exists to serve.
//
// The fixtures are generated from the **real mission ladder** rather than from
// synthetic boards, because a divergence in a rule nobody ships is not worth
// catching and a divergence in mission 7 is.
//
// Determinism is the whole point, so:
//
//  - the RNG is seeded and comes from the core, so it is the same generator
//    both runtimes already use;
//  - nothing reads the clock — elapsed times are computed from the move index;
//  - the output is written sorted, so regenerating produces an identical file
//    and a diff means the *rules* moved.
//
// Run: node scripts/fixtures-generate.mjs

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRng, hashConfig, recordReplay, rngInt, validateReplay } from '../packages/core/dist/index.js';
import { contentDir, engineFor, loadMissions, root } from './content-lib.mjs';

/** Enough to cover every mission many times over with varied play. */
const TARGET_FIXTURES = 500;

/**
 * How many of those are then deliberately broken, one per rejection reason
 * cycled through the set.
 *
 * The rejections matter at least as much as the successes. A runtime that
 * accepts a tampered replay the other rejects is the failure mode with a
 * victim: it means one of the two is scoring work that never happened, and the
 * disagreement surfaces as a teacher looking at numbers that cannot be right.
 */
const TAMPERED = 60;

/** Fixed, so this script produces the same 500 fixtures on every machine. */
const SEED = 20260817;

/**
 * How a fixture picks its moves.
 *
 * Variety matters more than realism here. `greedy` and `worst` reach terminal
 * states quickly and exercise the capture and sweep paths; `random` wanders
 * into positions no author would have written; `optimal` uses the engine's own
 * opponent, which is the code most likely to diverge between runtimes because
 * it is the only part that searches.
 */
const STYLES = ['random', 'greedy', 'worst', 'optimal'];

function pickMove(engine, state, style, rng, tier, seed) {
  const legal = engine.legalMoves(state);
  if (legal.length === 0) return null;

  if (style === 'optimal') {
    // `replay.seed`, because that is exactly what the validator recomputes the
    // opponent's move with. Any other seed produces a replay that fails
    // `ai_divergence` — which is a correct rejection of a bad fixture, not a
    // finding, and 46 of them were drowning the cases that mean something.
    const chosen = engine.aiMove(state, tier, seed);
    return chosen ?? legal[0];
  }

  if (legal.length === 1) return legal[0];
  if (style === 'random') return legal[rngInt(rng, legal.length)];

  // `greedy` takes the first legal move and `worst` the last. Neither is
  // meaningfully good play; what they are is *stable*, which is what a fixture
  // needs — a heuristic that changes would change the fixtures with it and the
  // suite would stop being a comparison of two runtimes.
  return style === 'greedy' ? legal[0] : legal[legal.length - 1];
}

function buildFixture(mission, style, variant, rng) {
  const engine = engineFor(mission.game);
  const tier = mission.constraints?.aiTier ?? 'sedang';

  let state = engine.init(mission.setup, mission.config);
  const script = [];

  for (let move = 0; move < 120; move += 1) {
    if (state.finished) break;

    const sideToMove = engine.sideToMove(state);
    const playerSide = engine.playerSide(state);
    const isPlayer = sideToMove === playerSide;

    const chosen = pickMove(engine, state, isPlayer ? style : 'optimal', rng, tier, mission.seed);
    if (chosen === null) break;

    script.push({
      move: chosen,
      actor: isPlayer ? 'player' : 'ai',
      // Derived from the index rather than the clock: a fixture whose timings
      // changed between runs would make every hash unstable and the suite
      // would be comparing noise. Kept above the implausibility thresholds so
      // fixtures are not all flagged suspicious.
      elapsedMs: 900 + move * 350 + variant * 7,
    });

    state = engine.applyMove(state, chosen).state;
  }

  const replay = recordReplay(engine, mission, script);

  // Validated here so the fixture file records what the rules actually said,
  // not what this generator assumed. A fixture whose expectation was written by
  // hand would pass in both runtimes while both were wrong.
  const result = validateReplay(replay, mission, engine);

  return {
    id: `${mission.id}.${style}.${variant}`,
    missionId: mission.id,
    game: mission.game,
    style,
    replay,
    expected: {
      valid: result.valid,
      reason: result.valid ? null : result.reason,
      outcome: result.valid ? result.outcome : (result.actualOutcome ?? null),
      derivedMetrics: result.valid ? result.derivedMetrics : null,
      suspicious: result.valid ? result.suspicious : null,
    },
  };
}

const missions = [...loadMissions('congklak'), ...loadMissions('benteng')].map((m) => m.mission);
if (missions.length === 0) {
  console.error('no missions found; nothing to generate');
  process.exit(1);
}

const rng = createRng(SEED);
const fixtures = [];
let variant = 0;

// Round-robin over (mission, style) so the set stays balanced however many
// fixtures are asked for — taking them mission by mission would give the whole
// budget to Congklak's twenty missions and leave Benteng thinly covered.
while (fixtures.length < TARGET_FIXTURES) {
  for (const style of STYLES) {
    for (const mission of missions) {
      if (fixtures.length >= TARGET_FIXTURES) break;
      fixtures.push(buildFixture(mission, style, variant, rng));
    }
  }
  variant += 1;
  if (variant > 50) break; // a guard, not an expected exit
}

/**
 * Break a fixture in one specific way.
 *
 * Each returns a replay that must be rejected for exactly one named reason, so
 * a runtime that rejects it for a *different* reason is caught too — "both said
 * no" is not agreement when one of them said no for the wrong reason.
 */
/** A hex digit that is definitely not the one that was there. */
function flipLast(hash) {
  const last = hash.slice(-1);
  return hash.slice(0, -1) + (last === '0' ? '1' : '0');
}

const TAMPERS = {
  sequence_gap: (replay) => {
    if (replay.moves.length < 2) return null;
    const moves = replay.moves.map((m) => ({ ...m }));
    moves[moves.length - 1].seq += 3;
    return { ...replay, moves };
  },
  malformed_replay: (replay) => {
    const moves = replay.moves.map((m) => ({ ...m }));
    moves[moves.length - 1].move = { kind: 'nonsense' };
    return { ...replay, moves };
  },
  config_mismatch: (replay) => ({ ...replay, configHash: flipLast(replay.configHash) }),
  core_version_unsupported: (replay) => ({ ...replay, engineVersion: '99.0.0' }),
  unknown_mission: (replay) => ({ ...replay, missionId: 'congklak.m99' }),
  replay_mismatch: (replay) => ({ ...replay, finalStateHash: flipLast(replay.finalStateHash) }),
  illegal_move: (replay, mission) => {
    // A player move swapped for one on the opponent's row: legal-looking,
    // structurally valid, and not theirs to make.
    const index = replay.moves.findIndex((m) => m.actor === 'player');
    if (index < 0 || mission.game !== 'congklak') return null;
    const moves = replay.moves.map((m) => ({ ...m }));
    const pit = moves[index].move?.pit;
    if (typeof pit !== 'number') return null;
    moves[index] = { ...moves[index], move: { kind: 'sow', pit: pit >= 7 ? pit - 6 : pit + 6 } };
    return { ...replay, moves };
  },
  ai_divergence: (replay) => {
    // The opponent relabelled as a second human. In a solo attempt this is the
    // one that would otherwise let a client hand itself an opponent that plays
    // badly on purpose, so every mission in both ladders would be winnable.
    const index = replay.moves.findIndex((m) => m.actor === 'ai');
    if (index < 0) return null;
    const moves = replay.moves.map((m) => ({ ...m }));
    moves[index] = { ...moves[index], actor: 'opponent' };
    return { ...replay, moves };
  },
};

const missionById = new Map(missions.map((m) => [m.id, m]));
const reasons = Object.keys(TAMPERS);
let made = 0;

for (let i = 0; made < TAMPERED && i < fixtures.length; i += 1) {
  const source = fixtures[i];
  const reason = reasons[made % reasons.length];
  const mission = missionById.get(source.missionId);
  const broken = TAMPERS[reason](source.replay, mission);
  if (broken === null) continue;

  const engine = engineFor(source.game);
  // `unknown_mission` is validated against the mission it *claims*, which is
  // the point: the server looks the mission up by the replay's id.
  const result = validateReplay(broken, mission, engine);
  if (result.valid || result.reason !== reason) {
    // A tamper that does not produce the reason it was written for is a broken
    // fixture, and shipping it would mean the suite asserts the wrong thing.
    console.error(
      `tamper '${reason}' on ${source.id} produced ` +
        `${result.valid ? 'a valid replay' : result.reason}`,
    );
    process.exit(1);
  }

  fixtures.push({
    id: `${source.id}.tampered.${reason}`,
    missionId: source.missionId,
    game: source.game,
    style: `tampered:${reason}`,
    replay: broken,
    expected: { valid: false, reason, outcome: null, derivedMetrics: null, suspicious: null },
  });
  made += 1;
}

if (made < TAMPERED) {
  console.error(`only ${made} of ${TAMPERED} tampered fixtures could be built`);
  process.exit(1);
}

fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const payload = {
  generatedFrom: { seed: SEED, missions: missions.length, styles: STYLES },
  // Written into the file so a fixture set generated against different rules
  // is recognisable rather than silently compared.
  configHashes: Object.fromEntries(missions.map((m) => [m.id, hashConfig(m)])),
  fixtures,
};

const out = join(root, 'test', 'fixtures', 'replays.json');
writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`);

const valid = fixtures.filter((f) => f.expected.valid).length;
console.log(`wrote ${fixtures.length} fixtures to ${out.replace(root, '.')}`);
console.log(`  ${valid} validate, ${fixtures.length - valid} are rejections`);
console.log(`  content dir: ${contentDir.replace(root, '.')}`);
