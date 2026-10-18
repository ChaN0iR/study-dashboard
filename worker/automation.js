import { DB, P, SUBJECTS, STATUS_DONE } from "./config.js";

export const DAILY_CRON = "10 16 * * *";
const normalizeId = (id) => (id || "").replace(/-/g, "").toLowerCase();
const localDate = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

export function weekEnd(today) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (7 - date.getUTCDay()) % 7);
  return date.toISOString().slice(0, 10);
}

export function selectDailyLessons(lessons, today) {
  const end = weekEnd(today);
  const eligible = lessons.filter((l) => !l.done && l.weekStart &&
    l.weekStart.slice(0, 10) <= end && SUBJECTS.includes(l.subject));
  eligible.sort((a, b) => a.weekStart.localeCompare(b.weekStart) ||
    a.order - b.order || a.id.localeCompare(b.id));
  const bySubject = new Map();
  for (const lesson of eligible) if (!bySubject.has(lesson.subject)) bySubject.set(lesson.subject, lesson);
  return [...bySubject.values()];
}

export function createAutomation({ notion, queryAll, shapeLesson, rd, wr, journal }) {
  const requireJournal = () => { if (!journal) throw new Error("durable automation journal required"); };
  const fullLessonTask = (page) => {
    const p = page.properties || {};
    return !page.archived && !page.in_trash && normalizeId(page.parent?.database_id) === normalizeId(DB.tasks) &&
      rd.check(p[P.task.auto]) && rd.title(p[P.task.title]).startsWith("完成整堂｜") &&
      rd.select(p[P.task.type]) === "初學" && rd.relation(p[P.task.lesson]).length === 1;
  };
  const matchesOwned = (task, owned) => fullLessonTask(task) && owned?.owned &&
    normalizeId(rd.relation(task.properties[P.task.lesson])[0]) === normalizeId(owned.lessonId) &&
    rd.text(task.properties[P.task.key]) === owned.operationKey;

  async function operationTasks(env, row) {
    return queryAll(env, DB.tasks, {
      filter: { property: P.task.key, rich_text: { equals: row.operationKey } },
    }, Infinity);
  }

  async function conflict(row, ids, reason) {
    await journal.update(row.key, { state: "conflict", duplicateTaskIds: ids, reason }, "conflict");
    console.error("automation requires reconciliation", JSON.stringify({ slot: row.key, reason, taskIds: ids }));
  }

  async function noteFailure(key, error, result) {
    const safeError = { slot: key, kind: "operation_failed", httpStatus: error.notionStatus || null };
    // State-machine writes already committed before any external create. If
    // storage itself fails, do not guess or release a lock; retain the last state.
    try { await journal.update(key, { lastError: safeError }, "operation_failed"); } catch {}
    result.errors.push(safeError);
    result.held++;
    console.error("automation operation held", JSON.stringify(safeError));
  }

  async function prepareCompletion(env, task, date, source = "dashboard") {
    requireJournal();
    const owned = await journal.getTask(task.id);
    if (!matchesOwned(task, owned) || rd.check(task.properties[P.task.skip])) return false;
    const row = await journal.get(owned.slotKey);
    if (!["created", "skipped", "settled"].includes(row?.state)) return false;
    await journal.completionIntent(task.id, date, source);
    return true;
  }

  async function syncTaskCompletion(env, task, completedDate, knownLessons) {
    requireJournal();
    const owned = await journal.getTask(task.id);
    if (!matchesOwned(task, owned) || !rd.check(task.properties[P.task.done]) || rd.check(task.properties[P.task.skip])) return false;
    const row = await journal.get(owned.slotKey);
    if (!["created", "skipped", "settled"].includes(row?.state)) return false;
    // Never infer completion from last_edited_time: unrelated edits change it.
    // Dashboard intent is persisted before PATCH; direct Notion ticks use first
    // observed Taipei date, explicitly recorded as such, not a claimed event date.
    await journal.completionIntent(task.id, completedDate, "notion_first_observed");
    const recorded = await journal.getTask(task.id);
    if (["applied", "preserved"].includes(recorded.completion.phase)) return false;
    const sameKey = await operationTasks(env, row);
    if (sameKey.length !== 1 || normalizeId(sameKey[0].id) !== normalizeId(task.id)) {
      await conflict(row, sameKey.map((p) => p.id), "completion_identity_not_unique");
      return false;
    }
    // Re-read authoritative values; a stale snapshot cannot complete a changed,
    // skipped, unchecked, archived, or re-related task.
    const fresh = await notion(env, `/pages/${task.id}`);
    if (!matchesOwned(fresh, recorded) || !rd.check(fresh.properties[P.task.done]) || rd.check(fresh.properties[P.task.skip])) return false;
    const lesson = await notion(env, `/pages/${owned.lessonId}`);
    if (lesson.archived || lesson.in_trash || normalizeId(lesson.parent?.database_id) !== normalizeId(DB.lessons)) {
      await conflict(row, [task.id], "lesson_identity_changed");
      return false;
    }
    if (rd.select(lesson.properties[P.lesson.status]) === STATUS_DONE) {
      await journal.completionPhase(task.id, "preserved", { lessonDoneDate: rd.date(lesson.properties[P.lesson.doneDate]) });
      return false;
    }
    const attemptStarted = Date.now();
    await journal.completionPhase(task.id, "lesson_pending", {
      attempts: (recorded.completion.attempts || 0) + 1,
      lastAttemptAt: new Date(attemptStarted).toISOString(), lastError: null,
    });
    try {
      await notion(env, `/pages/${owned.lessonId}`, "PATCH", { properties: {
        [P.lesson.status]: wr.select(STATUS_DONE),
        [P.lesson.doneDate]: wr.date(recorded.completion.date),
      } });
    } catch (error) {
      await journal.completionPhase(task.id, "lesson_pending", {
        lastError: { kind: "lesson_patch_failed_or_unknown", httpStatus: error.notionStatus || null },
        latencyMs: Date.now() - attemptStarted,
      });
      throw error;
    }
    await journal.completionPhase(task.id, "applied", { latencyMs: Date.now() - attemptStarted });
    if (knownLessons?.has(normalizeId(owned.lessonId))) {
      const cached = knownLessons.get(normalizeId(owned.lessonId));
      cached.properties[P.lesson.status] = wr.select(STATUS_DONE);
      cached.properties[P.lesson.doneDate] = wr.date(recorded.completion.date);
    }
    return true;
  }

  async function blockersFor(env, lessonId, today) {
    return queryAll(env, DB.tasks, { filter: { and: [
      { property: P.task.lesson, relation: { contains: lessonId } },
      { or: [
        { property: P.task.date, date: { equals: today } },
        { and: [
          { property: P.task.date, date: { before: today } },
          { property: P.task.makeup, checkbox: { equals: true } },
          { property: P.task.done, checkbox: { equals: false } },
          { property: P.task.skip, checkbox: { equals: false } },
        ] },
      ] },
    ] } }, Infinity);
  }

  async function createReserved(env, row, today) {
    if (row.date !== today || today !== localDate()) return false;
    const blockers = await blockersFor(env, row.lessonId, today);
    if (blockers.length) {
      await journal.update(row.key, { state: "retained", retainedTaskIds: blockers.map((p) => p.id) }, "existing_task_retained");
      await journal.releaseLesson(row);
      return false;
    }
    const current = await notion(env, `/pages/${row.lessonId}`);
    const fresh = shapeLesson(current);
    if (current.archived || current.in_trash || normalizeId(current.parent?.database_id) !== normalizeId(DB.lessons) ||
        fresh.done || fresh.subject !== row.subject || !fresh.weekStart || fresh.weekStart.slice(0, 10) > weekEnd(today)) {
      await journal.update(row.key, { state: "cancelled" }, "lesson_no_longer_eligible");
      await journal.releaseLesson(row);
      return false;
    }
    const properties = {
      [P.task.title]: wr.title(`完成整堂｜${fresh.title}`),
      [P.task.date]: wr.date(today), [P.task.source]: wr.select("今日"),
      [P.task.type]: wr.select("初學"), [P.task.estimatedMinutes]: wr.number(fresh.minutes),
      [P.task.difficulty]: wr.select(null), [P.task.lesson]: { relation: [{ id: row.lessonId }] },
      [P.task.makeup]: wr.check(true), [P.task.auto]: wr.check(true),
      [P.task.key]: wr.text(row.operationKey),
    };
    // This durable write MUST commit before the external POST. Once sending,
    // even a crash before fetch is ambiguous; no TTL/lease ever permits replay.
    const attemptStarted = Date.now();
    await journal.update(row.key, {
      state: "sending", payload: properties, attempts: 1,
      attemptedAt: new Date(attemptStarted).toISOString(),
    }, "create_attempt_started");
    try {
      const task = await notion(env, "/pages", "POST", { parent: { database_id: DB.tasks }, properties });
      if (!task.id) throw new Error("Notion create response missing page id");
      await journal.recordTask(row, task.id);
      await journal.update(row.key, { latencyMs: Date.now() - attemptStarted, lastError: null }, "create_acknowledged");
      return true;
    } catch (error) {
      await journal.update(row.key, {
        state: "uncertain", reason: "create_outcome_unknown", latencyMs: Date.now() - attemptStarted,
        lastError: { kind: "create_failed_or_unknown", httpStatus: error.notionStatus || null },
      }, "create_needs_reconciliation");
      throw error;
    }
  }

  async function reconcile(env, today, result) {
    const scanStarted = Date.now();
    const lastScan = await journal.get("meta:taskScan");
    // Inclusive two-day overlap tolerates normal query indexing delay; active
    // and uncertain operations are always polled regardless of this watermark.
    const since = new Date(Math.max(0, (lastScan?.at || 0) - 2 * 86400e3)).toISOString();
    const changedTasks = await queryAll(env, DB.tasks, { filter: { and: [
      { property: P.task.auto, checkbox: { equals: true } },
      { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
    ] } }, Infinity);
    const changedKeys = new Set(changedTasks.map((task) => rd.text(task.properties[P.task.key])).filter(Boolean));
    for (let row of await journal.listSlots()) {
      try {
      if (row.state === "reserved") {
        if (row.date === today && today === localDate()) {
          if (await createReserved(env, row, today)) result.created++;
        } else if (row.date < today) {
          await journal.update(row.key, { state: "cancelled" }, "unsent_reservation_expired");
          await journal.releaseLesson(row);
        }
        continue;
      }
      if (!["sending", "uncertain", "created", "conflict"].includes(row.state) &&
          !(["settled", "skipped"].includes(row.state) && changedKeys.has(row.operationKey))) continue;
      await journal.update(row.key, {
        reconciliationChecks: (row.reconciliationChecks || 0) + 1,
        lastCheckedAt: new Date().toISOString(),
      }, "reconciliation_started");
      const found = await operationTasks(env, row);
      if (found.length > 1) {
        await conflict(row, found.map((p) => p.id), "duplicate_operation_key");
        result.held++;
        continue;
      }
      if (row.state === "conflict") { result.held++; continue; } // explicit operator review only
      if (!found.length) {
        // Notion query visibility is not proof a timed-out POST failed. Hold the
        // lesson across dates; do not issue a second POST or choose lesson two.
        await journal.update(row.key, { state: "uncertain", reason: "no_visible_result" }, "reconciliation_held");
        console.warn("automation held", JSON.stringify({ slot: row.key, reason: "no_visible_result" }));
        result.held++;
        continue;
      }
      const task = found[0];
      if (row.taskId && normalizeId(row.taskId) !== normalizeId(task.id)) {
        await conflict(row, [row.taskId, task.id], "canonical_task_changed"); result.held++; continue;
      }
      const identity = { owned: true, lessonId: row.lessonId, operationKey: row.operationKey };
      if (!matchesOwned(task, identity)) {
        await conflict(row, [task.id], "task_identity_changed"); result.held++; continue;
      }
      if (!row.taskId) { await journal.recordTask(row, task.id); row = await journal.get(row.key); result.recovered++; }
      await journal.updateTask(task.id, { observedDone: rd.check(task.properties[P.task.done]), observedSkipped: rd.check(task.properties[P.task.skip]) }, "task_observed");
      if (rd.check(task.properties[P.task.skip])) {
        await journal.update(row.key, { state: "skipped" }, "skip_observed");
        await journal.releaseLesson(row);
      } else if (rd.check(task.properties[P.task.done])) {
        if (await syncTaskCompletion(env, task, today)) result.synced++;
        const owned = await journal.getTask(task.id);
        if (["applied", "preserved"].includes(owned?.completion?.phase)) {
          await journal.update(row.key, { state: "settled" }, "completion_settled");
          await journal.releaseLesson(row);
        }
      } else if (row.state === "skipped") {
        await journal.update(row.key, { state: "created" }, "unskip_observed");
      }
      } catch (error) { await noteFailure(row.key, error, result); }
    }
    await journal.storage.put("meta:taskScan", { at: scanStarted });
  }

  async function runDaily(env, scheduledTime = Date.now()) {
    requireJournal();
    if (!env.NOTION_TOKEN) throw new Error("worker Notion secret not configured");
    const today = localDate(scheduledTime);
    const result = { date: today, created: 0, retained: 0, synced: 0, recovered: 0, held: 0, errors: [] };
    await reconcile(env, localDate(), result);
    // Late delivery may reconcile old writes, but must not backfill an old day.
    if (today !== localDate()) return { ...result, stale: true };
    const lessonRows = await queryAll(env, DB.lessons, {
      sorts: [{ property: P.lesson.order, direction: "ascending" }],
    }, Infinity);
    const lessons = lessonRows.map(shapeLesson);
    const byId = new Map(lessons.map((l) => [normalizeId(l.id), l]));
    const todayRows = await queryAll(env, DB.tasks, { filter: { property: P.task.date, date: { equals: today } } }, Infinity);
    const usedSubjects = new Set(todayRows.filter(fullLessonTask).flatMap((task) =>
      rd.relation(task.properties[P.task.lesson]).map((id) => byId.get(normalizeId(id))?.subject).filter(Boolean)));
    for (const lesson of selectDailyLessons(lessons, today)) {
      const key = `slot:${today}:${lesson.subject}`;
      try {
      const existing = await journal.get(key);
      if (existing || usedSubjects.has(lesson.subject)) { result.retained++; continue; }
      const blockers = await blockersFor(env, lesson.id, today);
      if (blockers.length) { result.retained++; continue; }
      const reserved = await journal.reserve(today, lesson.subject, lesson.id, null);
      if (!reserved.acquired) { result.retained++; continue; }
      if (await createReserved(env, reserved.row, today)) result.created++;
      } catch (error) { await noteFailure(key, error, result); }
    }
    console.log("durable daily lesson tasks", JSON.stringify(result));
    return result;
  }

  return { runDaily, syncTaskCompletion, prepareCompletion };
}
