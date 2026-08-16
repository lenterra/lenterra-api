/**
 * Engine lookup by game and version (TRD-ENG-007).
 *
 * The failure mode that *will* happen: a phone runs core 1.2 while the server
 * runs 1.3, and a rule changed between them. The primary defence is not a
 * forced upgrade — it is this registry. An attempt played under 1.2 is
 * validated by 1.2, so shipping a rules fix does not invalidate every attempt
 * sitting in every offline queue, which would punish exactly the students the
 * offline design exists to serve.
 */

import type { GameId } from '../types/mission';
import type { GameEngine } from './types';
import { congklakEngine } from './congklak';
import { bentengEngine } from './benteng';

/** Engine versions are supported for 180 days — far longer than any offline period. */
export const SUPPORT_WINDOW_DAYS = 180;

type AnyEngine = GameEngine<never, never>;

const ENGINES: Record<GameId, Record<string, unknown>> = {
  congklak: { [congklakEngine.version]: congklakEngine },
  benteng: { [bentengEngine.version]: bentengEngine },
};

const CURRENT: Record<GameId, string> = {
  congklak: congklakEngine.version,
  benteng: bentengEngine.version,
};

/** The engine a replay should be validated by, or null if unsupported. */
export function engineFor(gameId: GameId, version?: string): AnyEngine | null {
  const byVersion = ENGINES[gameId];
  if (!byVersion) return null;
  const key = version ?? CURRENT[gameId];
  const engine = byVersion[key];
  return (engine as AnyEngine | undefined) ?? null;
}

export function currentEngine(gameId: GameId): AnyEngine | null {
  return engineFor(gameId);
}

export function currentVersion(gameId: GameId): string {
  return CURRENT[gameId];
}

export function supportedVersions(gameId: GameId): string[] {
  const byVersion = ENGINES[gameId];
  return byVersion ? Object.keys(byVersion).sort() : [];
}

/**
 * Register a retired engine version so historical replays keep validating.
 *
 * Called at module load when a behavioural change ships: the previous
 * implementation is kept alongside the new one rather than deleted.
 */
export function registerEngine(engine: AnyEngine): void {
  const byVersion = ENGINES[engine.gameId];
  if (byVersion) byVersion[engine.version] = engine;
}
