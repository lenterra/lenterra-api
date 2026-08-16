/**
 * Replay recording.
 *
 * Lives in the core rather than the app so that the thing the client produces
 * and the thing the server re-executes are built by the same code. A recorder
 * written separately in the app is how a `finalStateHash` ends up computed over
 * a slightly different state than the validator reaches, and every honest
 * offline attempt gets rejected.
 *
 * Time is injected, never read. `elapsedMs` comes from the caller because the
 * core must not touch a clock (TRD-ENG-001).
 */

import type { Mission } from '../types/mission';
import type { AttemptOutcome, Replay, ReplayMove } from '../types/attempt';
import type { GameEngine } from './types';
import { hashConfig } from './validate';

export class ReplayRecorder<S, M> {
  private readonly engine: GameEngine<S, M>;
  private readonly mission: Mission;
  private readonly moves: ReplayMove[] = [];
  private current: S;

  constructor(engine: GameEngine<S, M>, mission: Mission) {
    this.engine = engine;
    this.mission = mission;
    this.current = engine.init(mission.setup, mission.config);
  }

  get state(): S {
    return this.current;
  }

  get moveCount(): number {
    return this.moves.length;
  }

  /**
   * Apply a move and record it.
   *
   * Returns the engine's `MoveResult` so the caller can drive the animation
   * from the event list. Throws on an illegal move rather than recording it —
   * an illegal move in a replay is a validation failure later, and failing here
   * turns it into a bug the developer sees instead of a rejection the student
   * sees.
   */
  play(move: M, actor: 'player' | 'opponent' | 'ai', elapsedMs: number) {
    if (actor !== 'ai' && !this.engine.isLegal(this.current, move)) {
      throw new Error('ReplayRecorder: illegal move');
    }
    const result = this.engine.applyMove(this.current, move);
    this.moves.push({ seq: this.moves.length, actor, move: move as unknown, elapsedMs });
    this.current = result.state;
    return result;
  }

  /** Ask the deterministic opponent for its move in the current position. */
  aiMove(): M | null {
    return this.engine.aiMove(
      this.current,
      this.mission.constraints.aiTier ?? 'sedang',
      this.mission.seed,
    );
  }

  isTerminal(): boolean {
    return this.engine.evaluateGoal(this.current, this.mission.goal).terminal;
  }

  /**
   * What the play actually achieved.
   *
   * The client uses this to score provisionally and show the student a result
   * immediately; the server reaches the same conclusion independently. They
   * agree because it is the same function, not because the client is trusted.
   */
  outcome(): AttemptOutcome {
    const status = this.engine.evaluateGoal(this.current, this.mission.goal);
    return status.achieved ? 'success' : status.terminal ? 'failure' : 'abandoned';
  }

  finish(claimedOutcome?: AttemptOutcome): Replay {
    return {
      gameId: this.mission.game,
      missionId: this.mission.id,
      missionContentVersion: this.mission.contentVersion,
      engineVersion: this.engine.version,
      configHash: hashConfig(this.mission),
      seed: this.mission.seed,
      moves: this.moves.slice(),
      finalStateHash: this.engine.hash(this.current),
      claimedOutcome: claimedOutcome ?? this.outcome(),
    };
  }
}

/** Convenience for tests and fixtures: play a scripted list of moves. */
export function recordReplay<S, M>(
  engine: GameEngine<S, M>,
  mission: Mission,
  script: { move: M; actor: 'player' | 'opponent' | 'ai'; elapsedMs: number }[],
): Replay {
  const recorder = new ReplayRecorder(engine, mission);
  for (let i = 0; i < script.length; i++) {
    const step = script[i] as { move: M; actor: 'player' | 'opponent' | 'ai'; elapsedMs: number };
    recorder.play(step.move, step.actor, step.elapsedMs);
    if (recorder.isTerminal()) break;
  }
  return recorder.finish();
}
