/**
 * Every SQL string in one place.
 *
 * Not a style preference. `nk.sqlExec` runs statements individually and there
 * is no transaction object in the runtime, so multi-table atomicity has to be
 * expressed as a single statement using CTEs. Keeping the SQL together is what
 * makes it possible to see, in one file, which operations are atomic and which
 * are merely re-runnable.
 *
 * Rule: **an operation that changes more than one table is one statement, or it
 * is designed to be safely re-run.** A partial write that awards points without
 * recording the attempt is the worst outcome available, because it is invisible
 * until a teacher asks why the numbers disagree.
 */

export const Q = {
  // --- identity ------------------------------------------------------------

  insertProfile: `
    INSERT INTO lenterra_account_profile
      (user_id, role, display_name, friend_code, wallet_address, auth_strategy)
    VALUES ($1, 'student', $2, $3, $4, $5)
    ON CONFLICT (user_id) DO NOTHING`,

  profileByUser: `
    SELECT p.user_id, p.role, p.display_name, p.friend_code, p.school_id, p.locale,
           p.auth_strategy, p.onboarded_at IS NOT NULL AS onboarded
    FROM lenterra_account_profile p
    WHERE p.user_id = $1`,

  profileUpdate: `
    UPDATE lenterra_account_profile
    SET display_name = COALESCE($2, display_name),
        locale       = COALESCE($3, locale),
        friend_code  = COALESCE($4, friend_code),
        updated_at   = now()
    WHERE user_id = $1
    RETURNING display_name, friend_code, locale`,

  markOnboarded: `
    UPDATE lenterra_account_profile
    SET onboarded_at = COALESCE(onboarded_at, now()), updated_at = now()
    WHERE user_id = $1`,

  friendCodeExists: `SELECT 1 FROM lenterra_account_profile WHERE friend_code = $1`,

  // Only ever a same-school match. A code from another school returns nothing
  // rather than "wrong school", which would confirm the code exists.
  friendByCode: `
    SELECT p.user_id, p.display_name
    FROM lenterra_account_profile p
    WHERE p.friend_code = $1
      AND p.role = 'student'
      AND p.school_id IS NOT NULL
      AND p.school_id = (SELECT school_id FROM lenterra_account_profile WHERE user_id = $2)
      AND p.user_id <> $2`,

  sameSchool: `
    SELECT (a.school_id IS NOT NULL AND a.school_id = b.school_id) AS same
    FROM lenterra_account_profile a, lenterra_account_profile b
    WHERE a.user_id = $1 AND b.user_id = $2`,

  setRole: `
    UPDATE lenterra_account_profile SET role = $2, updated_at = now() WHERE user_id = $1`,

  // --- auth ----------------------------------------------------------------

  burnJti: `
    INSERT INTO lenterra_auth_jti (jti, expires_at)
    VALUES ($1, to_timestamp($2))
    ON CONFLICT (jti) DO NOTHING`,

  purgeJti: `DELETE FROM lenterra_auth_jti WHERE expires_at < now() - interval '1 hour'`,

  // --- classes -------------------------------------------------------------

  classCreate: `
    INSERT INTO lenterra_class
      (id, school_id, teacher_user_id, nakama_group_id, name, level, join_code,
       join_code_expires_at, max_members)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '14 days', $8)
    RETURNING id, join_code, join_code_expires_at, nakama_group_id`,

  classByCode: `
    SELECT c.id, c.name, c.school_id, c.max_members, c.nakama_group_id,
           s.name AS school_name,
           (SELECT count(*) FROM lenterra_class_member m
             WHERE m.class_id = c.id AND m.removed_at IS NULL) AS member_count
    FROM lenterra_class c
    JOIN lenterra_school s ON s.id = c.school_id
    WHERE c.join_code = $1
      AND c.archived_at IS NULL
      AND (c.join_code_expires_at IS NULL OR c.join_code_expires_at > now())`,

  /** Every class this teacher owns, for the dashboard's landing view. */
  classesOwnedBy: `
    SELECT c.id, c.name, c.level, c.join_code, c.leaderboard_enabled,
           (SELECT count(*) FROM lenterra_class_member m
             WHERE m.class_id = c.id AND m.removed_at IS NULL) AS students
    FROM lenterra_class c
    WHERE c.teacher_user_id = $1 AND c.archived_at IS NULL
    ORDER BY c.created_at DESC`,

  classSetLeaderboard: `
    UPDATE lenterra_class SET leaderboard_enabled = $3
    WHERE id = $1 AND teacher_user_id = $2 AND archived_at IS NULL
    RETURNING id`,

  classOwnedBy: `
    SELECT c.id, c.name, c.school_id, c.leaderboard_enabled, c.join_code, c.join_code_expires_at
    FROM lenterra_class c
    WHERE c.id = $1 AND c.teacher_user_id = $2 AND c.archived_at IS NULL`,

  classOfUser: `
    SELECT c.id, c.name, c.leaderboard_enabled, c.school_id
    FROM lenterra_class_member m
    JOIN lenterra_class c ON c.id = m.class_id
    WHERE m.user_id = $1 AND m.removed_at IS NULL AND c.archived_at IS NULL
    ORDER BY m.joined_at DESC
    LIMIT 1`,

  classJoin: `
    INSERT INTO lenterra_class_member (class_id, user_id)
    VALUES ($1, $2)
    ON CONFLICT (class_id, user_id) DO UPDATE SET removed_at = NULL
    RETURNING class_id`,

  // Sets school_id only when it is not already set, so a transfer is an
  // explicit operation rather than a side effect of joining a class.
  attachSchool: `
    UPDATE lenterra_account_profile
    SET school_id = COALESCE(school_id, $2), updated_at = now()
    WHERE user_id = $1`,

  classMemberRemove: `
    UPDATE lenterra_class_member SET removed_at = now()
    WHERE class_id = $1 AND user_id = $2 AND removed_at IS NULL`,

  // Masked names only: a student must be able to recognise their own profile
  // without the response becoming a class roster leak.
  classCandidates: `
    SELECT m.user_id, p.display_name
    FROM lenterra_class_member m
    JOIN lenterra_account_profile p ON p.user_id = m.user_id
    WHERE m.class_id = $1 AND m.removed_at IS NULL AND p.auth_strategy = 'class_code'
    ORDER BY p.display_name
    LIMIT 40`,

  classRoster: `
    SELECT p.user_id, p.display_name, m.joined_at,
           (SELECT min(a.submitted_at) FROM lenterra_attempt a WHERE a.user_id = p.user_id) AS first_attempt_at,
           (SELECT max(a.submitted_at) FROM lenterra_attempt a WHERE a.user_id = p.user_id) AS last_active_at,
           (SELECT count(*) FROM lenterra_attempt a
             WHERE a.user_id = p.user_id AND a.validation_status = 'validated') AS attempts
    FROM lenterra_class_member m
    JOIN lenterra_account_profile p ON p.user_id = m.user_id
    WHERE m.class_id = $1 AND m.removed_at IS NULL
    ORDER BY p.display_name`,

  // --- reclaim -------------------------------------------------------------

  reclaimCreate: `
    INSERT INTO lenterra_reclaim_request
      (id, class_id, target_user_id, requester_user_id, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING id`,

  reclaimPending: `
    SELECT r.id, p.display_name, r.created_at
    FROM lenterra_reclaim_request r
    JOIN lenterra_account_profile p ON p.user_id = r.target_user_id
    WHERE r.class_id = $1 AND r.status = 'pending'
      AND r.created_at > now() - interval '14 days'
    ORDER BY r.created_at`,

  reclaimById: `
    SELECT r.id, r.class_id, r.target_user_id, r.requester_user_id, r.status
    FROM lenterra_reclaim_request r
    WHERE r.id = $1`,

  reclaimResolve: `
    UPDATE lenterra_reclaim_request
    SET status = $2, approved_by = $3, resolved_at = now()
    WHERE id = $1 AND status = 'pending'
    RETURNING target_user_id, requester_user_id, class_id`,

  // --- catalog -------------------------------------------------------------

  currentCatalog: `
    SELECT version, manifest FROM lenterra_catalog_version WHERE status = 'current'`,

  catalogParts: `
    SELECT part, sha256, bytes FROM lenterra_catalog_part WHERE version = $1 ORDER BY part`,

  catalogPull: `
    SELECT part, sha256, body FROM lenterra_catalog_part
    WHERE version = $1 AND part = ANY($2::text[])
    ORDER BY part`,

  catalogVersionExists: `SELECT status FROM lenterra_catalog_version WHERE version = $1`,

  catalogPublish: `
    UPDATE lenterra_catalog_version
    SET status = 'published', published_at = now(), published_by = $2
    WHERE version = $1 AND status = 'draft'`,

  // Exactly one current version is enforced by a partial unique index, so
  // demoting the incumbent and promoting the successor must be one statement.
  catalogPromote: `
    WITH demoted AS (
      UPDATE lenterra_catalog_version SET status = 'rolled_back'
      WHERE status = 'current' AND version <> $1
      RETURNING version
    )
    UPDATE lenterra_catalog_version
    SET status = 'current', published_at = COALESCE(published_at, now()), published_by = $2
    WHERE version = $1
    RETURNING version, (SELECT version FROM demoted LIMIT 1) AS previous`,

  missionsForCatalog: `
    SELECT m.mission_id, m.content_version, m.game_id, m.rank, m.skill_weights, m.definition,
           COALESCE(r.rating, (m.definition->>'eloDifficulty')::float8, 1000) AS rating
    FROM lenterra_mission m
    LEFT JOIN lenterra_mission_rating r
      ON r.mission_id = m.mission_id AND r.content_version = m.content_version
    WHERE m.catalog_version = $1
    ORDER BY m.game_id, m.rank`,

  missionById: `
    SELECT m.mission_id, m.content_version, m.game_id, m.rank, m.skill_weights, m.definition
    FROM lenterra_mission m
    WHERE m.mission_id = $1 AND m.content_version = $2 AND m.catalog_version = $3`,

  // --- attempts and mastery -----------------------------------------------

  attemptByKey: `
    SELECT id, validation_status, outcome, rejection_reason
    FROM lenterra_attempt WHERE idempotency_key = $1`,

  /**
   * Attempt, mastery events, mastery state, and the points ledger in one
   * statement. Split across four calls, a crash between them leaves points
   * awarded for an attempt that was never recorded.
   */
  attemptInsert: `
    INSERT INTO lenterra_attempt
      (id, user_id, mission_id, mission_content_version, catalog_version, game_id,
       outcome, duration_ms, move_count, hint_shown, hint_used, played_offline, two_player,
       replay, metrics, client_started_at, device_seq, validated_at, validation_status,
       rejection_reason, idempotency_key, client_version, core_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
            CASE WHEN $18 = 'validated' THEN now() ELSE NULL END, $18, $19, $20, $21, $22)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`,

  masteryEventInsert: `
    INSERT INTO lenterra_mastery_event
      (id, user_id, skill_node_id, source_type, source_id, mastery_before, mastery_after,
       weight, correct, engine_version, params_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,

  masteryUpsert: `
    INSERT INTO lenterra_skill_mastery
      (user_id, skill_node_id, mastery, evidence_count, distinct_sources,
       first_evidence_at, last_evidence_at, last_attempt_id, engine_version, params_version)
    VALUES ($1,$2,$3,$4,$5, now(), now(), $6, $7, $8)
    ON CONFLICT (user_id, skill_node_id) DO UPDATE
      SET mastery          = EXCLUDED.mastery,
          evidence_count   = EXCLUDED.evidence_count,
          distinct_sources = EXCLUDED.distinct_sources,
          last_evidence_at = now(),
          last_attempt_id  = EXCLUDED.last_attempt_id,
          engine_version   = EXCLUDED.engine_version,
          params_version   = EXCLUDED.params_version,
          updated_at       = now()`,

  masteryForUser: `
    SELECT skill_node_id, mastery, evidence_count, distinct_sources,
           extract(epoch FROM last_evidence_at) * 1000 AS last_evidence_ms
    FROM lenterra_skill_mastery WHERE user_id = $1`,

  masterySourceKeys: `
    SELECT e.skill_node_id, a.mission_id AS source_key
    FROM lenterra_mastery_event e
    JOIN lenterra_attempt a ON a.id = e.source_id
    WHERE e.user_id = $1
    GROUP BY e.skill_node_id, a.mission_id`,

  /**
   * Per-game progress for the record tab.
   *
   * Distinct missions *passed*, not attempts made: a student who replays one
   * mission thirty times has not progressed thirty missions, and a counter
   * that says otherwise is the kind of flattery that stops meaning anything.
   */
  gameProgress: `
    WITH played AS (
      SELECT a.game_id, a.mission_id, a.outcome, a.submitted_at,
             -- Resolved by subquery, not a join: a mission version can appear
             -- in several catalog versions, and joining would multiply the
             -- attempt rows and inflate every count below it.
             (SELECT max(m.rank) FROM lenterra_mission m
               WHERE m.mission_id = a.mission_id) AS rank
      FROM lenterra_attempt a
      WHERE a.user_id = $1 AND a.validation_status = 'validated'
    )
    SELECT game_id,
           count(DISTINCT mission_id) FILTER (WHERE outcome = 'success') AS missions_passed,
           count(*) AS attempts,
           max(rank) FILTER (WHERE outcome = 'success') AS highest_rank,
           extract(epoch FROM max(submitted_at)) * 1000 AS last_played_ms
    FROM played GROUP BY game_id`,

  /**
   * Activity for the last eight weeks, bucketed by week.
   *
   * Weekly rather than daily on purpose. A student's own history at day
   * resolution is a record of when they were awake and near a phone, and the
   * product has no use for that precision — the streak already covers "did I
   * play today". Coarser is both sufficient and safer (TRD-OBS-002).
   *
   * Weeks with no activity are absent rather than zero-filled; the client
   * knows the range and fills the gaps.
   */
  weeklyActivity: `
    SELECT to_char(date_trunc('week', submitted_at), 'YYYY-MM-DD') AS date,
           count(*) AS attempts,
           sum(duration_ms) AS total_ms
    FROM lenterra_attempt
    WHERE user_id = $1
      AND validation_status = 'validated'
      AND submitted_at > now() - interval '56 days'
    GROUP BY 1 ORDER BY 1`,

  /** How many missions exist per game in a catalog, for "7 of 20". */
  missionCountsByGame: `
    SELECT game_id, count(*) AS n FROM lenterra_mission
    WHERE catalog_version = $1 GROUP BY game_id`,

  masteryTrend: `
    SELECT skill_node_id,
           sum(CASE WHEN mastery_after > mastery_before THEN 1
                    WHEN mastery_after < mastery_before THEN -1 ELSE 0 END) AS direction
    FROM lenterra_mastery_event
    WHERE user_id = $1 AND created_at > now() - interval '14 days'
    GROUP BY skill_node_id`,

  recentAttempts: `
    SELECT a.id, a.mission_id, a.outcome,
           extract(epoch FROM a.submitted_at) * 1000 AS at_ms,
           a.duration_ms, a.played_offline
    FROM lenterra_attempt a
    WHERE a.user_id = $1 AND a.validation_status = 'validated'
    ORDER BY a.submitted_at DESC
    LIMIT $2`,

  recentMissionIds: `
    SELECT a.mission_id
    FROM lenterra_attempt a
    WHERE a.user_id = $1 AND a.validation_status = 'validated'
    ORDER BY a.submitted_at DESC
    LIMIT 10`,

  attemptCountForMission: `
    SELECT count(*) AS n FROM lenterra_attempt
    WHERE user_id = $1 AND mission_id = $2 AND validation_status = 'validated' AND outcome = 'success'`,

  // --- ratings -------------------------------------------------------------

  studentRating: `
    SELECT game_id, rating, matches FROM lenterra_student_rating WHERE user_id = $1`,

  studentRatingUpsert: `
    INSERT INTO lenterra_student_rating (user_id, game_id, rating, matches)
    VALUES ($1,$2,$3,1)
    ON CONFLICT (user_id, game_id) DO UPDATE
      SET rating = EXCLUDED.rating, matches = lenterra_student_rating.matches + 1,
          updated_at = now()`,

  missionRatingUpsert: `
    INSERT INTO lenterra_mission_rating (mission_id, content_version, rating, attempts, successes)
    VALUES ($1,$2,$3,1,$4)
    ON CONFLICT (mission_id, content_version) DO UPDATE
      SET rating    = EXCLUDED.rating,
          attempts  = lenterra_mission_rating.attempts + 1,
          successes = lenterra_mission_rating.successes + EXCLUDED.successes,
          updated_at = now()`,

  missionRatings: `
    SELECT mission_id, content_version, rating, attempts FROM lenterra_mission_rating`,

  engineParams: `
    SELECT skill_node_id, p_init, p_transit, p_slip, p_guess, params_version
    FROM lenterra_engine_params WHERE active`,

  // --- struggle ------------------------------------------------------------

  struggleOpen: `
    SELECT id FROM lenterra_struggle_event
    WHERE user_id = $1 AND skill_node_id = $2 AND resolved_at IS NULL`,

  struggleInsert: `
    INSERT INTO lenterra_struggle_event (id, user_id, skill_node_id, attempt_ids, support_offered)
    VALUES ($1,$2,$3,$4,$5)`,

  struggleResolve: `
    UPDATE lenterra_struggle_event SET resolved_at = now()
    WHERE user_id = $1 AND skill_node_id = $2 AND resolved_at IS NULL`,

  struggleForClass: `
    SELECT s.user_id, p.display_name, s.skill_node_id,
           extract(epoch FROM s.detected_at) * 1000 AS detected_ms,
           array_length(s.attempt_ids, 1) AS failures
    FROM lenterra_struggle_event s
    JOIN lenterra_class_member m ON m.user_id = s.user_id AND m.removed_at IS NULL
    JOIN lenterra_account_profile p ON p.user_id = s.user_id
    WHERE m.class_id = $1 AND s.resolved_at IS NULL
    ORDER BY s.detected_at DESC
    LIMIT 20`,

  // --- points --------------------------------------------------------------

  pointsAward: `
    INSERT INTO lenterra_points_ledger
      (id, user_id, delta, reason, source_type, source_id, idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`,

  pointsBalance: `SELECT COALESCE(balance, 0) AS balance FROM lenterra_points_balance WHERE user_id = $1`,

  pointsHistory: `
    SELECT delta, reason, extract(epoch FROM created_at) * 1000 AS at_ms
    FROM lenterra_points_ledger
    WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
    ORDER BY created_at DESC
    LIMIT $3`,

  streakRead: `
    SELECT current_days, longest_days, last_credit_date::text AS last_credit_date
    FROM lenterra_streak WHERE user_id = $1`,

  streakUpsert: `
    INSERT INTO lenterra_streak (user_id, current_days, longest_days, last_credit_date)
    VALUES ($1, 1, 1, $2::date)
    ON CONFLICT (user_id) DO UPDATE
      SET current_days = CASE
            WHEN lenterra_streak.last_credit_date = $2::date THEN lenterra_streak.current_days
            WHEN lenterra_streak.last_credit_date = $2::date - 1 THEN lenterra_streak.current_days + 1
            ELSE 1
          END,
          longest_days = GREATEST(
            lenterra_streak.longest_days,
            CASE
              WHEN lenterra_streak.last_credit_date = $2::date THEN lenterra_streak.current_days
              WHEN lenterra_streak.last_credit_date = $2::date - 1 THEN lenterra_streak.current_days + 1
              ELSE 1
            END),
          last_credit_date = $2::date,
          updated_at = now()
    RETURNING current_days, (last_credit_date = $2::date) AS credited_today`,

  achievementAward: `
    INSERT INTO lenterra_achievement (user_id, achievement_id, awarded_by)
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, achievement_id) DO NOTHING
    RETURNING achievement_id`,

  achievementsForUser: `SELECT achievement_id FROM lenterra_achievement WHERE user_id = $1`,

  /** Distinct games with at least one validated attempt — "Penjelajah". */
  gamesPlayed: `
    SELECT DISTINCT game_id FROM lenterra_attempt
    WHERE user_id = $1 AND validation_status = 'validated'`,

  validatedAttemptTotal: `
    SELECT count(*) AS n FROM lenterra_attempt
    WHERE user_id = $1 AND validation_status = 'validated'`,

  /**
   * Evidence behind one node: how many distinct missions, and over how many
   * distinct days. Both matter for a certificate — a node evidenced twice by
   * the same mission in one evening is not the same as two missions across a
   * fortnight, and only the second is worth certifying (PRD-RWD-012).
   */
  masteryEvidenceSpread: `
    SELECT e.skill_node_id,
           count(DISTINCT a.mission_id) AS sources,
           count(DISTINCT date_trunc('day', e.created_at)) AS days,
           count(*) AS events,
           extract(epoch FROM min(e.created_at)) * 1000 AS first_ms,
           extract(epoch FROM max(e.created_at)) * 1000 AS last_ms
    FROM lenterra_mastery_event e
    LEFT JOIN lenterra_attempt a ON a.id = e.source_id
    WHERE e.user_id = $1 AND e.correct AND e.skill_node_id = ANY($2)
    GROUP BY e.skill_node_id`,

  redemptionInsert: `
    INSERT INTO lenterra_redemption (id, user_id, item_id, cost, ledger_id)
    VALUES ($1,$2,$3,$4,$5)`,

  redemptionExists: `SELECT 1 FROM lenterra_redemption WHERE user_id = $1 AND item_id = $2`,

  // --- certificates --------------------------------------------------------

  certificateInsert: `
    INSERT INTO lenterra_certificate (id, user_id, definition_id, evidence, evidence_hash)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (user_id, definition_id) DO NOTHING
    RETURNING id`,

  certificatesForUser: `
    SELECT id, definition_id, extract(epoch FROM issued_at) * 1000 AS issued_ms,
           evidence, onchain_status, public_verifiable
    FROM lenterra_certificate WHERE user_id = $1 ORDER BY issued_at DESC`,

  certificateVisibility: `
    UPDATE lenterra_certificate SET public_verifiable = $3
    WHERE id = $1 AND user_id = $2`,

  // --- courses -------------------------------------------------------------

  checkByKey: `SELECT id, score, passed, attempt_number FROM lenterra_check_result WHERE idempotency_key = $1`,

  checkInsert: `
    INSERT INTO lenterra_check_result
      (id, user_id, check_id, course_id, lesson_id, catalog_version, answers, score, passed,
       attempt_number, played_offline, validated_at, idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`,

  checkAttemptNumber: `
    SELECT COALESCE(max(attempt_number), 0) + 1 AS n
    FROM lenterra_check_result WHERE user_id = $1 AND check_id = $2`,

  lessonComplete: `
    INSERT INTO lenterra_course_progress (user_id, course_id, lesson_id, completed_at)
    VALUES ($1,$2,$3, now())
    ON CONFLICT (user_id, course_id, lesson_id) DO NOTHING`,

  courseProgress: `
    SELECT course_id, count(*) AS lessons_completed
    FROM lenterra_course_progress WHERE user_id = $1 GROUP BY course_id`,

  entitlements: `SELECT entitlement FROM lenterra_entitlement
    WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,

  // --- teacher -------------------------------------------------------------

  // The heatmap query. Runs on every dashboard open; the index on
  // lenterra_class_member(user_id) WHERE removed_at IS NULL exists for it.
  classHeatmap: `
    SELECT m.user_id, p.display_name, sm.skill_node_id, sm.mastery, sm.evidence_count,
           sm.distinct_sources
    FROM lenterra_class_member m
    JOIN lenterra_account_profile p ON p.user_id = m.user_id
    LEFT JOIN lenterra_skill_mastery sm ON sm.user_id = m.user_id
    WHERE m.class_id = $1 AND m.removed_at IS NULL
    ORDER BY p.display_name, sm.skill_node_id`,

  classParticipation: `
    SELECT count(DISTINCT m.user_id) AS enrolled,
           count(DISTINCT a.user_id) FILTER (WHERE a.submitted_at > now() - ($2 || ' days')::interval) AS active,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (SELECT count(*) FROM lenterra_attempt x
                        WHERE x.user_id = m.user_id
                          AND x.submitted_at > now() - ($2 || ' days')::interval)), 0) AS median_attempts,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (SELECT COALESCE(sum(x.duration_ms), 0) / 60000.0 FROM lenterra_attempt x
                        WHERE x.user_id = m.user_id
                          AND x.submitted_at > now() - ($2 || ' days')::interval)), 0) AS median_minutes
    FROM lenterra_class_member m
    LEFT JOIN lenterra_attempt a ON a.user_id = m.user_id
    WHERE m.class_id = $1 AND m.removed_at IS NULL`,

  // How many students in a class have data the server has not seen recently.
  // The dashboard cannot silently present an incomplete picture, so the API
  // tells it the picture is incomplete.
  classStaleCount: `
    SELECT count(*) AS stale
    FROM lenterra_class_member m
    WHERE m.class_id = $1 AND m.removed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM lenterra_attempt a
        WHERE a.user_id = m.user_id AND a.submitted_at > now() - interval '3 days')`,

  classGaps: `
    SELECT sm.skill_node_id,
           count(*) FILTER (WHERE sm.mastery < 0.7) AS below_proficient,
           count(*) AS total
    FROM lenterra_class_member m
    JOIN lenterra_skill_mastery sm ON sm.user_id = m.user_id
    WHERE m.class_id = $1 AND m.removed_at IS NULL
    GROUP BY sm.skill_node_id
    ORDER BY below_proficient DESC`,

  // The evidence chain. Complete, never sampled — this is the query that makes
  // the dashboard trustworthy.
  evidenceChain: `
    SELECT e.skill_node_id, extract(epoch FROM e.created_at) * 1000 AS at_ms,
           e.mastery_before, e.mastery_after, e.weight, e.correct,
           a.mission_id, a.outcome, a.hint_used
    FROM lenterra_mastery_event e
    LEFT JOIN lenterra_attempt a ON a.id = e.source_id
    WHERE e.user_id = $1
    ORDER BY e.created_at DESC
    LIMIT 500`,

  memberOfClass: `
    SELECT 1 FROM lenterra_class_member
    WHERE class_id = $1 AND user_id = $2 AND removed_at IS NULL`,

  assignmentCreate: `
    INSERT INTO lenterra_assignment
      (id, class_id, teacher_user_id, target_user_id, kind, target_id, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id`,

  assignmentsForUser: `
    SELECT a.id, a.kind, a.target_id, a.note
    FROM lenterra_assignment a
    JOIN lenterra_class_member m ON m.class_id = a.class_id AND m.removed_at IS NULL
    WHERE m.user_id = $1
      AND a.withdrawn_at IS NULL
      AND (a.target_user_id IS NULL OR a.target_user_id = $1)
    ORDER BY a.created_at DESC
    LIMIT 5`,

  assignmentTargets: `
    SELECT count(*) AS n FROM lenterra_class_member
    WHERE class_id = $1 AND removed_at IS NULL AND ($2::uuid IS NULL OR user_id = $2)`,

  // --- deletion and moderation ---------------------------------------------

  deletionRequest: `
    INSERT INTO lenterra_deletion_request (id, user_id, scheduled_for, requested_by)
    VALUES ($1, $2, now() + interval '30 days', $3)
    ON CONFLICT (user_id) DO UPDATE
      SET cancelled_at = NULL,
          requested_at = now(),
          scheduled_for = now() + interval '30 days',
          requested_by = EXCLUDED.requested_by
      WHERE lenterra_deletion_request.executed_at IS NULL
    RETURNING id, extract(epoch FROM scheduled_for) * 1000 AS scheduled_ms`,

  deletionCancel: `
    UPDATE lenterra_deletion_request SET cancelled_at = now()
    WHERE user_id = $1 AND executed_at IS NULL AND cancelled_at IS NULL
    RETURNING id`,

  deletionPending: `
    SELECT id, extract(epoch FROM scheduled_for) * 1000 AS scheduled_ms
    FROM lenterra_deletion_request
    WHERE user_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL`,

  /** Accounts whose window has elapsed. Run by the retention job. */
  deletionDue: `
    SELECT id, user_id FROM lenterra_deletion_request
    WHERE cancelled_at IS NULL AND executed_at IS NULL AND scheduled_for <= now()
    LIMIT 100`,

  deletionMarkExecuted: `
    UPDATE lenterra_deletion_request SET executed_at = now() WHERE id = $1`,

  moderationReport: `
    INSERT INTO lenterra_moderation_report (id, reporter_user_id, subject_user_id, reason, context)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING id`,

  moderationOpen: `
    SELECT id, reporter_user_id, subject_user_id, reason,
           extract(epoch FROM created_at) * 1000 AS created_ms
    FROM lenterra_moderation_report
    WHERE status = 'open' ORDER BY created_at LIMIT 100`,

  moderationResolve: `
    UPDATE lenterra_moderation_report
    SET status = $2, resolved_by = $3, resolved_at = now()
    WHERE id = $1 AND status = 'open'
    RETURNING subject_user_id`,

  /** Reports older than the response commitment, for the alerting check. */
  moderationOverdue: `
    SELECT count(*) AS n FROM lenterra_moderation_report
    WHERE status = 'open' AND created_at < now() - interval '72 hours'`,

  // --- notifications -------------------------------------------------------

  // Counted over a rolling 24 hours rather than a calendar day: a calendar cap
  // resets at midnight, which is inside the quiet window and would let three
  // more arrive the moment it lifts.
  notificationCountToday: `
    SELECT count(*) AS n FROM lenterra_notification_log
    WHERE user_id = $1 AND sent_at > now() - interval '24 hours'`,

  notificationRecord: `
    INSERT INTO lenterra_notification_log (id, user_id, code) VALUES ($1,$2,$3)`,

  notificationPurge: `
    DELETE FROM lenterra_notification_log WHERE sent_at < now() - interval '30 days'`,

  // --- audit and telemetry -------------------------------------------------

  auditInsert: `
    INSERT INTO lenterra_audit_log (id, actor_user_id, action, subject_type, subject_id, detail)
    VALUES ($1,$2,$3,$4,$5,$6)`,

  eventInsert: `
    INSERT INTO lenterra_event (user_id, name, payload, occurred_at, device_seq, client_version)
    VALUES ($1,$2,$3,$4,$5,$6)`,

  // --- idempotency and rate limiting ---------------------------------------

  idempotencyRead: `SELECT response, rpc FROM lenterra_idempotency WHERE key = $1 AND user_id = $2`,

  idempotencyWrite: `
    INSERT INTO lenterra_idempotency (key, user_id, rpc, response)
    VALUES ($1,$2,$3,$4::jsonb)
    ON CONFLICT (key) DO NOTHING`,

  idempotencyPurge: `DELETE FROM lenterra_idempotency WHERE created_at < now() - interval '30 days'`,

  rateLimitBump: `
    INSERT INTO lenterra_rate_limit (bucket, window_start, count)
    VALUES ($1, $2::timestamptz, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = lenterra_rate_limit.count + 1
    RETURNING count`,

  rateLimitBumpExec: `
    INSERT INTO lenterra_rate_limit (bucket, window_start, count)
    VALUES ($1, $2::timestamptz, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = lenterra_rate_limit.count + 1`,

  rateLimitRead: `
    SELECT count FROM lenterra_rate_limit WHERE bucket = $1 AND window_start = $2::timestamptz`,

  rateLimitPurge: `DELETE FROM lenterra_rate_limit WHERE window_start < now() - interval '1 day'`,
};
