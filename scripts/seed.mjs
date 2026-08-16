#!/usr/bin/env node
// Synthetic pilot data: 1 school, 3 classes, 90 students, 6 weeks of attempts
// (E1.6).
//
// The teacher dashboard cannot be built against an empty database, and there
// is no pilot school yet (OQ-01). This generates a cohort with a believable
// spread of ability so the heatmap, the attention list, and the evidence
// drill-down have something real to render — and so their queries get exercised
// at roughly pilot scale before a real class depends on them.
//
// **Development only.** It writes rows into Nakama's `users` table, which
// production code never does. It refuses to run against a non-local database
// unless SEED_FORCE=1 is set explicitly.

import { randomUUID } from 'node:crypto';
import pg from 'pg';

import {
  applyEvidence,
  createRng,
  detectStruggle,
  expectedScore,
  studentK,
  updateRatings,
} from '../packages/core/dist/index.js';

const ENGINE_VERSION = '1.0.0';
const PARAMS_VERSION = 'params@v1';
const CATALOG_VERSION = 'catalog@seed.1';

const MISSIONS = [
  { id: 'congklak.m01', rating: 800, weights: { 'comp.counting': 0.6, 'algo.sequencing': 0.4 } },
  { id: 'congklak.m02', rating: 850, weights: { 'comp.arithmetic': 0.5, 'comp.counting': 0.3, 'comp.modular': 0.2 } },
  { id: 'congklak.m04', rating: 950, weights: { 'comp.modular': 0.7, 'comp.counting': 0.3 } },
  { id: 'congklak.m06', rating: 1050, weights: { 'algo.iteration': 0.6, 'algo.sequencing': 0.4 } },
  { id: 'congklak.m08', rating: 1150, weights: { 'algo.branching': 0.5, 'algo.lookahead': 0.3, 'comp.modular': 0.2 } },
  { id: 'congklak.m11', rating: 1300, weights: { 'algo.lookahead': 0.7, 'algo.sequencing': 0.3 } },
  { id: 'congklak.m15', rating: 1500, weights: { 'algo.greedy': 0.6, 'algo.state-eval': 0.4 } },
  { id: 'benteng.m02', rating: 900, weights: { 'sec.access': 0.7, 'algo.state-eval': 0.3 } },
  { id: 'benteng.m04', rating: 1100, weights: { 'sec.risk': 0.6, 'algo.lookahead': 0.4 } },
  { id: 'benteng.m08', rating: 1450, weights: { 'sec.defense': 0.7, 'algo.lookahead': 0.3 } },
];

const FIRST = ['Ani', 'Rizky', 'Yosef', 'Maria', 'Dewi', 'Bagus', 'Putri', 'Andi', 'Sari', 'Yanto',
  'Intan', 'Rani', 'Doni', 'Lina', 'Fajar', 'Nia', 'Eko', 'Tari', 'Bima', 'Wulan'];
const LAST = ['Manafe', 'Ndolu', 'Bili', 'Tefa', 'Riwu', 'Hendrik', 'Lado', 'Nabuasa', 'Taek', 'Seran'];

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

function assertLocal() {
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const local = host === 'localhost' || host === '127.0.0.1' || host === 'postgres';
  if (!local && process.env.SEED_FORCE !== '1') {
    console.error(
      `refusing to seed synthetic students into "${host}".\n` +
        'This writes fabricated records that are indistinguishable from real ones\n' +
        'once they are in the table. Set SEED_FORCE=1 if you genuinely mean to.',
    );
    process.exit(1);
  }
}

const DAY = 86_400_000;

async function main() {
  assertLocal();

  const client = new pg.Client(connectionConfig());
  await client.connect();
  const rng = createRng(20260816);
  const now = Date.now();

  try {
    await client.query('BEGIN');

    // --- school, teacher, classes -----------------------------------------
    const schoolId = randomUUID();
    await client.query(
      'INSERT INTO lenterra_school (id, name, district, province) VALUES ($1,$2,$3,$4)',
      [schoolId, 'SMP Negeri 3 Kupang (synthetic)', 'Kupang', 'NTT'],
    );

    const teacherId = await createUser(client, 'guru.yosef', `0xteacher${schoolId.slice(0, 8)}`);
    await insertProfile(client, teacherId, 'teacher', 'Pak Yosef', schoolId, 'email');

    const classIds = [];
    for (const [index, name] of ['8A', '8B', '9A'].entries()) {
      const classId = randomUUID();
      await client.query(
        `INSERT INTO lenterra_class
           (id, school_id, teacher_user_id, nakama_group_id, name, level, join_code, join_code_expires_at, max_members)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          classId,
          schoolId,
          teacherId,
          randomUUID(),
          `Kelas ${name}`,
          index === 2 ? 'SMP-9' : 'SMP-8',
          `SEED${index}${name}`.slice(0, 6).toUpperCase(),
          new Date(now + 7 * DAY),
          40,
        ],
      );
      classIds.push(classId);
    }

    // --- catalog ----------------------------------------------------------
    await client.query(
      `INSERT INTO lenterra_catalog_version (version, status, manifest, published_at)
       VALUES ($1,'current',$2,now())
       ON CONFLICT (version) DO NOTHING`,
      [CATALOG_VERSION, JSON.stringify({ parts: [], synthetic: true })],
    );
    for (const mission of MISSIONS) {
      await client.query(
        `INSERT INTO lenterra_mission_rating (mission_id, content_version, rating, attempts, successes)
         VALUES ($1,1,$2,0,0) ON CONFLICT DO NOTHING`,
        [mission.id, mission.rating],
      );
    }

    // --- students ---------------------------------------------------------
    let students = 0;
    let attemptRows = 0;

    for (let s = 0; s < 90; s++) {
      const classId = classIds[s % 3];
      const displayName = `${FIRST[s % FIRST.length]} ${LAST[Math.floor(s / FIRST.length) % LAST.length]}`;
      const userId = await createUser(client, `siswa${s}`, `0xseed${String(s).padStart(4, '0')}${schoolId.slice(0, 6)}`);
      await insertProfile(client, userId, 'student', displayName, schoolId, 'class_code');
      await client.query(
        'INSERT INTO lenterra_class_member (class_id, user_id, joined_at) VALUES ($1,$2,$3)',
        [classId, userId, new Date(now - 42 * DAY)],
      );
      students++;

      // A spread of ability, and a spread of engagement — including students
      // who never started, because those are exactly who the attention list
      // exists to surface.
      const ability = 0.15 + (s / 90) * 0.75;
      const engagement = s % 11 === 0 ? 0 : 0.3 + rng() * 0.7;
      const sessionCount = Math.round(engagement * 34);

      let rating = 1000;
      let matches = 0;
      const mastery = {};
      const sourceKeys = {};
      const recentAttempts = [];
      let points = 0;

      for (let a = 0; a < sessionCount; a++) {
        const mission = MISSIONS[Math.floor(rng() * MISSIONS.length)];
        const predicted = expectedScore(rating, mission.rating);
        const success = rng() < Math.max(0.05, Math.min(0.95, predicted * 0.6 + ability * 0.4));
        const hintShown = rng() > 0.75;
        const hintUsed = hintShown && rng() > 0.5;
        const at = now - (42 - Math.floor((a / Math.max(1, sessionCount)) * 42)) * DAY;

        const attemptId = randomUUID();
        await client.query(
          `INSERT INTO lenterra_attempt
             (id, user_id, mission_id, mission_content_version, catalog_version, game_id,
              outcome, duration_ms, move_count, hint_shown, hint_used, played_offline, two_player,
              replay, metrics, client_started_at, device_seq, submitted_at, validated_at,
              validation_status, idempotency_key, client_version, core_version)
           VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,$13,$14,$15,$14,$14,'validated',$16,'seed','${ENGINE_VERSION}')`,
          [
            attemptId,
            userId,
            mission.id,
            CATALOG_VERSION,
            mission.id.split('.')[0],
            success ? 'success' : 'failure',
            60_000 + Math.floor(rng() * 180_000),
            8 + Math.floor(rng() * 30),
            hintShown,
            hintUsed,
            rng() > 0.6,
            JSON.stringify({ synthetic: true, moves: [] }),
            JSON.stringify({ greedyMoveTaken: Math.floor(rng() * 4) }),
            new Date(at),
            a,
            `seed-${userId}-${a}`,
          ],
        );
        attemptRows++;

        const updates = applyEvidence(mastery, {
          skillWeights: mission.weights,
          outcome: success ? 'success' : 'failure',
          hintShown,
          hintUsed,
          source: 'game',
          sourceKey: mission.id,
          priorSourceKeys: sourceKeys,
        });

        for (const update of updates) {
          await client.query(
            `INSERT INTO lenterra_mastery_event
               (id, user_id, skill_node_id, source_type, source_id, mastery_before, mastery_after,
                weight, correct, engine_version, params_version, created_at)
             VALUES ($1,$2,$3,'attempt',$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              randomUUID(), userId, update.skillNodeId, attemptId,
              update.before, update.after, update.weight, update.correct,
              ENGINE_VERSION, PARAMS_VERSION, new Date(at),
            ],
          );

          mastery[update.skillNodeId] = {
            value: update.after,
            evidenceCount: update.evidenceCountAfter,
            distinctSources: update.distinctSourcesAfter,
          };
          const keys = sourceKeys[update.skillNodeId] ?? [];
          if (!keys.includes(mission.id)) keys.push(mission.id);
          sourceKeys[update.skillNodeId] = keys;
        }

        const next = updateRatings(rating, mission.rating, success, studentK(matches), 0);
        rating = next.student;
        matches++;

        if (success) {
          points += 10;
          await client.query(
            `INSERT INTO lenterra_points_ledger (id, user_id, delta, reason, source_type, source_id, idempotency_key, created_at)
             VALUES ($1,$2,10,'mission.first','attempt',$3,$4,$5)`,
            [randomUUID(), userId, attemptId, `seed-points-${attemptId}`, new Date(at)],
          );
        }

        recentAttempts.unshift({
          id: attemptId,
          missionId: mission.id,
          primaryNode: primaryOf(mission.weights),
          outcome: success ? 'success' : 'failure',
          at,
        });
      }

      for (const [node, state] of Object.entries(mastery)) {
        await client.query(
          `INSERT INTO lenterra_skill_mastery
             (user_id, skill_node_id, mastery, evidence_count, distinct_sources,
              first_evidence_at, last_evidence_at, engine_version, params_version)
           VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
          [
            userId, node, state.value, state.evidenceCount, state.distinctSources,
            new Date(now - 42 * DAY), ENGINE_VERSION, PARAMS_VERSION,
          ],
        );
      }

      await client.query(
        'INSERT INTO lenterra_student_rating (user_id, game_id, rating, matches) VALUES ($1,$2,$3,$4)',
        [userId, 'congklak', rating, matches],
      );

      const struggle = detectStruggle(recentAttempts);
      if (struggle) {
        await client.query(
          `INSERT INTO lenterra_struggle_event (id, user_id, skill_node_id, attempt_ids, detected_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), userId, struggle.skillNodeId, struggle.attemptIds, new Date(now - DAY)],
        );
      }

      if (points > 0) {
        await client.query(
          `INSERT INTO lenterra_streak (user_id, current_days, longest_days, last_credit_date)
           VALUES ($1,$2,$3,current_date)`,
          [userId, 1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 14)],
        );
      }
    }

    await client.query('COMMIT');

    console.log(`seeded 1 school, ${classIds.length} classes, ${students} students, ${attemptRows} attempts`);
    console.log(`join codes: SEED08A, SEED18B, SEED29A (first 6 chars as stored)`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Nakama owns `users`. Production code never writes it — this is a
 * development-only shortcut so the dashboard has a cohort to render.
 */
async function createUser(client, username, customId) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (id, username, custom_id, create_time, update_time)
     VALUES ($1,$2,$3,now(),now())`,
    [id, `${username}-${id.slice(0, 6)}`, customId],
  );
  return id;
}

async function insertProfile(client, userId, role, displayName, schoolId, strategy) {
  await client.query(
    `INSERT INTO lenterra_account_profile
       (user_id, role, display_name, friend_code, school_id, locale, wallet_address, auth_strategy, onboarded_at)
     VALUES ($1,$2,$3,$4,$5,'id',$6,$7,now())`,
    [userId, role, displayName, friendCode(userId), schoolId, `0x${userId.replace(/-/g, '').slice(0, 40)}`, strategy],
  );
}

function friendCode(seed) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = seed.replace(/-/g, '');
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  return code;
}

function primaryOf(weights) {
  return Object.entries(weights).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
