#!/usr/bin/env node
// Builds a catalog version from authored content and writes it to the database.
//
// Publishing is separate from promoting. A version lands as `draft`, and
// `v1.admin.catalog.publish` promotes it — so content can be staged and
// reviewed against a real server before a single student sees it, and rolling
// back is one promotion of the previous version (PRD-CNT-008).
//
// Nothing is written unless every check passes. Content that reached students
// having skipped validation is content nobody validated.

import { createHash } from 'node:crypto';
import pg from 'pg';

import { checkAll, loadStrings, loadTeachingNotes, report } from './content-lib.mjs';
import { compileCourses } from './course-lib.mjs';
import { checkGreedyTrapQuota, hasErrors } from '../packages/core/dist/index.js';

const GAMES = ['congklak', 'benteng'];

function connectionConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'nakama',
    user: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'localdev',
  };
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * A version identifier derived from the content itself.
 *
 * Content-addressed rather than timestamped: republishing unchanged content
 * produces the same version, so a rerun is a no-op instead of a new row that
 * looks like a change nobody made.
 */
function versionFor(parts) {
  const digest = sha256(parts.map((p) => `${p.part}:${p.sha256}`).join('\n'));
  return `catalog@${digest.slice(0, 12)}`;
}

async function main() {
  const promote = process.argv.includes('--promote');
  const allMissions = [];
  const parts = [];
  let failed = false;

  for (const game of GAMES) {
    const { missions, issues, traps } = checkAll(game);
    if (missions.length === 0) continue;

    const all = issues.slice();
    if (game === 'congklak') {
      for (const issue of checkGreedyTrapQuota(missions, traps)) all.push(issue);
    }

    if (hasErrors(all)) {
      console.error(`\n${game}: refusing to publish`);
      report(all);
      failed = true;
      continue;
    }

    allMissions.push(...missions);
    const body = JSON.stringify(missions);
    parts.push({
      part: `missions.${game}`,
      sha256: sha256(body),
      bytes: Buffer.byteLength(body),
      body: missions,
    });
  }

  if (failed) process.exit(1);
  if (allMissions.length === 0) {
    console.error('no valid content to publish');
    process.exit(1);
  }

  // --- courses -------------------------------------------------------------
  const compiled = compileCourses(allMissions.map((m) => m.id));
  if (hasErrors(compiled.issues)) {
    console.error('\ncourses: refusing to publish');
    report(compiled.issues);
    process.exit(1);
  }

  if (compiled.courses.length > 0) {
    const index = JSON.stringify(compiled.courses);
    parts.push({
      part: 'courses',
      sha256: sha256(index),
      bytes: Buffer.byteLength(index),
      body: compiled.courses,
    });

    // One part per course. A student opening `sec.basics` pulls its five
    // lessons, not all forty — which on a metered connection is the difference
    // between reading a lesson and deciding not to (PRD-CRS-003).
    for (const [name, bodies] of Object.entries(compiled.lessonParts)) {
      const body = JSON.stringify(bodies);
      parts.push({ part: name, sha256: sha256(body), bytes: Buffer.byteLength(body), body: bodies });
    }

    // The answer key. Listed in the manifest so a byte-count mismatch does not
    // look like corruption, and refused by `v1.catalog.pull` (TRD-API-006).
    const answers = JSON.stringify(compiled.answers);
    parts.push({
      part: 'checks.answers',
      sha256: sha256(answers),
      bytes: Buffer.byteLength(answers),
      body: compiled.answers,
    });
  }

  for (const locale of ['id', 'en']) {
    // Course prose is generated from the authored lesson files rather than
    // hand-maintained in `content/strings/`, and merges into the same part so
    // the client has one place to look for any string.
    const strings = { ...loadStrings(locale), ...compiled.strings[locale] };
    const body = JSON.stringify(strings);
    parts.push({
      part: `strings.${locale}`,
      sha256: sha256(body),
      bytes: Buffer.byteLength(body),
      body: strings,
    });
  }

  // Teaching notes ride the catalog like everything else, so a corrected
  // misconception reaches a teacher without an app release (PRD-CNT-007).
  const notes = loadTeachingNotes();
  if (Object.keys(notes).length > 0) {
    const body = JSON.stringify(notes);
    parts.push({
      part: 'teaching',
      sha256: sha256(body),
      bytes: Buffer.byteLength(body),
      body: notes,
    });
  }

  parts.sort((a, b) => (a.part < b.part ? -1 : 1));
  const version = versionFor(parts);

  const client = new pg.Client(connectionConfig());
  await client.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT status FROM lenterra_catalog_version WHERE version = $1',
      [version],
    );
    if (existing.rowCount > 0) {
      console.log(`${version} already published (${existing.rows[0].status}) — content unchanged`);
    } else {
      const manifest = {
        parts: parts.map((p) => ({ part: p.part, sha256: p.sha256, bytes: p.bytes })),
        totalBytes: parts.reduce((sum, p) => sum + p.bytes, 0),
        missions: allMissions.length,
        courses: compiled.courses.length,
        lessons: compiled.lessons.length,
      };

      await client.query(
        `INSERT INTO lenterra_catalog_version (version, status, manifest, notes)
         VALUES ($1, 'draft', $2, $3)`,
        [
          version,
          JSON.stringify(manifest),
          `${allMissions.length} missions, ${compiled.courses.length} courses`,
        ],
      );

      for (const part of parts) {
        await client.query(
          `INSERT INTO lenterra_catalog_part (version, part, sha256, bytes, body)
           VALUES ($1,$2,$3,$4,$5)`,
          [version, part.part, part.sha256, part.bytes, JSON.stringify(part.body)],
        );
      }

      for (const mission of allMissions) {
        await client.query(
          `INSERT INTO lenterra_mission
             (mission_id, content_version, catalog_version, game_id, rank, skill_weights, definition)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            mission.id,
            mission.contentVersion,
            version,
            mission.game,
            mission.rank,
            JSON.stringify(mission.skillWeights),
            JSON.stringify(mission),
          ],
        );

        // Seed the rating so the selector has something to match against before
        // any student has played. It is retuned from real attempts thereafter.
        await client.query(
          `INSERT INTO lenterra_mission_rating (mission_id, content_version, rating)
           VALUES ($1,$2,$3) ON CONFLICT (mission_id, content_version) DO NOTHING`,
          [mission.id, mission.contentVersion, mission.eloDifficulty],
        );
      }

      console.log(
        `published ${version} as draft — ${allMissions.length} missions, ` +
          `${compiled.courses.length} courses, ${compiled.lessons.length} lessons, ${parts.length} parts`,
      );
    }

    if (promote) {
      // One statement, because the partial unique index guarantees exactly one
      // current version and a two-step promotion could briefly have none.
      const result = await client.query(
        `WITH demoted AS (
           UPDATE lenterra_catalog_version SET status = 'rolled_back'
           WHERE status = 'current' AND version <> $1
           RETURNING version
         )
         UPDATE lenterra_catalog_version
         SET status = 'current', published_at = now()
         WHERE version = $1
         RETURNING version, (SELECT version FROM demoted LIMIT 1) AS previous`,
        [version],
      );
      const previous = result.rows[0]?.previous;
      console.log(`promoted ${version} to current${previous ? ` (was ${previous})` : ''}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('publish failed:', err.message);
  process.exit(1);
});
