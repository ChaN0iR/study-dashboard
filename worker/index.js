import { DB, P, MOODS, SUBJECTS, STATUS_DONE, STATUS_TODO } from "./config.js";
import { createAutomation, DAILY_CRON } from "./automation.js";
import { AutomationJournal } from "./journal.js";
import { createRescheduler } from "./reschedule.js";

import { authApi, progressApi, authenticatedUser } from "./recall/auth.js";
import { grade as recallGrade } from "./recall/worker.js";
import { fetchRecallAsset } from "./recall/assets.generated.js";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// ---------- helpers ----------
const taipeiDate = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

const json = (data, status = 200, env, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(env), ...extra },
  });

const cors = (env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-headers": "content-type, x-app-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
  vary: "origin",
});

function safeEqual(a = "", b = "") {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function notion(env, path, method = "GET", body, options = {}) {
  const safeRetry = !options.once && (method === "GET" || method === "PATCH" || path.endsWith("/query"));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: {
        authorization: `Bearer ${env.NOTION_TOKEN}`,
        "notion-version": NOTION_VERSION,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // Creation has no server-enforced idempotency key. Send it once only,
    // including a 429 response; reconcile any unknown outcome in durable state.
    if (safeRetry && attempt < 3 && (res.status === 429 || res.status >= 500)) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Math.min(60, Math.max(1, retryAfter || 2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      continue;
    }
    const error = new HttpError(502, `Notion ${res.status}: ${data.message || "error"}`);
    error.notionStatus = res.status;
    throw error;
  }
}

async function queryAll(env, dbId, body, maxRows = 500) {
  const out = [];
  let cursor;
  do {
    const r = await notion(env, `/databases/${dbId}/query`, "POST", {
      page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && out.length < maxRows);
  return out;
}

// property readers
const txt = (arr) => (arr || []).map((t) => t.plain_text).join("");
const rd = {
  title: (p) => txt(p?.title),
  text: (p) => txt(p?.rich_text),
  check: (p) => !!p?.checkbox,
  select: (p) => p?.select?.name || null,
  number: (p) => (typeof p?.number === "number" ? p.number : null),
  date: (p) => p?.date?.start || null,
  formula: (p) => {
    const f = p?.formula;
    if (!f) return null;
    return f[f.type] ?? null;
  },
  relation: (p) => (p?.relation || []).map((r) => r.id),
};

// property writers
const wr = {
  text: (s) => ({
    rich_text: String(s ?? "").match(/[\s\S]{1,2000}/g)?.map((c) => ({ text: { content: c } })) || [],
  }),
  title: (s) => ({ title: [{ text: { content: String(s).slice(0, 2000) } }] }),
  check: (b) => ({ checkbox: !!b }),
  number: (n) => ({ number: n === null || n === "" || n === undefined ? null : Number(n) }),
  select: (n) => ({ select: n ? { name: n } : null }),
  date: (d) => ({ date: d ? { start: d } : null }),
};

function num(v, name, max) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${name} invalid`);
  return n;
}

const fmtYpt = (h, m) => {
  const total = Math.round((h || 0) * 60 + (m || 0));
  return total ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m` : "";
};

// ---------- shapers ----------
const shapeTask = (pg) => ({
  id: pg.id,
  title: rd.title(pg.properties[P.task.title]),
  done: rd.check(pg.properties[P.task.done]),
  skipped: rd.check(pg.properties[P.task.skip]),
  source: rd.select(pg.properties[P.task.source]) || "今日",
  date: rd.date(pg.properties[P.task.date]),
  order: rd.number(pg.properties[P.task.order]) ?? 999,
  type: rd.select(pg.properties[P.task.type]) || null,
  makeup: rd.check(pg.properties[P.task.makeup]),
  carryover: false,
  prerequisiteTaskIds: rd.relation(pg.properties[P.task.prerequisites]),
  blocked: false,
  estimatedMinutes: rd.number(pg.properties[P.task.estimatedMinutes]),
  difficulty: rd.select(pg.properties[P.task.difficulty]),
  relatedLessonIds: rd.relation(pg.properties[P.task.lesson]),
  relatedSubjects: [],
  relatedCourses: [],
});

const shapeRecord = (pg) => {
  const p = pg.properties;
  const h = rd.number(p[P.record.hours]);
  const m = rd.number(p[P.record.minutes]);
  return {
    id: pg.id,
    date: rd.date(p[P.record.date]),
    hours: h, minutes: m,
    ypt: rd.formula(p[P.record.ypt]) || fmtYpt(h, m),
    review: rd.text(p[P.record.review]),
    points: rd.text(p[P.record.points]),
    workout: rd.text(p[P.record.workout]),
    mood: rd.select(p[P.record.mood]),
    completion: rd.formula(p[P.record.completion]),
  };
};

const shapeLesson = (pg) => {
  const p = pg.properties, L = P.lesson;
  return {
    id: pg.id,
    title: rd.title(p[L.title]),
    status: rd.select(p[L.status]) || STATUS_TODO,
    done: rd.select(p[L.status]) === STATUS_DONE,
    doneDate: rd.date(p[L.doneDate]),
    type: rd.select(p[L.type]),
    subject: rd.select(p[L.subject]),
    course: rd.select(p[L.course]),
    minutes: rd.number(p[L.length]),
    week: rd.text(p[L.weekLabel]),
    weekStart: rd.date(p[L.weekStart]),
    reviews: rd.number(p[L.reviews]) ?? 0,
    next: rd.formula(p[L.nextReview]),
    due: rd.formula(p[L.due]),
    order: rd.number(p[L.order]) ?? 0,
  };
};

async function durableCall(env, path, body) {
  if (!env.LESSON_AUTOMATION) throw new HttpError(503, "durable automation binding not configured");
  const id = env.LESSON_AUTOMATION.idFromName("study-dashboard-lessons-v1");
  const response = await env.LESSON_AUTOMATION.get(id).fetch(`https://automation.internal${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new HttpError(response.status, result.error || "durable automation failed");
  return result;
}

// ---------- data ops ----------
async function findTodayRecord(env, today) {
  const r = await notion(env, `/databases/${DB.records}/query`, "POST", {
    page_size: 1,
    filter: { property: P.record.date, date: { equals: today } },
  });
  return r.results[0] || null;
}

async function getOrCreateRecord(env, today) {
  const found = await findTodayRecord(env, today);
  if (found) return found;
  return notion(env, "/pages", "POST", {
    parent: { database_id: DB.records },
    properties: {
      [P.record.title]: wr.title(today),
      [P.record.date]: wr.date(today),
    },
  });
}

async function getState(env) {
  const today = taipeiDate();
  const weekFloor = taipeiDate(-7);
  const [todayTaskRows, carryoverRows, rec, lessonRows] = await Promise.all([
    queryAll(env, DB.tasks, {
      filter: { property: P.task.date, date: { equals: today } },
      sorts: [{ property: P.task.order, direction: "ascending" }],
    }),
    queryAll(env, DB.tasks, {
      filter: { and: [
        { property: P.task.date, date: { before: today } },
        { property: P.task.makeup, checkbox: { equals: true } },
      ] },
      sorts: [{ property: P.task.date, direction: "descending" }, { property: P.task.order, direction: "ascending" }],
    }),
    findTodayRecord(env, today),
    queryAll(env, DB.lessons, {
      sorts: [{ property: P.lesson.order, direction: "ascending" }],
    }),
  ]);
  const allLessons = lessonRows.map(shapeLesson);
  const lessons = allLessons.filter((l) =>
    (l.done && l.doneDate === today) ||
    (l.weekStart && l.weekStart <= today && (!l.done || l.weekStart > weekFloor))
  );
  const lessonsById = new Map(allLessons.map((l) => [l.id, l]));
  const todayTasks = todayTaskRows.map(shapeTask);
  const todayTaskIds = new Set(todayTasks.map((task) => task.id));
  const priorTasks = carryoverRows.map(shapeTask)
    .filter((task) => task.makeup && !task.done && !task.skipped && !todayTaskIds.has(task.id))
    .map((task) => ({ ...task, carryover: true }));
  const tasksWithoutDependencies = [...todayTasks, ...priorTasks];
  const taskById = new Map(tasksWithoutDependencies.map((task) => [task.id, task]));
  const prerequisiteIds = [...new Set(tasksWithoutDependencies.flatMap((task) => task.prerequisiteTaskIds))];
  const missingPrerequisites = prerequisiteIds.filter((id) => !taskById.has(id));
  const prerequisiteRows = await Promise.all(missingPrerequisites.map(async (id) => {
    try { return [id, shapeTask(await notion(env, `/pages/${id}`))]; }
    catch { return [id, null]; }
  }));
  for (const [id, task] of prerequisiteRows) taskById.set(id, task);
  const tasks = tasksWithoutDependencies.map((task) => ({
    ...task,
    blocked: task.prerequisiteTaskIds.some((id) => !taskById.get(id) || taskById.get(id).done !== true),
  })).map((t) => {
    const related = t.relatedLessonIds.map((id) => lessonsById.get(id)).filter(Boolean);
    return {
      ...t,
      relatedSubjects: [...new Set(related.map((l) => l.subject).filter(Boolean))],
      relatedCourses: [...new Set(related.map((l) => l.course).filter(Boolean))],
    };
  });
  const byCourse = new Map();
  for (const l of allLessons) {
    const key = l.course || `未設定課程:${l.subject || "未知科目"}`;
    let g = byCourse.get(key);
    if (!g) {
      g = { course: l.course, subjects: new Set(), total: 0, done: 0, unscheduled: 0, order: l.order, nextUpcoming: null };
      byCourse.set(key, g);
    }
    if (l.subject) g.subjects.add(l.subject);
    g.order = Math.min(g.order, l.order);
    g.total++;
    if (l.done) g.done++;
    else if (!l.weekStart) g.unscheduled++;
    else if (l.weekStart > today) {
      const current = g.nextUpcoming;
      if (!current || l.weekStart < current.weekStart || (l.weekStart === current.weekStart && l.order < current.order)) {
        g.nextUpcoming = { title: l.title, weekStart: l.weekStart, order: l.order };
      }
    }
  }
  const courseStats = [...byCourse.values()].map((g) => {
    const subjects = [...g.subjects];
    const subject = subjects.length === 1 ? subjects[0] : null;
    return {
      course: g.course,
      name: g.course || `${subject || "未分類"}（未設定課程）`,
      subject,
      subjects,
      total: g.total,
      done: g.done,
      unscheduled: g.unscheduled,
      order: g.order,
      nextUpcoming: g.nextUpcoming ? { title: g.nextUpcoming.title, weekStart: g.nextUpcoming.weekStart } : null,
    };
  }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return {
    today,
    tasks,
    record: rec ? shapeRecord(rec) : null,
    lessons,
    courseStats,
  };
}

async function postTask(env, id, body, automation) {
  const props = {};
  if (body.done === true && body.skip === true) throw new HttpError(400, "done and skip cannot both be true");
  if (typeof body.done === "boolean") props[P.task.done] = wr.check(body.done);
  if (typeof body.skip === "boolean") props[P.task.skip] = wr.check(body.skip);
  if (!Object.keys(props).length) throw new HttpError(400, "need done or skip (boolean)");
  if (body.done === true) {
    const task = await notion(env, `/pages/${id}`);
    const prerequisiteIds = rd.relation(task.properties?.[P.task.prerequisites]);
    const prerequisites = await Promise.all(prerequisiteIds.map((prerequisiteId) =>
      notion(env, `/pages/${prerequisiteId}`)
    ));
    if (prerequisites.some((prerequisite) =>
      !rd.check(prerequisite.properties?.[P.task.done]) || rd.check(prerequisite.properties?.[P.task.skip])
    )) throw new HttpError(409, "prerequisites incomplete");
    await automation.prepareCompletion(env, {
      ...task, properties: { ...task.properties, ...(typeof body.skip === "boolean" ? { [P.task.skip]: wr.check(body.skip) } : {}) },
    }, taipeiDate());
  }
  const updated = await notion(env, `/pages/${id}`, "PATCH", { properties: props });
  if (body.done === true) await automation.syncTaskCompletion(env, updated, taipeiDate());
  return shapeTask(updated);
}

async function postRecord(env, body) {
  const today = taipeiDate();
  const rec = await getOrCreateRecord(env, today);
  const props = {};
  if ("hours" in body) props[P.record.hours] = wr.number(num(body.hours, "hours", 24));
  if ("minutes" in body) props[P.record.minutes] = wr.number(num(body.minutes, "minutes", 1440));
  if ("心得" in body) props[P.record.review] = wr.text(body["心得"]);
  if ("重點" in body) props[P.record.points] = wr.text(body["重點"]);
  if ("運動" in body) props[P.record.workout] = wr.text(body["運動"]);
  if ("心情" in body) {
    if (body["心情"] && !MOODS.includes(body["心情"])) throw new HttpError(400, "mood invalid");
    props[P.record.mood] = wr.select(body["心情"] || null);
  }
  if (!Object.keys(props).length) return shapeRecord(rec);
  return shapeRecord(await notion(env, `/pages/${rec.id}`, "PATCH", { properties: props }));
}

async function postLesson(env, id, body) {
  const today = taipeiDate();
  const props = {};
  if (typeof body.done === "boolean") {
    props[P.lesson.status] = wr.select(body.done ? STATUS_DONE : STATUS_TODO);
    props[P.lesson.doneDate] = wr.date(body.done ? today : null);
  }
  if (body.review === true) {
    const cur = await notion(env, `/pages/${id}`);
    props[P.lesson.reviews] = wr.number((rd.number(cur.properties[P.lesson.reviews]) || 0) + 1);
    props[P.lesson.lastReview] = wr.date(today);
  }
  if (!Object.keys(props).length) throw new HttpError(400, "need done (boolean) or review:true");
  return shapeLesson(await notion(env, `/pages/${id}`, "PATCH", { properties: props }));
}

async function postNote(env, body) {
  const title = String(body.title || "").trim();
  if (!title) throw new HttpError(400, "title required");
  const props = {
    [P.note.title]: wr.title(title),
    [P.note.date]: wr.date(taipeiDate()),
    [P.note.status]: wr.select("未複習"),
  };
  if (body.subject) {
    if (!SUBJECTS.includes(body.subject)) throw new HttpError(400, "subject invalid");
    props[P.note.subject] = wr.select(body.subject);
  }
  if (body.chapter) props[P.note.chapter] = wr.text(body.chapter);
  if (body.points) props[P.note.points] = wr.text(body.points);
  if (body.lessonId) {
    if (!ID_RE.test(body.lessonId)) throw new HttpError(400, "lessonId invalid");
    props[P.note.lesson] = { relation: [{ id: body.lessonId }] };
  }
  const pg = await notion(env, "/pages", "POST", { parent: { database_id: DB.notes }, properties: props });
  const pagesIn = Array.isArray(body.pages) ? body.pages : [{ photos: body.photos }];
  const blocks = [];
  let count = 0;
  for (let pi = 0; pi < pagesIn.length; pi++) {
    const phs = (Array.isArray(pagesIn[pi] && pagesIn[pi].photos) ? pagesIn[pi].photos : []).slice(0, 8);
    if (!phs.length) continue;
    if (pagesIn.length > 1) blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `第 ${pi + 1} 頁` } }] } });
    for (const ph of phs) {
    if (++count > 8) break;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(ph.type || "") || typeof ph.data !== "string" || ph.data.length > 4_000_000) continue;
    const up = await notion(env, "/file_uploads", "POST", { filename: String(ph.name || "photo.jpg").slice(0, 80), content_type: ph.type });
    const bin = Uint8Array.from(atob(ph.data), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new Blob([bin], { type: ph.type }), String(ph.name || "photo.jpg").slice(0, 80));
    const r = await fetch(`${NOTION}/file_uploads/${up.id}/send`, { method: "POST", headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "notion-version": NOTION_VERSION }, body: form });
    if (!r.ok) throw new HttpError(502, `Notion upload ${r.status}`);
    blocks.push({ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: up.id } } });
    }
  }
  if (blocks.length) await notion(env, `/blocks/${pg.id}/children`, "PATCH", { children: blocks });
  return { id: pg.id, title, photos: count };
}


// ---------- focus timer ----------
const F = { title: "紀錄", date: "日期", start: "開始", end: "結束", acc: "累計秒", status: "狀態", subject: "科目" };
const tpIso = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + "+08:00";
const shapeFocus = (pg) => {
  const p = pg.properties;
  let start = rd.date(p[F.start]) ? Date.parse(rd.date(p[F.start])) : null;
  // Notion keeps dates to the minute; the exact seconds ride in the title as HH:MM:SS
  const ti = ((p[F.title] && p[F.title].title) || []).map((x) => x.plain_text || "").join("");
  const tm = ti.match(/(\d{2}):(\d{2}):(\d{2})$/);
  if (start !== null && tm && Math.floor((start + 8 * 3600e3) / 60000) % 60 === +tm[2]) start += +tm[3] * 1000;
  return {
    id: pg.id,
    status: rd.select(p[F.status]),
    start,
    end: rd.date(p[F.end]) ? Date.parse(rd.date(p[F.end])) : null,
    acc: rd.number(p[F.acc]) || 0,
    subject: rd.select(p[F.subject]),
    date: rd.date(p[F.date]),
  };
};

async function getFocus(env, exclude = [], hint = {}) {
  const today = taipeiDate();
  const since = taipeiDate(-29);
  const rows = (await queryAll(env, DB.focus, {
    filter: { property: F.date, date: { on_or_after: since } },
    sorts: [{ property: F.start, direction: "descending" }],
  })).map(shapeFocus).filter((r) => !exclude.includes(r.id));
  if (hint.justDone) { const k = rows.findIndex((r) => r.id === hint.justDone.id); if (k >= 0) rows[k] = hint.justDone; else rows.push(hint.justDone); }
  if (hint.justStarted && !rows.some((r) => r.id === hint.justStarted.id)) rows.unshift(shapeFocus(hint.justStarted));
  rows.sort((a, b) => (b.start || 0) - (a.start || 0));
  const active = rows.find((r) => r.status === "進行中" || r.status === "暫停") || null;
  const done = rows.filter((r) => r.status === "完成");
  const days = {};
  for (const r of done) {
    const d = (days[r.date] ||= { date: r.date, sec: 0, count: 0 });
    d.sec += r.acc; d.count++;
  }
  return {
    now: Date.now(),
    today,
    active,
    todayDoneSec: done.filter((r) => r.date === today).reduce((a, r) => a + r.acc, 0),
    sessions: done.filter((r) => r.date === today).sort((a, b) => a.start - b.start),
    history: done.slice().sort((a, b) => b.start - a.start).slice(0, 80),
    days: Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

async function startFocus(env, body, now, justDone) {
  const subject = body.subject && SUBJECTS.includes(body.subject) ? body.subject : null;
  const pg = await notion(env, "/pages", "POST", { parent: { database_id: DB.focus }, properties: {
    [F.title]: wr.title("專注 " + tpIso(now).slice(11, 19)),
    [F.date]: wr.date(taipeiDate()),
    [F.start]: wr.date(tpIso(now)),
    [F.acc]: wr.number(0),
    [F.status]: wr.select("進行中"),
    ...(subject ? { [F.subject]: wr.select(subject) } : {}),
  } });
  return getFocus(env, [], { justDone, justStarted: pg });
}

async function postFocus(env, body) {
  const action = body.action;
  if (action === "stats") {
    const all = await queryAll(env, DB.focus, { sorts: [{ property: F.start, direction: "descending" }] });
    const by = {};
    let total = 0;
    for (const r of all.map(shapeFocus)) { if (r.status !== "完成" || !r.date) continue; by[r.date] = (by[r.date] || 0) + r.acc; total += r.acc; }
    return { total, days: Object.keys(by).sort().map((d) => ({ date: d, sec: by[d] })) };
  }
  const cur = (await getFocus(env)).active;
  const now = Date.now();
  if (action === "add") {
    const date = String(body.date || ""), time = /^\d{2}:\d{2}$/.test(body.time || "") ? body.time : "12:00";
    const mins = Math.round(Number(body.minutes));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(mins >= 1 && mins <= 1440)) throw new HttpError(400, "date/minutes invalid");
    const st = Date.parse(`${date}T${time}:00+08:00`);
    if (!Number.isFinite(st)) throw new HttpError(400, "date invalid");
    const subject = body.subject && SUBJECTS.includes(body.subject) ? body.subject : null;
    const pg = await notion(env, "/pages", "POST", { parent: { database_id: DB.focus }, properties: {
      [F.title]: wr.title("補登 " + date.slice(5) + " " + time),
      [F.date]: wr.date(date),
      [F.start]: wr.date(tpIso(st)),
      [F.end]: wr.date(tpIso(st + mins * 60000)),
      [F.acc]: wr.number(mins * 60),
      [F.status]: wr.select("完成"),
      ...(subject ? { [F.subject]: wr.select(subject) } : {}),
    } });
    return getFocus(env, [], { justDone: shapeFocus(pg) });
  }
  if (action === "delete") {
    if (!ID_RE.test(body.id || "")) throw new HttpError(400, "id invalid");
    const pg = await notion(env, `/pages/${body.id}`);
    if ((pg.parent?.database_id || "").replace(/-/g, "") !== DB.focus) throw new HttpError(400, "not a focus record");
    await notion(env, `/pages/${body.id}`, "PATCH", { archived: true });
    return getFocus(env, [body.id]);
  }
  if (action === "switch" && !cur) return startFocus(env, body, now);
  if (action === "switch") {
    const run = cur.status === "進行中";
    const acc = cur.acc + (run && cur.start ? Math.max(0, Math.round((now - cur.start) / 1000)) : 0);
    await notion(env, `/pages/${cur.id}`, "PATCH", { properties: { [F.acc]: wr.number(acc), [F.end]: wr.date(tpIso(now)), [F.status]: wr.select("完成") } });
    const done = { ...cur, acc, end: now, status: "完成" };
    return startFocus(env, body, now, done);
  }
  if (action === "start") {
    if (cur) return getFocus(env);
    return startFocus(env, body, now);
  }
  if (!cur) return getFocus(env);
  const running = cur.status === "進行中";
  const acc = cur.acc + (running && cur.start ? Math.max(0, Math.round((now - cur.start) / 1000)) : 0);
  let props;
  if (action === "pause") { if (!running) return getFocus(env); props = { [F.acc]: wr.number(acc), [F.status]: wr.select("暫停") }; }
  else if (action === "resume") { if (running) return getFocus(env); props = { [F.title]: wr.title("專注 " + tpIso(now).slice(11, 19)), [F.start]: wr.date(tpIso(now)), [F.status]: wr.select("進行中") }; }
  else if (action === "stop") props = { [F.acc]: wr.number(acc), [F.end]: wr.date(tpIso(now)), [F.status]: wr.select("完成") };
  else if (action === "subject") props = { [F.subject]: wr.select(SUBJECTS.includes(body.subject) ? body.subject : null) };
  else throw new HttpError(400, "bad action");
  const upd = await notion(env, `/pages/${cur.id}`, "PATCH", { properties: props });
  return getFocus(env, [], { justDone: shapeFocus(upd) });
}

// One named actor owns all automatic creates and task completion writes. The
// promise queue serializes fetch awaits; durable journal state protects restarts.
// No network I/O runs inside a storage transaction / blockConcurrencyWhile.
export class LessonAutomationCoordinator {
  constructor(ctx, env) {
    this.env = env;
    this.queue = Promise.resolve();
    this.journal = new AutomationJournal(ctx.storage);
    this.rescheduler = createRescheduler({ notion, rd, wr, storage: ctx.storage });
    this.automation = createAutomation({ notion, queryAll, shapeLesson, rd, wr, journal: this.journal,
      onCompletion: (lesson) => this.rescheduler.recordCompletion(lesson) });
  }
  fetch(request) {
    const run = this.queue.catch(() => {}).then(async () => {
      try {
        if (request.method !== "POST") throw new HttpError(405, "method not allowed");
        const body = await request.json();
        const path = new URL(request.url).pathname;
        if (path === "/audit") {
          if (body.taskId && !ID_RE.test(body.taskId)) throw new HttpError(400, "bad task id");
          if (body.taskId) return Response.json({ task: await this.journal.getTask(body.taskId) || null });
          const slots = (await this.journal.listSlots()).sort((a, b) => a.key.localeCompare(b.key));
          const page = slots.filter((row) => !body.cursor || row.key > body.cursor).slice(0, 100);
          return Response.json({ storage: "durable-object", version: 1, slots: page,
            nextCursor: page.length === 100 ? page[page.length - 1].key : null });
        }
        if (path === "/daily") {
          if (body.cron !== DAILY_CRON || !Number.isFinite(body.scheduledTime)) throw new HttpError(400, "invalid cron event");
          const result = await this.automation.runDaily(this.env, body.scheduledTime);
          if (!result.stale) await this.rescheduler.refresh(this.env);
          return Response.json(result);
        }
        if (path === "/task" && ID_RE.test(body.id || "")) {
          const result = await postTask(this.env, body.id, body.patch || {}, this.automation);
          if (body.patch?.done === true) await this.rescheduler.refresh(this.env);
          return Response.json(result);
        }
        if (path === "/lesson" && ID_RE.test(body.id || "")) {
          const wasDone = body.patch?.done === true &&
            rd.select((await notion(this.env, `/pages/${body.id}`)).properties?.[P.lesson.status]) === STATUS_DONE;
          const result = await postLesson(this.env, body.id, body.patch || {});
          if (body.patch?.done === true) {
            if (!wasDone) await this.rescheduler.recordCompletion(result);
            await this.rescheduler.refresh(this.env);
          }
          return Response.json(result);
        }
        if (path === "/reschedule") return Response.json(await this.rescheduler.current());
        if (path === "/reschedule/approve")
          return Response.json(await this.rescheduler.approve(this.env, body.id, body.approve));
        throw new HttpError(404, "not found");
      } catch (error) {
        return Response.json({ error: error.message || "durable automation failed" }, { status: error.status || 500 });
      }
    });
    this.queue = run;
    return run;
  }
}

// ---------- router ----------
const recallJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" },
});

async function recallGradeForUser(request, env) {
  if (!env.DB) return recallJson({ code: "AUTH_STORAGE_NOT_CONFIGURED" }, 503);
  try {
    if (!(await authenticatedUser(env, request))) return recallJson({ code: "UNAUTHORIZED" }, 401);
  } catch {
    return recallJson({ code: "AUTH_STORAGE_ERROR" }, 503);
  }
  return recallGrade(request, env);
}

async function recallAsset(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const url = new URL(request.url);
  if (url.pathname === "/recall") return new Response(null, { status: 308, headers: { location: "/recall/" } });
  url.pathname = url.pathname.slice("/recall".length) || "/";
  return fetchRecallAsset(new Request(url, request));
}

export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron !== DAILY_CRON) throw new Error("unexpected daily lesson cron");
    const run = durableCall(env, "/daily", { cron: controller.cron, scheduledTime: controller.scheduledTime });
    ctx.waitUntil(run);
    await run;
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/recall" || url.pathname.startsWith("/recall/")) return recallAsset(request);
      if (url.pathname.startsWith("/api/auth/")) return authApi(request, env, url.pathname);
      if (url.pathname === "/api/progress") return progressApi(request, env);
      if (url.pathname === "/api/grade") return recallGradeForUser(request, env);
      if (path === "/" || path === "/health") return json({ ok: true }, 200, env);
      if (!env.APP_KEY) throw new HttpError(500, "worker secrets not configured");
      if (!safeEqual(request.headers.get("x-app-key") || "", env.APP_KEY)) throw new HttpError(401, "bad app key");
      if (!env.NOTION_TOKEN && !(request.method === "GET" && path === "/api/automation/audit"))
        throw new HttpError(500, "worker secrets not configured");

      const readBody = async () => {
        try { return (await request.json()) || {}; } catch { throw new HttpError(400, "invalid JSON"); }
      };
      const seg = path.split("/").filter(Boolean); // ["api", ...]
      if (seg[0] !== "api") throw new HttpError(404, "not found");

      if (request.method === "GET" && seg[1] === "state" && seg.length === 2)
        return json(await getState(env), 200, env, { "cache-control": "no-store" });

      if (request.method === "GET" && seg[1] === "reschedule" && seg.length === 2)
        return json(await durableCall(env, "/reschedule", {}), 200, env, { "cache-control": "no-store" });

      if (request.method === "GET" && seg[1] === "automation" && seg[2] === "audit" && seg.length === 3)
        return json(await durableCall(env, "/audit", {
          taskId: url.searchParams.get("taskId"), cursor: url.searchParams.get("cursor"),
        }), 200, env, { "cache-control": "no-store" });

      if (request.method === "GET" && seg[1] === "focus" && seg.length === 2)
        return json(await getFocus(env), 200, env, { "cache-control": "no-store" });

      if (request.method === "POST") {
        if (seg[1] === "reschedule" && seg[3] === "approve" && seg.length === 4 && /^r\d+$/.test(seg[2])) {
          const body = await readBody();
          return json(await durableCall(env, "/reschedule/approve", { id: seg[2], approve: body.approve }), 200, env);
        }
        if (seg[1] === "focus" && seg.length === 2) return json(await postFocus(env, await readBody()), 200, env);
        if (seg[1] === "record" && seg.length === 2) return json(await postRecord(env, await readBody()), 200, env);
        if (seg[1] === "note" && seg.length === 2) return json(await postNote(env, await readBody()), 200, env);
        if ((seg[1] === "task" || seg[1] === "lesson") && seg.length === 3) {
          if (!ID_RE.test(seg[2])) throw new HttpError(400, "bad id");
          const body = await readBody();
          return json(await durableCall(env, `/${seg[1]}`, { id: seg[2], patch: body }), 200, env);
        }
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e.message || "error" }, status, env);
    }
  },
};
