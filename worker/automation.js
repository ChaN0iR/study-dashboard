import { DB, P, SUBJECTS, STATUS_DONE } from "./config.js";

export const DAILY_CRON = "10 16 * * *";
const normalizeId = (id) => (id || "").replace(/-/g, "").toLowerCase();

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

export function createAutomation({ notion, queryAll, shapeLesson, rd, wr }) {
  const fullLessonTask = (page) => {
    const p = page.properties || {};
    return rd.check(p[P.task.auto]) && rd.title(p[P.task.title]).startsWith("完成整堂｜") &&
      rd.select(p[P.task.type]) === "初學" && rd.relation(p[P.task.lesson]).length === 1;
  };

  async function syncTaskCompletion(env, task, completedDate, knownLessons) {
    if (task.archived || task.in_trash || !fullLessonTask(task) || !rd.check(task.properties[P.task.done]) ||
        rd.check(task.properties[P.task.skip])) return false;
    // Do not let an arbitrary page outside the task database change a lesson.
    if (normalizeId(task.parent?.database_id) !== normalizeId(DB.tasks)) return false;
    const lessonId = rd.relation(task.properties[P.task.lesson])[0];
    const lesson = knownLessons?.get(normalizeId(lessonId)) || await notion(env, `/pages/${lessonId}`);
    if (lesson.archived || lesson.in_trash || normalizeId(lesson.parent?.database_id) !== normalizeId(DB.lessons)) return false;
    if (rd.select(lesson.properties[P.lesson.status]) === STATUS_DONE) return false;
    await notion(env, `/pages/${lessonId}`, "PATCH", { properties: {
      [P.lesson.status]: wr.select(STATUS_DONE),
      [P.lesson.doneDate]: wr.date(completedDate),
    } });
    // Reconciliation and task retries must never move an existing completion date.
    lesson.properties[P.lesson.status] = wr.select(STATUS_DONE);
    lesson.properties[P.lesson.doneDate] = wr.date(completedDate);
    return true;
  }

  async function runDaily(env, scheduledTime = Date.now()) {
    if (!env.NOTION_TOKEN) throw new Error("worker Notion secret not configured");
    const today = new Date(scheduledTime + 8 * 3600e3).toISOString().slice(0, 10);
    const lessonRows = await queryAll(env, DB.lessons, {
      sorts: [{ property: P.lesson.order, direction: "ascending" }],
    }, Infinity);
    const knownLessons = new Map(lessonRows.map((row) => [normalizeId(row.id), row]));
    // Also repair a previous partial write or a checkbox ticked directly in Notion.
    // This reconciliation runs in the same daily Cron, not in a second scheduler.
    const completed = await queryAll(env, DB.tasks, { filter: { and: [
      { property: P.task.auto, checkbox: { equals: true } },
      { property: P.task.done, checkbox: { equals: true } },
      { property: P.task.skip, checkbox: { equals: false } },
    ] } }, Infinity);
    let synced = 0;
    for (const task of completed) {
      const edited = Date.parse(task.last_edited_time);
      const completedDate = Number.isFinite(edited)
        ? new Date(edited + 8 * 3600e3).toISOString().slice(0, 10) : today;
      if (await syncTaskCompletion(env, task, completedDate, knownLessons)) synced++;
    }
    const lessons = lessonRows.map(shapeLesson);
    const byId = new Map(lessons.map((l) => [normalizeId(l.id), l]));
    const todayRows = await queryAll(env, DB.tasks, {
      filter: { property: P.task.date, date: { equals: today } },
    }, Infinity);
    // A completed/skipped auto task still uses this subject's one daily slot.
    const usedSubjects = new Set(todayRows.filter(fullLessonTask).flatMap((row) =>
      rd.relation(row.properties[P.task.lesson]).map((id) => byId.get(normalizeId(id))?.subject).filter(Boolean)));
    const result = { date: today, created: 0, retained: 0, synced };
    for (const lesson of selectDailyLessons(lessons, today)) {
      if (usedSubjects.has(lesson.subject)) { result.retained++; continue; }
      // Recheck immediately before creating. All matching tasks count, including
      // approved manual tasks. A blocker never causes fallback to a later lesson.
      const blockers = await queryAll(env, DB.tasks, { filter: { and: [
        { property: P.task.lesson, relation: { contains: lesson.id } },
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
      if (blockers.length) { result.retained++; continue; }
      // Avoid scheduling a lesson completed since the initial snapshot.
      const current = await notion(env, `/pages/${lesson.id}`);
      const fresh = shapeLesson(current);
      if (current.archived || current.in_trash || fresh.done || fresh.subject !== lesson.subject ||
          !fresh.weekStart || fresh.weekStart.slice(0, 10) > weekEnd(today)) continue;
      await notion(env, "/pages", "POST", { parent: { database_id: DB.tasks }, properties: {
        [P.task.title]: wr.title(`完成整堂｜${fresh.title}`),
        [P.task.date]: wr.date(today),
        [P.task.source]: wr.select("今日"),
        [P.task.type]: wr.select("初學"),
        [P.task.estimatedMinutes]: wr.number(fresh.minutes),
        [P.task.difficulty]: wr.select(null),
        [P.task.lesson]: { relation: [{ id: lesson.id }] },
        [P.task.makeup]: wr.check(true),
        [P.task.auto]: wr.check(true),
      } });
      usedSubjects.add(lesson.subject);
      result.created++;
    }
    console.log("daily lesson tasks", JSON.stringify(result));
    return result;
  }

  // Serialize duplicate deliveries in one isolate. Database checks also protect
  // ordinary retries across isolates; Notion offers no atomic unique constraint.
  let dailyRun = Promise.resolve();
  return {
    syncTaskCompletion,
    runDaily(env, time) {
      const run = dailyRun.catch(() => {}).then(() => runDaily(env, time));
      dailyRun = run;
      return run;
    },
  };
}
