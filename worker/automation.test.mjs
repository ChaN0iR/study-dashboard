import assert from "node:assert/strict";
import worker from "./index.js";
import { createAutomation, DAILY_CRON, selectDailyLessons, weekEnd } from "./automation.js";
import { DB, P, SUBJECTS, STATUS_DONE } from "./config.js";
import AutomationJournal from "./journal.js";
import { makeNamespace } from "./test-fixtures.mjs";

const NOW = Date.parse("2026-10-18T16:10:00Z");
const TODAY = "2026-10-19"; // 2026-10-18T16:10Z is 2026-10-19 in Taipei
const id = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const calls = [];
const pages = new Map();
let failLessonPatchOnce = 0;
let retry429 = 0;
let create503 = false;

const title = (s) => ({ title: [{ plain_text: s, text: { content: s } }] });
const rich = (s = "") => ({ rich_text: [{ plain_text: s, text: { content: s } }] });
const select = (name) => ({ select: name == null ? null : { name } });
const date = (start) => ({ date: start == null ? null : { start } });
const checkbox = (checked = false) => ({ checkbox: !!checked });
const number = (n) => ({ number: n });
const relation = (xs = []) => ({ relation: xs.map((x) => ({ id: x })) });
const props = (values) => ({
  [P.task.title]: title(values.title ?? "任務"), [P.task.done]: checkbox(values.done),
  [P.task.skip]: checkbox(values.skip), [P.task.date]: date(values.date ?? TODAY),
  [P.task.order]: number(values.order ?? 1), [P.task.type]: select(values.type ?? "複習"),
  [P.task.source]: select(values.source ?? "今日"), [P.task.lesson]: relation(values.lessons),
  [P.task.makeup]: checkbox(values.makeup), [P.task.auto]: checkbox(values.auto),
  [P.task.prerequisites]: relation(values.prerequisites), [P.task.estimatedMinutes]: number(values.minutes ?? 45),
  [P.task.difficulty]: select(values.difficulty ?? null),
});
const task = (n, values = {}, parent = DB.tasks) => ({ id: id(n), parent: { database_id: parent }, last_edited_time: values.lastEdited ?? "2026-10-19T02:00:00.000Z", properties: props(values) });
const lesson = (n, values = {}, parent = DB.lessons) => ({
  id: id(n), parent: { database_id: parent }, last_edited_time: "2026-10-18T00:00:00.000Z",
  properties: {
    [P.lesson.title]: title(values.title ?? `第${n}堂`), [P.lesson.status]: select(values.status ?? "未開始"),
    [P.lesson.subject]: select(values.subject ?? "化學"), [P.lesson.course]: select(values.course ?? "主課"),
    [P.lesson.length]: number(values.minutes ?? 45), [P.lesson.weekLabel]: rich(values.week ?? "第1週"),
    [P.lesson.weekStart]: date(values.weekStart ?? TODAY), [P.lesson.reviews]: number(0),
    [P.lesson.order]: number(values.order ?? n), [P.lesson.doneDate]: date(values.doneDate ?? null),
  },
});

// A complete local Notion evaluator: and/or, checkbox, relation and date operators are all exercised.
const plain = (p) => (p?.title || p?.rich_text || []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
const valueFor = (page, name) => page.properties?.[name] ?? {};
function matches(page, f) {
  if (!f) return true;
  if (f.and) return f.and.every((x) => matches(page, x));
  if (f.or) return f.or.some((x) => matches(page, x));
  const name = f.property;
  const p = valueFor(page, name);
  if (f.checkbox) return !!p.checkbox === f.checkbox.equals;
  if (f.relation) return (p.relation || []).some((r) => r.id.replaceAll("-", "").toLowerCase() === f.relation.contains.replaceAll("-", "").toLowerCase());
  if (f.date) {
    const got = p.date?.start?.slice(0, 10) || null;
    if (f.date.equals !== undefined) return got === f.date.equals;
    if (f.date.before !== undefined) return !!got && got < f.date.before;
    if (f.date.after !== undefined) return !!got && got > f.date.after;
    if (f.date.on_or_after !== undefined) return !!got && got >= f.date.on_or_after;
    if (f.date.on_or_before !== undefined) return !!got && got <= f.date.on_or_before;
    return true;
  }
  if (f.title) return plain(p) === f.title.equals;
  if (f.rich_text) return plain(p) === f.rich_text.equals;
  return true;
}
function sortRows(rows, sorts = []) {
  return rows.slice().sort((a, b) => {
    for (const s of sorts) {
      const av = a.properties?.[s.property]?.number ?? a.properties?.[s.property]?.date?.start ?? plain(a.properties?.[s.property]);
      const bv = b.properties?.[s.property]?.number ?? b.properties?.[s.property]?.date?.start ?? plain(b.properties?.[s.property]);
      if (av !== bv) return (av < bv ? -1 : 1) * (s.direction === "descending" ? -1 : 1);
    }
    return a.id.localeCompare(b.id);
  });
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }

// Seed >500 lesson rows so automation's Infinity query must walk every page.
const lessonIds = [];
for (let n = 1; n <= 505; n++) {
  const l = lesson(n, { subject: "化學", course: "大量課程", status: STATUS_DONE, weekStart: `2026-10-${String((n % 7) + 1).padStart(2, "0")}`, order: n });
  pages.set(l.id, l); lessonIds.push(l.id);
}
const ids = { blockedChem: id(700), laterChem: id(701), manualPhysics: id(702), bio: id(703), english: id(704), future: id(705), noWeek: id(706), done: id(707), retry: id(708), doneDate: id(709) };
for (const [key, n, vals] of [
  ["blockedChem", 700, { subject: "化學", weekStart: "2026-10-13", order: 1, title: "化學逾期最早" }],
  ["laterChem", 701, { subject: "化學", weekStart: "2026-10-18", order: 2, title: "化學後選" }],
  ["manualPhysics", 702, { subject: "物理", weekStart: TODAY, order: 1, title: "物理被手動任務擋住" }],
  ["bio", 703, { subject: "生物", weekStart: TODAY, order: 1, title: "生物今日" }],
  ["english", 704, { subject: "英文", weekStart: "2026-10-12", order: 3, title: "英文逾期" }],
  ["future", 705, { subject: "生化", weekStart: "2026-10-26", order: 1, title: "生化未來" }],
  ["noWeek", 706, { subject: "化學", weekStart: null, order: 0, title: "無週次" }],
  ["done", 707, { subject: "英文", weekStart: "2026-10-12", status: STATUS_DONE, order: 0, title: "已完成" }],
  ["retry", 708, { subject: "生化", weekStart: "2026-10-26", order: 2, title: "補同步課" }],
  ["doneDate", 709, { subject: "生物", weekStart: "2026-10-12", status: STATUS_DONE, doneDate: "2026-10-10", order: 2, title: "原已完成" }],
]) { const l = lesson(n, vals); pages.set(l.id, l); ids[key] = l.id; }
// Old unfinished makeup blocks the earliest chemistry lesson; old done/skipped/non-makeup must not.
pages.set(id(800), task(800, { title: "舊未完可補做", date: "2026-10-18", makeup: true, lessons: [ids.blockedChem] }));
pages.set(id(801), task(801, { title: "舊已完成", date: "2026-10-18", makeup: true, done: true, lessons: [ids.english] }));
pages.set(id(802), task(802, { title: "舊跳過", date: "2026-10-18", makeup: true, skip: true, lessons: [ids.english] }));
pages.set(id(803), task(803, { title: "舊不可補做", date: "2026-10-18", makeup: false, lessons: [ids.english] }));
pages.set(id(804), task(804, { title: "同日任何任務", date: TODAY, lessons: [ids.manualPhysics] }));
// A future task is intentionally present and must not block today's selection.
pages.set(id(805), task(805, { title: "未來已排", date: "2026-10-20", auto: true, type: "初學", lessons: [ids.english] }));

// Minimal direct automation adapters used for the negative sync matrix.
const rd = { title: (p) => plain(p), check: (p) => !!p?.checkbox, select: (p) => p?.select?.name || null, relation: (p) => (p?.relation || []).map((x) => x.id) };
const wr = { select: (x) => select(x), date: (x) => date(x), check: (x) => checkbox(x) };
const shape = (pg) => ({ id: pg.id, title: plain(pg.properties[P.lesson.title]), done: rd.select(pg.properties[P.lesson.status]) === STATUS_DONE, subject: rd.select(pg.properties[P.lesson.subject]), weekStart: pg.properties[P.lesson.weekStart]?.date?.start, minutes: pg.properties[P.lesson.length]?.number, order: pg.properties[P.lesson.order]?.number });
async function notionMock(_env, path, method = "GET", body) { const fake = await globalThis.fetch(`https://api.notion.com/v1${path}`, { method, body: body && JSON.stringify(body) }); return fake.json(); }
async function queryMock(_env, db, body, max = 500) { const out = []; let cursor; do { const r = await notionMock(null, `/databases/${db}/query`, "POST", { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) }); out.push(...r.results); cursor = r.has_more ? r.next_cursor : null; } while (cursor && out.length < max); return out; }

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url); const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ url: target, method: init.method || "GET", body });
  assert.match(target, /^https:\/\/api\.notion\.com\/v1\//, "all requests must be through mocked Notion API");
  if (retry429 > 0 && target.includes("/databases/") && target.endsWith("/query")) {
    retry429--; return new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "retry-after": "0" } });
  }
  if (target.includes("/databases/") && target.endsWith("/query")) {
    const db = target.split("/databases/")[1].split("/")[0];
    let rows = [...pages.values()].filter((p) => p.parent?.database_id?.replaceAll("-", "") === db);
    rows = sortRows(rows.filter((p) => matches(p, body?.filter)), body?.sorts);
    const offset = body?.start_cursor ? Number(body.start_cursor) : 0;
    const chunk = rows.slice(offset, offset + 100);
    return json({ results: chunk, has_more: offset + 100 < rows.length, next_cursor: offset + 100 < rows.length ? String(offset + 100) : null });
  }
  const pageMatch = target.match(/\/pages\/([^/]+)$/);
  if (pageMatch) {
    const pg = pages.get(pageMatch[1]);
    if (!pg) return json({ object: "page", id: pageMatch[1], properties: {} }, 404);
    if (init.method === "PATCH") {
      if (failLessonPatchOnce > 0 && pg.parent.database_id === DB.lessons) { failLessonPatchOnce--; return json({ message: "injected lesson write failure" }, 500); }
      pg.properties = { ...pg.properties, ...(body?.properties || {}) }; pg.last_edited_time = "2026-10-19T03:00:00.000Z";
    }
    return json(pg);
  }
  if (target.endsWith("/pages") && init.method === "POST") {
    if (create503) { create503 = false; return json({ message: "ambiguous create" }, 503); }
    const newId = `created-${pages.size}`;
    const pg = { id: newId, parent: { database_id: body.parent.database_id }, last_edited_time: "2026-10-19T03:00:00.000Z", properties: body.properties };
    pg.properties = structuredClone(pg.properties);
    for (const property of Object.values(pg.properties)) {
      for (const entry of property.title || property.rich_text || []) entry.plain_text = entry.text?.content || "";
    }
    pages.set(newId, pg); return json(pg);
  }
  return json({ results: [], has_more: false });
};

const env = { NOTION_TOKEN: "offline-token", APP_KEY: "offline-key", ALLOWED_ORIGIN: "*" };
const namespace = makeNamespace(env);
env.LESSON_AUTOMATION = namespace.binding;
const journal = new AutomationJournal(namespace.storage);
const controller = { cron: DAILY_CRON, scheduledTime: NOW };
const ctx = { waitUntil(p) { this.p = p; } };
const oldNow = Date.now; const oldSetTimeout = globalThis.setTimeout; Date.now = () => NOW; globalThis.setTimeout = (fn) => oldSetTimeout(fn, 0);
try {
  // Direct selector assertions cover week end, subject dedupe, earliest week then order, and exclusions.
  assert.equal(weekEnd("2026-10-18"), "2026-10-18");
  assert.equal(weekEnd("2026-10-19"), "2026-10-25");
  const selected = selectDailyLessons([
    { id: "a", subject: "化學", done: false, weekStart: "2026-10-13", order: 2 },
    { id: "b", subject: "化學", done: false, weekStart: "2026-10-12", order: 9 },
    { id: "c", subject: "物理", done: true, weekStart: TODAY, order: 1 },
    { id: "d", subject: "生物", done: false, weekStart: "2026-10-26", order: 1 },
    { id: "e", subject: "英文", done: false, weekStart: null, order: 1 },
  ], TODAY);
  assert.deepEqual(selected.map((x) => x.id), ["b"]);

  // Explicit 429 is retried and eventually succeeds; no real sleep is used.
  retry429 = 1; const retryStart = calls.length;
  assert.equal((await worker.fetch(new Request("https://local/api/state", { headers: { "x-app-key": env.APP_KEY } }), env)).status, 200);
  assert.equal(calls.slice(retryStart).filter((c) => c.url.endsWith("/query")).length >= 2, true);
  // A POST /pages 503 is ambiguous and must not be replayed.
  create503 = true; const createStart = calls.length;
  assert.equal((await worker.fetch(new Request("https://local/api/record", { method: "POST", headers: { "x-app-key": env.APP_KEY, "content-type": "application/json" }, body: JSON.stringify({ hours: 1 }) }), env)).status, 502);
  assert.equal(calls.slice(createStart).filter((c) => c.method === "POST" && c.url.endsWith("/pages")).length, 1);

  const before = calls.length;
  await worker.scheduled(controller, env, ctx);
  await ctx.p;
  const firstResultCalls = calls.slice(before);
  const created = firstResultCalls.filter((c) => c.method === "POST" && c.url.endsWith("/pages"));
  assert.equal(created.length, 2, "only biology and English should be created; chemistry/physics are blocked");
  assert.equal(created.every((c) => c.body.parent.database_id === DB.tasks), true);
  for (const c of created) {
    const p = c.body.properties;
    assert.deepEqual(Object.keys(p).sort(), [P.task.auto, P.task.date, P.task.difficulty, P.task.estimatedMinutes, P.task.lesson, P.task.makeup, P.task.source, P.task.title, P.task.type, P.task.key].sort());
    assert.deepEqual(p[P.task.date], { date: { start: TODAY } }); assert.deepEqual(p[P.task.source], { select: { name: "今日" } });
    assert.deepEqual(p[P.task.type], { select: { name: "初學" } }); assert.deepEqual(p[P.task.makeup], { checkbox: true });
    assert.deepEqual(p[P.task.auto], { checkbox: true }); assert.deepEqual(p[P.task.difficulty], { select: null });
    assert.deepEqual(p[P.task.estimatedMinutes], { number: 45 });
    const targetLesson = pages.get(p[P.task.lesson].relation[0].id);
    assert.deepEqual(p[P.task.title], { title: [{ text: { content: `完成整堂｜${plain(targetLesson.properties[P.lesson.title])}` } }] });
  }
  assert.ok(firstResultCalls.some((c) => c.url.includes(`/databases/${DB.lessons}/query`) && c.body.page_size === 100));
  assert.ok(firstResultCalls.filter((c) => c.url.includes(`/databases/${DB.lessons}/query`)).length >= 6, "queryAll Infinity must paginate >500 lessons");
  assert.equal(firstResultCalls.some((c) => c.url.includes("api.notion.com") === false), false);

  // Repeated and same-isolate concurrent Cron deliveries are serialized and do not duplicate tasks.
  const madeBefore = [...pages.values()].filter((p) => p.parent?.database_id === DB.tasks && p.id.startsWith("created-")).length;
  await Promise.all([worker.scheduled(controller, env, { waitUntil() {} }), worker.scheduled(controller, env, { waitUntil() {} })]);
  const madeAfter = [...pages.values()].filter((p) => p.parent?.database_id === DB.tasks && p.id.startsWith("created-")).length;
  assert.equal(madeAfter, madeBefore);
  await assert.rejects(() => worker.scheduled({ cron: "0 0 * * *", scheduledTime: NOW }, env, { waitUntil() {} }), /unexpected daily lesson cron/);

  // postTask writes the exact done checkbox, then syncs only an auto 初學 full-lesson task in the task DB.
  const autoSlot = await journal.reserve(TODAY, "補同步", ids.retry, null);
  const auto = task(900, { title: "完成整堂｜補同步課", auto: true, type: "初學", lessons: [ids.retry], done: false });
  auto.properties[P.task.key] = rich(autoSlot.row.operationKey); pages.set(auto.id, auto);
  await journal.recordTask(autoSlot.row, auto.id);
  let r = await worker.fetch(new Request(`https://local/api/task/${auto.id}`, { method: "POST", headers: { "x-app-key": env.APP_KEY, "content-type": "application/json" }, body: JSON.stringify({ done: true }) }), env);
  assert.equal(r.status, 200); assert.deepEqual(calls.findLast((c) => c.method === "PATCH" && c.url.endsWith(`/pages/${auto.id}`)).body.properties, { [P.task.done]: { checkbox: true } });
  assert.equal(pages.get(ids.retry).properties[P.lesson.status].select.name, STATUS_DONE);
  assert.equal(pages.get(ids.retry).properties[P.lesson.doneDate].date.start, TODAY);

  // Manual review, skipped, wrong parent DB, multiple relations, and non-prefix tasks never sync.
  for (const [n, vals, parent] of [
    [901, { title: "完成整堂｜手動", auto: false, type: "初學", lessons: [ids.bio] }, DB.tasks],
    [902, { title: "完成整堂｜跳過", auto: true, type: "初學", skip: true, lessons: [ids.bio] }, DB.tasks],
    [903, { title: "完成整堂｜錯資料庫", auto: true, type: "初學", lessons: [ids.bio] }, DB.lessons],
    [904, { title: "完成整堂｜多堂", auto: true, type: "初學", lessons: [ids.bio, ids.english] }, DB.tasks],
    [905, { title: "普通完成", auto: true, type: "初學", lessons: [ids.bio] }, DB.tasks],
    [908, { title: "完成整堂｜複習", auto: true, type: "複習", lessons: [ids.bio] }, DB.tasks],
  ]) { const t = task(n, { ...vals, done: true }, parent); pages.set(t.id, t); await (createAutomation({ notion: async (e, path, method, b) => notionMock(e, path, method, b), queryAll: queryMock, shapeLesson: shape, rd, wr, journal })).syncTaskCompletion(env, t, TODAY, new Map()); }
  assert.equal(pages.get(ids.bio).properties[P.lesson.status].select.name, "未開始", "manual/skip/wrong-db/multi/non-prefix must not sync");

  // Durable provenance means an unregistered injected task is intentionally ignored.
  const retryTask = task(906, { title: "完成整堂｜重試", auto: true, type: "初學", done: true, lessons: [ids.retry] }); pages.set(retryTask.id, retryTask);
  pages.get(ids.retry).properties[P.lesson.status] = select("未開始"); pages.get(ids.retry).properties[P.lesson.doneDate] = date(null); failLessonPatchOnce = 1;
  await worker.scheduled({ ...controller }, env, { waitUntil() {} });
  assert.equal(pages.get(ids.retry).properties[P.lesson.status].select.name, "未開始");
  const preserved = pages.get(ids.doneDate).properties[P.lesson.doneDate].date.start;
  const directDone = task(907, { title: "完成整堂｜已完成", auto: true, type: "初學", done: true, lessons: [ids.doneDate], lastEdited: "2026-10-18T18:00:00.000Z" }); pages.set(directDone.id, directDone);
  await worker.scheduled(controller, env, { waitUntil() {} });
  assert.equal(pages.get(ids.doneDate).properties[P.lesson.doneDate].date.start, preserved);
  assert.equal(pages.get(ids.doneDate).properties[P.lesson.status].select.name, STATUS_DONE);

  // A direct Notion completion is reconciled using its Taipei edit date, and
  // still consumes today's subject slot even when a later lesson is eligible.
  const nextBio = lesson(710, { subject: "生物", weekStart: TODAY, order: 9 });
  pages.set(nextBio.id, nextBio);
  const generatedBio = [...pages.values()].find((p) => p.id.startsWith("created-") &&
    p.properties[P.task.lesson]?.relation?.[0]?.id === ids.bio);
  generatedBio.properties[P.task.done] = checkbox(true);
  generatedBio.last_edited_time = "2026-10-18T15:59:00.000Z";
  const beforeSlotCheck = calls.length;
  await worker.scheduled(controller, env, { waitUntil() {} });
  assert.equal(pages.get(ids.bio).properties[P.lesson.doneDate].date.start, TODAY);
  assert.equal(calls.slice(beforeSlotCheck).some((c) => c.method === "POST" && c.url.endsWith("/pages")), false,
    "completed auto task must not schedule a second same-subject lesson today");
  console.log(`automation offline tests passed (${calls.length} mocked Notion calls)`);
} finally { Date.now = oldNow; globalThis.setTimeout = oldSetTimeout; globalThis.fetch = nativeFetch; }
