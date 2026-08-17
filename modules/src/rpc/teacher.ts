/**
 * Teacher RPCs.
 *
 * Every handler begins with an ownership check, before any data is read.
 * Aggregation happens in SQL rather than in the browser: shipping every
 * student's full mastery record to a laptop on a school connection is both slow
 * and a larger data exposure than the view needs (TRD-TCH-002).
 */

import type { SkillNodeId } from '@lenterra/core';
import { bandOf } from '@lenterra/core';

import { conflict, invalidArgument, notFound } from '../lib/errors';
import { optionalString, requireBool, requireInt, requireString, toIso, type Ctx } from '../lib/ctx';
import { Q } from '../db/queries';
import { audit, maskName, requireMemberOf, requireRole, requireTeacherOf } from '../domain/profile';
import { catalogPart, currentCatalog } from '../domain/catalog';
import { emit } from '../domain/telemetry';

// ---------------------------------------------------------------------------
// Class creation and roster
// ---------------------------------------------------------------------------

export interface ClassCreateReq {
  name: string;
  level: string;
  expectedSize?: number;
  idempotencyKey: string;
}

/**
 * Create the Nakama group and the relational row together.
 *
 * A class exists twice — as a group so leaderboards and membership work
 * natively, and as a row so teacher aggregates can join. Creating them in one
 * operation is what stops the two representations from diverging.
 */
export function teacherClassCreate(c: Ctx, req: ClassCreateReq) {
  const profile = requireRole(c, ['teacher', 'school_admin', 'staff']);
  if (!profile.schoolId) throw invalidArgument('Your account is not attached to a school');

  // The consent gate (PRD-ONB-018).
  //
  // Refused here rather than warned about later, because a class that exists is
  // a class students can join, and a student joining is the moment a minor's
  // data starts being collected. A banner on a dashboard does not stop that; it
  // only means somebody could have read one.
  //
  // The pilot runs through schools, so what is attested is the school's own
  // process — not a per-parent record, which R1 has no mechanism to collect and
  // would be pretending to have.
  const consent = c.nk.sqlQuery(Q.consentForSchool, [profile.schoolId]);
  if (consent.length === 0) {
    throw conflict(
      'consent_required',
      'Record how this school obtained consent to participate before creating a class',
    );
  }

  const name = requireString(req.name, 'name', 64);
  const level = requireString(req.level, 'level', 32);
  const expectedSize =
    req.expectedSize === undefined ? 40 : requireInt(req.expectedSize, 'expectedSize', 1, 200);

  const group = c.nk.groupCreate(c.userId, `${name} (${c.nk.uuidv4().slice(0, 8)})`, c.userId, 'id', name, '', false, {}, expectedSize + 5);

  const classId = c.nk.uuidv4();
  const rows = c.nk.sqlQuery(Q.classCreate, [
    classId,
    profile.schoolId,
    c.userId,
    group.id,
    name,
    level,
    generateJoinCode(c),
    expectedSize,
  ]);
  if (rows.length === 0) throw invalidArgument('Could not create the class');

  const row = rows[0] as {
    id: string;
    join_code: string;
    join_code_expires_at: string;
    nakama_group_id: string;
  };
  audit(c, 'class.create', 'class', row.id, { name, level });

  return {
    classId: row.id,
    joinCode: row.join_code,
    joinCodeExpiresAt: row.join_code_expires_at,
    nakamaGroupId: row.nakama_group_id,
  };
}

/**
 * Six characters from an alphabet with no ambiguous glyphs.
 *
 * Students read these aloud across a classroom, so 0/O and 1/I are excluded.
 * Guessability is bounded by expiry, the class-size cap, and the five-failure
 * rate limit rather than by length alone.
 */
function generateJoinCode(c: Ctx): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    const uuid = c.nk.uuidv4().replace(/-/g, '');
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet.charAt(parseInt(uuid.substr(i * 2, 2), 16) % alphabet.length);
    }
    if (c.nk.sqlQuery(Q.classByCode, [code]).length === 0) return code;
  }
  throw invalidArgument('Could not allocate a join code, please try again');
}

export function teacherClassRoster(c: Ctx, req: { classId: string }) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));

  const detail = c.nk.sqlQuery(Q.classOwnedBy, [klass.id, c.userId]);
  const meta = detail[0] as {
    join_code: string | null;
    join_code_expires_at: string | null;
    leaderboard_enabled: boolean;
  };

  const rows = c.nk.sqlQuery(Q.classRoster, [klass.id]) as {
    user_id: string;
    display_name: string;
    joined_at: string;
    first_attempt_at: string | null;
    last_active_at: string | null;
    attempts: number;
  }[];

  const members = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (typeof rows)[number];
    members.push({
      userId: row.user_id,
      displayName: row.display_name,
      joinedAt: row.joined_at,
      firstAttemptAt: row.first_attempt_at,
      lastActiveAt: row.last_active_at,
      attempts: Number(row.attempts),
    });
  }

  const pendingRows = c.nk.sqlQuery(Q.reclaimPending, [klass.id]) as {
    id: string;
    display_name: string;
    created_at: string;
  }[];
  const pendingReclaims = [];
  for (let i = 0; i < pendingRows.length; i++) {
    const row = pendingRows[i] as { id: string; display_name: string; created_at: string };
    pendingReclaims.push({
      requestId: row.id,
      maskedName: maskName(row.display_name),
      requestedAt: row.created_at,
    });
  }

  return {
    class: {
      id: klass.id,
      name: klass.name,
      joinCode: meta.join_code,
      joinCodeExpiresAt: meta.join_code_expires_at,
      leaderboardEnabled: meta.leaderboard_enabled,
    },
    members,
    pendingReclaims,
  };
}

// ---------------------------------------------------------------------------
// Class summary and heatmap
// ---------------------------------------------------------------------------

export interface ClassSummaryReq {
  classId: string;
  period?: 'week' | 'month' | 'term';
}

const PERIOD_DAYS: Record<string, number> = { week: 7, month: 30, term: 120 };

interface TeachingNote {
  lesson: string | null;
  missions: string[];
  misconception: string;
  howToTeach: string;
}

export function teacherClassSummary(c: Ctx, req: ClassSummaryReq) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));
  const period = req.period === 'month' || req.period === 'term' ? req.period : 'week';
  const days = PERIOD_DAYS[period] as number;

  const participationRows = c.nk.sqlQuery(Q.classParticipation, [klass.id, String(days)]);
  const participation =
    participationRows.length === 0
      ? { enrolled: 0, activeThisPeriod: 0, medianAttempts: 0, medianMinutes: 0 }
      : (function () {
          const row = participationRows[0] as {
            enrolled: number;
            active: number;
            median_attempts: number;
            median_minutes: number;
          };
          return {
            enrolled: Number(row.enrolled),
            activeThisPeriod: Number(row.active),
            medianAttempts: Number(row.median_attempts),
            medianMinutes: Number(row.median_minutes),
          };
        })();

  const heatRows = c.nk.sqlQuery(Q.classHeatmap, [klass.id]) as {
    user_id: string;
    display_name: string;
    skill_node_id: SkillNodeId | null;
    mastery: number | null;
    evidence_count: number | null;
  }[];

  const byStudent: Record<string, { userId: string; displayName: string; nodes: unknown[] }> = {};
  const order: string[] = [];

  for (let i = 0; i < heatRows.length; i++) {
    const row = heatRows[i] as (typeof heatRows)[number];
    let entry = byStudent[row.user_id];
    if (!entry) {
      entry = { userId: row.user_id, displayName: row.display_name, nodes: [] };
      byStudent[row.user_id] = entry;
      order.push(row.user_id);
    }
    if (row.skill_node_id === null) continue;

    const mastery = Number(row.mastery);
    const evidenceCount = Number(row.evidence_count);
    entry.nodes.push({
      skillNodeId: row.skill_node_id,
      // Raw value alongside the band: a teacher needs to judge whether 0.68 and
      // 0.71 differ meaningfully, and evidenceCount tells them whether either
      // number means anything yet.
      mastery,
      band: bandOf(mastery, evidenceCount),
      evidenceCount,
    });
  }

  const heatmap = [];
  for (let i = 0; i < order.length; i++) heatmap.push(byStudent[order[i] as string]);

  const gapRows = c.nk.sqlQuery(Q.classGaps, [klass.id]) as {
    skill_node_id: SkillNodeId;
    below_proficient: number;
    total: number;
  }[];
  // Teaching notes for the nodes that came back as gaps (PRD-TCH-012).
  //
  // Naming a weakness without saying what to do about it leaves a teacher who
  // is not certified in this subject worse off than before the dashboard spoke:
  // they now have a problem and no way to act on it.
  const catalog = currentCatalog(c);
  const notes = catalogPart<Record<string, TeachingNote>>(c, catalog.version, 'teaching') ?? {};

  const gaps = [];
  for (let i = 0; i < gapRows.length; i++) {
    const row = gapRows[i] as (typeof gapRows)[number];
    const note = notes[row.skill_node_id];
    gaps.push({
      skillNodeId: row.skill_node_id,
      studentsBelowProficient: Number(row.below_proficient),
      totalStudents: Number(row.total),
      suggestedLessonId: note && note.lesson ? note.lesson : null,
      suggestedMissionIds: note && note.missions ? note.missions : [],
      // Prose rather than a key, because it *is* content: authored in the
      // catalog, reviewed with the course material, and updatable without an
      // app release. The dashboard has no catalog cache and no reason to grow
      // one for seventeen paragraphs.
      teaching: note
        ? { misconception: note.misconception, howToTeach: note.howToTeach }
        : null,
    });
  }

  // The dashboard cannot silently present an incomplete picture, so the
  // contract itself tells it the picture is incomplete (PRD-TCH-010).
  const staleRows = c.nk.sqlQuery(Q.classStaleCount, [klass.id]);
  const stale = staleRows.length === 0 ? 0 : Number((staleRows[0] as { stale: number }).stale);

  return {
    generatedAt: toIso(c.now),
    participation,
    heatmap,
    gaps,
    unsyncedWarning: stale > 0 ? { studentsWithStaleData: stale } : null,
  };
}

// ---------------------------------------------------------------------------
// Student detail
// ---------------------------------------------------------------------------

export function teacherStudentDetail(c: Ctx, req: { classId: string; userId: string }) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));
  const userId = requireString(req.userId, 'userId', 64);
  requireMemberOf(c, klass.id, userId);

  const masteryRows = c.nk.sqlQuery(Q.masteryForUser, [userId]) as {
    skill_node_id: SkillNodeId;
    mastery: number;
    evidence_count: number;
    distinct_sources: number;
  }[];

  const trendRows = c.nk.sqlQuery(Q.masteryTrend, [userId]) as {
    skill_node_id: SkillNodeId;
    direction: number;
  }[];
  const trends: Record<string, string> = {};
  for (let i = 0; i < trendRows.length; i++) {
    const row = trendRows[i] as { skill_node_id: SkillNodeId; direction: number };
    const direction = Number(row.direction);
    trends[row.skill_node_id] = direction > 0 ? 'up' : direction < 0 ? 'down' : 'flat';
  }

  const mastery = [];
  for (let i = 0; i < masteryRows.length; i++) {
    const row = masteryRows[i] as (typeof masteryRows)[number];
    const value = Number(row.mastery);
    const evidenceCount = Number(row.evidence_count);
    mastery.push({
      skillNodeId: row.skill_node_id,
      mastery: value,
      band: bandOf(value, evidenceCount),
      evidenceCount,
      distinctSources: Number(row.distinct_sources),
      trend: trends[row.skill_node_id] ?? 'flat',
    });
  }

  // Complete, never sampled. This is the query that makes the dashboard
  // trustworthy — a teacher who cannot see the whole chain has no reason to
  // believe the summary above it (PRD-TCH-008).
  const evidenceRows = c.nk.sqlQuery(Q.evidenceChain, [userId]) as {
    skill_node_id: SkillNodeId;
    at_ms: number;
    mastery_before: number;
    mastery_after: number;
    correct: boolean;
    mission_id: string | null;
    outcome: string | null;
    hint_used: boolean | null;
  }[];

  const byNode: Record<string, { skillNodeId: string; events: unknown[] }> = {};
  const nodeOrder: string[] = [];
  for (let i = 0; i < evidenceRows.length; i++) {
    const row = evidenceRows[i] as (typeof evidenceRows)[number];
    let entry = byNode[row.skill_node_id];
    if (!entry) {
      entry = { skillNodeId: row.skill_node_id, events: [] };
      byNode[row.skill_node_id] = entry;
      nodeOrder.push(row.skill_node_id);
    }
    entry.events.push({
      at: toIso(Number(row.at_ms)),
      missionId: row.mission_id,
      outcome: row.outcome ?? (row.correct ? 'success' : 'failure'),
      hintUsed: row.hint_used ?? false,
      masteryBefore: Number(row.mastery_before),
      masteryAfter: Number(row.mastery_after),
    });
  }
  const evidence = [];
  for (let i = 0; i < nodeOrder.length; i++) evidence.push(byNode[nodeOrder[i] as string]);

  const attemptRows = c.nk.sqlQuery(Q.recentAttempts, [userId, 20]) as {
    id: string;
    mission_id: string;
    outcome: string;
    at_ms: number;
    duration_ms: number;
    played_offline: boolean;
  }[];
  const recentAttempts = [];
  for (let i = 0; i < attemptRows.length; i++) {
    const row = attemptRows[i] as (typeof attemptRows)[number];
    recentAttempts.push({
      attemptId: row.id,
      missionId: row.mission_id,
      outcome: row.outcome,
      at: toIso(Number(row.at_ms)),
      durationMs: Number(row.duration_ms),
      playedOffline: row.played_offline,
    });
  }

  return {
    student: { userId, displayName: displayNameOf(c, userId) },
    // Localisation keys and parameters, not a rendered sentence, so the
    // plain-language summary is translatable and reviewable as content.
    summaryText: summaryFor(mastery),
    mastery,
    evidence,
    struggles: [],
    recentAttempts,
    certificates: [],
  };
}

function displayNameOf(c: Ctx, userId: string): string {
  const rows = c.nk.sqlQuery(Q.profileByUser, [userId]);
  return rows.length === 0 ? 'Siswa' : (rows[0] as { display_name: string }).display_name;
}

function summaryFor(
  mastery: { skillNodeId: string; mastery: number; evidenceCount: number }[],
): { strengthKey: string; nextActionKey: string; params: Record<string, string> } {
  if (mastery.length === 0) {
    return { strengthKey: 'summary.noEvidence', nextActionKey: 'summary.action.encourage', params: {} };
  }

  let strongest = mastery[0] as { skillNodeId: string; mastery: number };
  let weakest = mastery[0] as { skillNodeId: string; mastery: number };
  for (let i = 1; i < mastery.length; i++) {
    const entry = mastery[i] as { skillNodeId: string; mastery: number };
    if (entry.mastery > strongest.mastery) strongest = entry;
    if (entry.mastery < weakest.mastery) weakest = entry;
  }

  return {
    strengthKey: 'summary.strength',
    nextActionKey: 'summary.action.practise',
    params: { strongest: strongest.skillNodeId, weakest: weakest.skillNodeId },
  };
}

// ---------------------------------------------------------------------------
// Attention list
// ---------------------------------------------------------------------------

/**
 * At most five students.
 *
 * A list of forty is a list nobody reads. Five is what a teacher can act on
 * between lessons, which is the only length that changes anything.
 */
export function teacherAttentionList(c: Ctx, req: { classId: string }) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));

  const rows = c.nk.sqlQuery(Q.struggleForClass, [klass.id]) as {
    user_id: string;
    display_name: string;
    skill_node_id: SkillNodeId;
    detected_ms: number;
    failures: number;
  }[];

  const students = [];
  for (let i = 0; i < rows.length && students.length < 5; i++) {
    const row = rows[i] as (typeof rows)[number];
    students.push({
      userId: row.user_id,
      displayName: row.display_name,
      reason: 'repeated_struggle',
      reasonKey: 'attention.reason.repeatedStruggle',
      params: { skillNodeId: row.skill_node_id, failures: String(row.failures ?? 3) },
      suggestedAction: { kind: 'assign_lesson', targetId: row.skill_node_id },
      urgency: Number(row.failures ?? 3),
    });
  }

  // Students who have never started matter as much as students who are stuck,
  // and they generate no struggle events at all.
  if (students.length < 5) {
    const roster = c.nk.sqlQuery(Q.classRoster, [klass.id]) as {
      user_id: string;
      display_name: string;
      first_attempt_at: string | null;
    }[];
    for (let i = 0; i < roster.length && students.length < 5; i++) {
      const row = roster[i] as (typeof roster)[number];
      if (row.first_attempt_at !== null) continue;
      students.push({
        userId: row.user_id,
        displayName: row.display_name,
        reason: 'never_started',
        reasonKey: 'attention.reason.neverStarted',
        params: {},
        suggestedAction: { kind: 'talk' },
        urgency: 10,
      });
    }
  }

  return { students };
}

// ---------------------------------------------------------------------------
// Assignments and reclaim approval
// ---------------------------------------------------------------------------

export interface AssignmentCreateReq {
  classId: string;
  targetUserId?: string | null;
  kind: 'mission' | 'lesson';
  targetId: string;
  note?: string;
  idempotencyKey: string;
}

export function teacherAssignmentCreate(c: Ctx, req: AssignmentCreateReq) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));
  const kind = req.kind === 'lesson' ? 'lesson' : 'mission';
  const targetId = requireString(req.targetId, 'targetId', 128);
  const note = optionalString(req.note, 'note', 280);
  const targetUserId = optionalString(req.targetUserId, 'targetUserId', 64);

  if (targetUserId) requireMemberOf(c, klass.id, targetUserId);

  const assignmentId = c.nk.uuidv4();
  c.nk.sqlExec(Q.assignmentCreate, [
    assignmentId,
    klass.id,
    c.userId,
    targetUserId,
    kind,
    targetId,
    note,
  ]);

  const countRows = c.nk.sqlQuery(Q.assignmentTargets, [klass.id, targetUserId]);
  const notified = countRows.length === 0 ? 0 : Number((countRows[0] as { n: number }).n);

  audit(c, 'assignment.create', 'class', klass.id, { kind, targetId, targetUserId });

  return { assignmentId, notifiedStudents: notified };
}

export interface ReclaimApproveReq {
  requestId: string;
  approve: boolean;
  idempotencyKey: string;
}

/**
 * Approve or reject a reclaim.
 *
 * On approval the old account's membership is closed and the request is
 * recorded; the progress transfer itself is deliberately *not* automatic —
 * merging two accounts is destructive and irreversible, and doing it from a
 * single click on a dashboard is how a teacher accidentally erases the wrong
 * child's term. R1 records the decision and leaves the merge to a staff
 * operation with the audit trail already in place.
 */
export function teacherReclaimApprove(c: Ctx, req: ReclaimApproveReq) {
  const requestId = requireString(req.requestId, 'requestId', 64);
  if (typeof req.approve !== 'boolean') throw invalidArgument('approve must be a boolean');

  const rows = c.nk.sqlQuery(Q.reclaimById, [requestId]);
  if (rows.length === 0) throw notFound('Reclaim request not found');

  const request = rows[0] as {
    class_id: string;
    target_user_id: string;
    requester_user_id: string;
    status: string;
  };
  requireTeacherOf(c, request.class_id);

  const resolved = c.nk.sqlQuery(Q.reclaimResolve, [
    requestId,
    req.approve ? 'approved' : 'rejected',
    c.userId,
  ]);
  if (resolved.length === 0) throw invalidArgument('That request was already resolved');

  if (req.approve) {
    c.nk.sqlExec(Q.classMemberRemove, [request.class_id, request.target_user_id]);
  }

  audit(c, req.approve ? 'reclaim.approve' : 'reclaim.reject', 'user', request.target_user_id, {
    requestId,
    requesterUserId: request.requester_user_id,
  });

  return {
    status: req.approve ? 'approved' : 'rejected',
    transferredUserId: req.approve ? request.requester_user_id : undefined,
  };
}

/**
 * Every class this teacher owns.
 *
 * The dashboard's landing view. Ownership is the filter — a teacher sees their
 * own classes and nothing else, and this is enforced by the query rather than
 * by the caller passing a school id it could have made up.
 */
export function teacherClassList(c: Ctx) {
  requireRole(c, ['teacher', 'school_admin', 'staff']);

  const rows = c.nk.sqlQuery(Q.classesOwnedBy, [c.userId]) as {
    id: string;
    name: string;
    level: string;
    join_code: string;
    leaderboard_enabled: boolean;
    students: number;
  }[];

  const classes = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (typeof rows)[number];
    classes.push({
      id: row.id,
      name: row.name,
      level: row.level,
      joinCode: row.join_code,
      leaderboardEnabled: row.leaderboard_enabled,
      students: Number(row.students),
    });
  }

  return { classes };
}

/**
 * Remove a student from a class (PRD-TCH-003).
 *
 * Ends the membership; it never deletes the student's work. A teacher tidying
 * a roster must not be able to destroy a term of a child's learning history,
 * and the two operations should not share a button. Deletion is a separate,
 * deliberate path with a thirty-day window (`v1.account.delete.request`).
 */
export function teacherClassRemove(c: Ctx, req: { classId: string; userId: string }) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));
  const userId = requireString(req.userId, 'userId', 64);
  requireMemberOf(c, klass.id, userId);

  c.nk.sqlExec(Q.classMemberRemove, [klass.id, userId]);
  // An adult action on a child's account, so it is audited (TRD-SEC-014).
  audit(c, 'class.member.remove', 'user', userId, { classId: klass.id });

  return { removed: true };
}

/**
 * Turn the class leaderboard off (PRD-SOC-008).
 *
 * A teacher who knows their class knows when ranking helps and when it makes
 * the bottom three stop trying. The setting is theirs, and it is per class
 * rather than global because the answer differs between two classes in the
 * same school.
 */
export function teacherLeaderboardSet(c: Ctx, req: { classId: string; enabled: boolean }) {
  const klass = requireTeacherOf(c, requireString(req.classId, 'classId', 64));
  const enabled = requireBool(req.enabled, 'enabled');

  c.nk.sqlExec(Q.classSetLeaderboard, [klass.id, c.userId, enabled]);
  audit(c, enabled ? 'class.leaderboard.enable' : 'class.leaderboard.disable', 'class', klass.id, {});
  emit(c, 'leaderboard.disabled', { classId: klass.id, enabled });

  return { enabled };
}

// ---------------------------------------------------------------------------
// v1.teacher.consent.* (PRD-ONB-018)
// ---------------------------------------------------------------------------

export interface ConsentRecordReq {
  /** How the school obtained consent, in the school's own words. */
  processNote: string;
  confirmed: boolean;
  idempotencyKey: string;
}

/**
 * Attest that school-level consent is in place.
 *
 * Two things this deliberately does not do. It does not accept a bare boolean:
 * `confirmed: true` with no description records that a box was ticked, and the
 * question a school will actually be asked later is *how*. And it does not
 * claim to be parental consent — R1 has no mechanism to collect that, and
 * naming it so would be a claim the system cannot support (30-03 OQ-02).
 */
export function teacherConsentRecord(c: Ctx, req: ConsentRecordReq) {
  const profile = requireRole(c, ['teacher', 'school_admin', 'staff']);
  if (!profile.schoolId) throw invalidArgument('Your account is not attached to a school');

  if (req.confirmed !== true) {
    throw invalidArgument('Consent must be confirmed explicitly');
  }

  // Long enough to be a description rather than a word. A one-line note reads
  // as a record and is not one.
  const processNote = requireString(req.processNote, 'processNote', 500);
  if (processNote.trim().length < 20) {
    throw invalidArgument('Describe how consent was obtained, so the record means something');
  }

  const existing = c.nk.sqlQuery(Q.consentForSchool, [profile.schoolId]);
  if (existing.length > 0) {
    const row = existing[0] as { id: string; confirmed_at: string; process_note: string | null };
    return {
      consentId: row.id,
      confirmedAt: row.confirmed_at,
      processNote: row.process_note,
      alreadyRecorded: true,
    };
  }

  const consentId = c.nk.uuidv4();
  const rows = c.nk.sqlQuery(Q.consentRecord, [
    consentId,
    profile.schoolId,
    c.userId,
    processNote.trim(),
  ]);
  if (rows.length === 0) throw invalidArgument('Could not record consent');

  const row = rows[0] as { id: string; confirmed_at: string };
  // Audited under the confirming teacher, because this is the record that says
  // who attested — an attestation nobody is named on attests to nothing.
  audit(c, 'consent.record', 'school', profile.schoolId, { consentId: row.id });

  return {
    consentId: row.id,
    confirmedAt: row.confirmed_at,
    processNote: processNote.trim(),
    alreadyRecorded: false,
  };
}

export interface ConsentStatusRes {
  recorded: boolean;
  confirmedAt: string | null;
  processNote: string | null;
}

export function teacherConsentStatus(c: Ctx): ConsentStatusRes {
  const profile = requireRole(c, ['teacher', 'school_admin', 'staff']);
  if (!profile.schoolId) return { recorded: false, confirmedAt: null, processNote: null };

  const rows = c.nk.sqlQuery(Q.consentForSchool, [profile.schoolId]);
  if (rows.length === 0) return { recorded: false, confirmedAt: null, processNote: null };

  const row = rows[0] as { confirmed_at: string; process_note: string | null };
  return { recorded: true, confirmedAt: row.confirmed_at, processNote: row.process_note };
}

/**
 * Withdraw consent.
 *
 * Existing classes are left standing on purpose. Withdrawal stops new classes
 * being created and is the signal to begin deletion; silently unmaking classes
 * mid-term would destroy a teacher's work and a student's record as a side
 * effect of an administrative act, and deletion is a request with its own
 * thirty-day path (PRD-ONB-018).
 */
export function teacherConsentWithdraw(c: Ctx) {
  const profile = requireRole(c, ['school_admin', 'staff']);
  if (!profile.schoolId) throw invalidArgument('Your account is not attached to a school');

  const rows = c.nk.sqlQuery(Q.consentWithdraw, [profile.schoolId]);
  const withdrawn = rows.length > 0;
  if (withdrawn) audit(c, 'consent.withdraw', 'school', profile.schoolId, {});

  return { withdrawn };
}
