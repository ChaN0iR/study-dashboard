import assert from "node:assert/strict";
import worker from "./index.js";
import { DB, P, STATUS_DONE } from "./config.js";
import { makeNamespace } from "./test-fixtures.mjs";
import AutomationJournal from "./journal.js";

const NOW = Date.parse("2026-10-19T02:10:00.000Z"); // 2026-10-19 in Taipei
const DAY = 86400e3;
const day = (n = 0) => new Date(NOW + 8 * 3600e3 + n * DAY).toISOString().slice(0, 10);
const id = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const title = (s) => ({ title: [{ plain_text: s, text: { content: s } }] });
const rich = (s = "") => ({ rich_text: [{ plain_text: s, text: { content: s } }] });
const select = (s) => ({ select: s == null ? null : { name: s } });
const checkbox = (v = false) => ({ checkbox: !!v });
const date = (s) => ({ date: s == null ? null : { start: s } });
const number = (n) => ({ number: n });
const relation = (xs = []) => ({ relation: xs.map((x) => ({ id: x })) });
const taskProps = (v = {}) => ({
  [P.task.title]: title(v.title ?? "任務"), [P.task.done]: checkbox(v.done), [P.task.skip]: checkbox(v.skip),
  [P.task.date]: date(v.date ?? day()), [P.task.order]: number(v.order ?? 1), [P.task.type]: select(v.type ?? "初學"),
  [P.task.source]: select(v.source ?? "今日"), [P.task.lesson]: relation(v.lessons), [P.task.makeup]: checkbox(v.makeup ?? true),
  [P.task.auto]: checkbox(v.auto ?? true), [P.task.key]: rich(v.key ?? ""), [P.task.prerequisites]: relation(v.prerequisites),
  [P.task.estimatedMinutes]: number(v.minutes ?? 45), [P.task.difficulty]: select(null),
});
const task = (n, v = {}, parent = DB.tasks) => ({ id: id(n), parent: { database_id: parent }, last_edited_time: "2026-10-19T02:00:00.000Z", properties: taskProps(v) });
const lesson = (n, v = {}) => ({
  id: id(n), parent: { database_id: DB.lessons }, last_edited_time: v.lastEdited ?? "2026-10-18T00:00:00.000Z",
  properties: { [P.lesson.title]: title(v.title ?? `課程${n}`), [P.lesson.status]: select(v.status ?? "未開始"),
    [P.lesson.subject]: select(v.subject ?? "化學"), [P.lesson.course]: select(v.course ?? "主課"), [P.lesson.length]: number(45),
    [P.lesson.weekLabel]: rich(v.week ?? "第1週"), [P.lesson.weekStart]: date("weekStart" in v ? v.weekStart : day()), [P.lesson.reviews]: number(0),
    [P.lesson.order]: number(v.order ?? n), [P.lesson.doneDate]: date(v.doneDate ?? null) },
});
const plain = (p) => (p?.title || p?.rich_text || []).map((x) => x.plain_text ?? x.text?.content ?? "").join("");
const matches = (p, f) => {
  if (!f) return true; if (f.and) return f.and.every((x) => matches(p, x)); if (f.or) return f.or.some((x) => matches(p, x));
  const v = p.properties?.[f.property] || {};
  if (f.checkbox) return !!v.checkbox === f.checkbox.equals;
  if (f.rich_text) return plain(v) === f.rich_text.equals;
  if (f.relation) return (v.relation || []).some((x) => x.id.replaceAll("-", "").toLowerCase() === f.relation.contains.replaceAll("-", "").toLowerCase());
  if (f.date?.equals !== undefined) return v.date?.start === f.date.equals;
  if (f.date?.before !== undefined) return !!v.date?.start && v.date.start < f.date.before;
  if (f.date?.on_or_after !== undefined) return !!v.date?.start && v.date.start >= f.date.on_or_after;
  if (f.timestamp) return true; return true;
};
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

function harness(seed = [], options = {}) {
  Date.now = () => NOW;
  const pages = new Map(seed.map((p) => [p.id, structuredClone(p)]));
  const calls = []; const faults = { ...options }; let next = 9000;
  const native = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); assert.match(u, /^https:\/\/api\.notion\.com\/v1\//, "all Notion calls use the Notion origin");
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    const method = init.method || "GET"; calls.push({ u, method, body });
    if (u.endsWith("/query")) {
      const db = u.split("/databases/")[1].split("/")[0];
      let rows = [...pages.values()].filter((p) => p.parent?.database_id?.replaceAll("-", "") === db && matches(p, body?.filter));
      const offset = Number(body?.start_cursor || 0); rows = rows.slice(offset, offset + 100);
      return json({ results: rows, has_more: false });
    }
    const pm = u.match(/\/pages\/([^/]+)$/);
    if (pm) {
      const p = pages.get(pm[1]); if (!p) return json({}, 404);
      if (method === "PATCH") {
        if (p.parent.database_id === DB.lessons && faults.lessonPatch > 0) { faults.lessonPatch--; return json({ message: "lesson fault" }, 500); }
        p.properties = { ...p.properties, ...(body?.properties || {}) }; p.last_edited_time = faults.edited ?? "2026-10-19T02:20:00.000Z";
      }
      return json(p);
    }
    if (u.endsWith("/pages") && method === "POST") {
      if (faults.post429 > 0) { faults.post429--; return json({ message: "rate limited" }, 429,); }
      const p = { id: id(next++), parent: { database_id: body.parent.database_id }, last_edited_time: "2026-10-19T02:20:00.000Z", properties: structuredClone(body.properties) };
      for (const x of Object.values(p.properties)) for (const a of x.title || x.rich_text || []) a.plain_text = a.text?.content || "";
      if (!faults.noPage503) pages.set(p.id, p);
      if (faults.create503 > 0) { faults.create503--; return json({ message: "ambiguous create" }, 503); }
      pages.set(p.id, p); return json(p);
    }
    return json({});
  };
  const env = { NOTION_TOKEN: "offline", APP_KEY: "key" }; const ns = makeNamespace(env); env.LESSON_AUTOMATION = ns.binding;
  const daily = (t = NOW) => new Request("https://automation.internal/daily", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cron: "10 16 * * *", scheduledTime: t }) });
  const runResponse = async (t = NOW) => { Date.now = () => t; return ns.binding.get().fetch(daily(t)); };
  const run = async (t = NOW) => { const r = await runResponse(t); return r.json(); };
  const api = (path, body, method = "POST") => worker.fetch(new Request(`https://local${path}`, { method, headers: { "x-app-key": "key", "content-type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }), env);
  return { pages, calls, faults, env, ns, run, runResponse, api, journal: new AutomationJournal(ns.storage), close() { globalThis.fetch = native; } };
}
const count = (h, method, suffix) => h.calls.filter((x) => x.method === method && x.u.endsWith(suffix)).length;
const autoRows = (h) => [...h.pages.values()].filter((p) => p.parent?.database_id === DB.tasks && p.properties?.[P.task.auto]?.checkbox);

const oldNow = Date.now, oldTimeout = globalThis.setTimeout; Date.now = () => NOW; globalThis.setTimeout = (fn) => oldTimeout(fn, 0);
let scenarios = 0, totalCalls = 0;
try {
  // 1: same named actor serializes two POSTs.
  { const h = harness([lesson(1)]); const [a, b] = await Promise.all([h.run(), h.run()]); assert.equal(a.created + b.created, 1); assert.equal(count(h, "POST", "/pages"), 1); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 2: remote page exists but response is 503; restart recovers exactly once and provenance.
  { const h = harness([lesson(2)]); h.faults.create503 = 1; const first = await h.run(); assert.equal(first.created, 0); assert.equal(first.errors[0].httpStatus, 503); assert.equal(count(h, "POST", "/pages"), 1); const row = await h.journal.get(`slot:${day()}:化學`); assert.equal(row.state, "uncertain"); assert.equal(row.attempts, 1); assert.equal((await h.journal.getTask(autoRows(h)[0].id)) == null, true, "uncertain create has no durable task record"); h.ns.recreate(); const second = await h.run(); assert.equal(second.recovered, 1); assert.equal(second.created, 0); assert.equal(count(h, "POST", "/pages"), 1); assert.equal((await h.journal.getTask(autoRows(h)[0].id)).operationKey, row.operationKey); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 3: 503 with no visible page remains held across the next day, no second POST.
  { const h = harness([lesson(3)]); h.faults.create503 = 1; h.faults.noPage503 = true; const a = await h.run(); assert.equal(a.errors[0].httpStatus, 503); assert.equal(count(h, "POST", "/pages"), 1); h.ns.recreate(); const b = await h.run(NOW + DAY); assert.equal(b.held, 1); assert.equal(count(h, "POST", "/pages"), 1); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 4: recordTask transaction throws once after external page; next actor recovers.
  { const h = harness([lesson(4)]); let once = true; const tx = h.ns.storage.transaction.bind(h.ns.storage); h.ns.storage.transaction = async (fn) => { if (once && h.calls.some((x) => x.method === "POST" && x.u.endsWith("/pages"))) { once = false; return tx(async (t) => { const r = await fn(t); throw new Error("injected recordTask fault"); }); } return tx(fn); }; const a = await h.run(); assert.equal(a.errors[0].httpStatus, null); assert.equal(once, false); assert.equal(count(h, "POST", "/pages"), 1); const row = await h.journal.get(`slot:${day()}:化學`); assert.equal(row.state, "uncertain"); h.ns.recreate(); const b = await h.run(); assert.equal(b.recovered, 1); assert.equal(count(h, "POST", "/pages"), 1); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 5: reserved before send is safe; expired reservation is cancelled and today's slot is new.
  { const h = harness([lesson(5)]); const j = h.journal; const r = await j.reserve(day(), "化學", id(5), null); assert.equal(r.acquired, true); const a = await h.run(); assert.equal(a.created, 1); const old = await j.reserve(day(-1), "物理", id(6), null); assert.equal(old.acquired, true); h.pages.set(id(6), lesson(6, { subject: "物理", weekStart: day(-1) })); h.ns.recreate(); const b = await h.run(); assert.equal(b.created, 1, "after old reservation cancellation, today's new slot is allowed"); assert.equal((await j.get(old.row.key)).state, "cancelled"); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 6: duplicate same key always conflicts and is held, never writes lesson or creates.
  { const l = lesson(7); const h = harness([l]); const j = h.journal; const r = await j.reserve(day(), "化學", l.id, null); await j.update(r.row.key, { state: "created" }, "test-created"); const p1 = task(71, { key: r.row.operationKey, lessons: [l.id] }); const p2 = task(72, { key: r.row.operationKey, lessons: [l.id] }); h.pages.set(p1.id, p1); h.pages.set(p2.id, p2); const before = h.calls.length; const a = await h.run(); assert.equal(a.held, 1); assert.equal((await j.get(r.row.key)).state, "conflict"); assert.equal(h.calls.slice(before).some((x) => x.method === "PATCH" && x.u.includes(`/pages/${l.id}`)), false); assert.equal(h.calls.slice(before).some((x) => x.method === "POST" && x.u.endsWith("/pages")), false); h.pages.delete(p2.id); h.ns.recreate(); const b = await h.run(); assert.equal(b.held, 1); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 7: canonical identity mismatch is held and never synced.
  { const l = lesson(8); const h = harness([l]); const j = h.journal; const r = await j.reserve(day(), "化學", l.id, null); const p = task(81, { key: "wrong-key", lessons: [l.id], done: true }); h.pages.set(p.id, p); await j.recordTask(r.row, p.id); const before = h.calls.length; const a = await h.run(); assert.equal(a.held, 1); assert.equal(h.calls.slice(before).some((x) => x.method === "PATCH" && x.u.includes(`/pages/${l.id}`)), false); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 8: exhaust all four idempotent PATCH attempts; restart across a real day boundary.
  {
    const l = lesson(9); const h = harness([l]); const j = h.journal;
    const r = await j.reserve(day(), "化學", l.id, null);
    const p = task(91, { title: "完成整堂｜課程9", key: r.row.operationKey, lessons: [l.id], done: false });
    h.pages.set(p.id, p); await j.recordTask(r.row, p.id); h.faults.lessonPatch = 4;
    const first = await h.api(`/api/task/${p.id}`, { done: true });
    assert.equal(first.status, 502); assert.equal(h.faults.lessonPatch, 0);
    assert.equal(count(h, "PATCH", `/pages/${l.id}`), 4);
    const pending = await j.getTask(p.id);
    assert.equal(pending.completion.phase, "lesson_pending");
    assert.equal(pending.completion.date, day()); assert.equal(pending.completion.source, "dashboard");
    assert.equal(h.pages.get(p.id).properties[P.task.done].checkbox, true);
    h.pages.get(p.id).last_edited_time = "2026-10-25T23:00:00Z";
    h.ns.recreate(); const second = await h.run(NOW + DAY);
    assert.equal(second.synced, 1);
    assert.equal(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), day(1));
    assert.equal(h.pages.get(l.id).properties[P.lesson.doneDate].date.start, day());
    assert.equal((await j.getTask(p.id)).completion.phase, "applied");
    const patches = count(h, "PATCH", `/pages/${l.id}`); await h.run(NOW + DAY);
    assert.equal(count(h, "PATCH", `/pages/${l.id}`), patches);
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 9: course write succeeds but applied-phase transaction crashes and rolls back.
  {
    const l = lesson(10); const h = harness([l]); const j = h.journal;
    const r = await j.reserve(day(), "化學", l.id, null);
    const p = task(101, { title: "完成整堂｜課程10", key: r.row.operationKey, lessons: [l.id], done: false });
    h.pages.set(p.id, p); await j.recordTask(r.row, p.id);
    const tx = h.ns.storage.transaction.bind(h.ns.storage); let fault = true;
    h.ns.storage.transaction = async (fn) => {
      if (fault && count(h, "PATCH", `/pages/${l.id}`) === 1) {
        fault = false; return tx(async (t) => { await fn(t); throw Error("applied fault"); });
      }
      return tx(fn);
    };
    const a = await h.api(`/api/task/${p.id}`, { done: true });
    assert.equal(a.status, 500); assert.equal(fault, false);
    assert.equal(count(h, "PATCH", `/pages/${l.id}`), 1);
    assert.equal((await j.getTask(p.id)).completion.phase, "lesson_pending");
    assert.equal(h.pages.get(l.id).properties[P.lesson.doneDate].date.start, day());
    h.ns.recreate(); const b = await h.run(NOW + DAY);
    assert.equal(b.synced, 0); assert.equal(count(h, "PATCH", `/pages/${l.id}`), 1);
    assert.equal((await j.getTask(p.id)).completion.phase, "preserved");
    assert.equal(h.pages.get(l.id).properties[P.lesson.doneDate].date.start, day());
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 10: an already-completed course's previous date is never overwritten.
  {
    const l = lesson(19, { status: STATUS_DONE, doneDate: "2026-09-30" }); const h = harness([l]);
    const r = await h.journal.reserve(day(), "化學", l.id, null);
    const p = task(191, { title: "完成整堂｜已完成", key: r.row.operationKey, lessons: [l.id], done: true });
    h.pages.set(p.id, p); await h.journal.recordTask(r.row, p.id); await h.run();
    assert.equal(count(h, "PATCH", `/pages/${l.id}`), 0);
    assert.equal(h.pages.get(l.id).properties[P.lesson.doneDate].date.start, "2026-09-30");
    assert.equal((await h.journal.getTask(p.id)).completion.phase, "preserved");
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 11: manual review / untracked marker never syncs.
  {
    const l = lesson(11); const h = harness([l]);
    for (const [n, auto, type] of [[111, false, "複習"], [112, true, "初學"]]) {
      const p = task(n, { title: "完成整堂｜手動", auto, type, lessons: [l.id], done: false });
      h.pages.set(p.id, p); assert.equal((await h.api(`/api/task/${p.id}`, { done: true })).status, 200);
    }
    const a = await h.run(); assert.equal(a.synced, 0);
    assert.equal(count(h, "PATCH", `/pages/${l.id}`), 0);
    assert.equal(h.pages.get(l.id).properties[P.lesson.status].select.name, "未開始");
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 12: POST 429 is never replayed.
  { const h = harness([lesson(12)], { post429: 1 }); const a = await h.run(); assert.equal(a.created, 0); assert.equal(count(h, "POST", "/pages"), 1); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 13: done+skip 400; missing binding 503.
  { const h = harness([lesson(13)]); const p = task(131); h.pages.set(p.id, p); assert.equal((await h.api(`/api/task/${p.id}`, { done: true, skip: true })).status, 400); const no = { NOTION_TOKEN: "offline", APP_KEY: "key" }; assert.equal((await worker.fetch(new Request(`https://x/api/task/${p.id}`, { method: "POST", headers: { "x-app-key": "key", "content-type": "application/json" }, body: JSON.stringify({ done: true }) }), no)).status, 503); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 14: audit auth, task/slot lookup, and read-only audit has no Notion writes.
  {
    const h = harness([lesson(14)]);
    assert.equal((await worker.fetch(new Request("https://x/api/automation/audit", { headers: { "x-app-key": "bad" } }), h.env)).status, 401);
    assert.equal(h.calls.length, 0); await h.run(); const before = h.calls.length;
    const audit = await (await h.api("/api/automation/audit?taskId=bad", null, "GET")).json(); assert.equal(audit.error, "bad task id");
    const ok = await (await h.api("/api/automation/audit", null, "GET")).json(); assert.equal(ok.storage, "durable-object");
    const made = autoRows(h)[0];
    const own = await (await h.api(`/api/automation/audit?taskId=${made.id}`, null, "GET")).json();
    assert.equal(own.task.taskId, made.id); assert.equal(own.task.owned, true);
    const noToken = await worker.fetch(new Request("https://x/api/automation/audit", { headers: { "x-app-key": "key" } }), { ...h.env, NOTION_TOKEN: undefined });
    assert.equal(noToken.status, 200);
    for (let n = 0; n < 101; n++) await h.journal.reserve(day(), `分頁${String(n).padStart(3, "0")}`, id(20000 + n), null);
    const page1 = await (await h.api("/api/automation/audit", null, "GET")).json();
    assert.equal(page1.slots.length, 100); assert.ok(page1.nextCursor);
    const page2 = await (await h.api(`/api/automation/audit?cursor=${encodeURIComponent(page1.nextCursor)}`, null, "GET")).json();
    assert.equal(page2.slots.length, 2); assert.equal(page2.nextCursor, null);
    assert.equal(h.calls.length, before, "all audit calls are DO-only, including auth failures and pagination");
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 15: current-week future lessons are eligible; next-week and no-week are not.
  { const h = harness([lesson(15, { subject: "化學", weekStart: day(3) }), lesson(16, { subject: "物理", weekStart: day(8) }), lesson(17, { subject: "生物", weekStart: null })]); const a = await h.run(); assert.equal(a.created, 1); const rows = autoRows(h); assert.equal(rows[0].properties[P.task.lesson].relation[0].id, id(15)); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 16: settled historical rows are not individually fetched; last_edited_time is only scan watermark.
  { const h = harness([lesson(18, { status: STATUS_DONE, doneDate: "2026-10-01" })]); const j = h.journal; const r = await j.reserve("2026-10-01", "化學", id(18), null); await j.update(r.row.key, { state: "settled", taskId: id(181) }, "settled"); const before = h.calls.length; const a = await h.run(); assert.equal(a.created, 0); assert.equal(h.calls.slice(before).filter((x) => x.method === "GET" && x.u.includes(`/pages/${id(181)}`)).length, 0); scenarios++; totalCalls += h.calls.length; h.close(); }
  // 17: an unknown write in one subject must not stop another subject.
  {
    const h = harness([lesson(21, { subject: "化學" }), lesson(22, { subject: "物理" })], { create503: 1 });
    const result = await h.run(); assert.equal(result.errors.length, 1); assert.equal(result.held, 1);
    assert.equal(result.created, 1); assert.equal(count(h, "POST", "/pages"), 2);
    assert.equal((await h.journal.get(`slot:${day()}:化學`)).state, "uncertain");
    assert.equal((await h.journal.get(`slot:${day()}:物理`)).state, "created");
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 18: skipping an auto task lets the same lesson get a new task ID tomorrow.
  {
    const subject = "化學", lessonId = id(24), tomorrow = day(1);
    const h = harness([lesson(24, { subject })]);
    const first = await h.run(); assert.equal(first.created, 1);
    const firstTask = autoRows(h).find((p) => p.properties[P.task.date].date.start === day());
    assert.ok(firstTask);
    assert.deepEqual(firstTask.properties[P.task.lesson].relation.map((x) => x.id), [lessonId]);
    assert.equal((await h.journal.get(`slot:${day()}:${subject}`)).taskId, firstTask.id);

    firstTask.properties[P.task.skip] = checkbox(true);
    firstTask.last_edited_time = "2026-10-19T16:10:00.000Z";
    h.ns.recreate();
    const next = await h.run(NOW + DAY); assert.equal(next.created, 1);
    const secondTask = autoRows(h).find((p) => p.properties[P.task.date].date.start === tomorrow);
    assert.ok(secondTask);
    assert.notEqual(secondTask.id, firstTask.id, "the skipped task page is not reused");
    assert.deepEqual(secondTask.properties[P.task.lesson].relation.map((x) => x.id), [lessonId]);
    assert.equal(!!secondTask.properties[P.task.skip]?.checkbox, false);
    assert.equal(firstTask.properties[P.task.skip].checkbox, true);
    assert.equal((await h.journal.get(`slot:${day()}:${subject}`)).state, "skipped");
    const nextSlot = await h.journal.get(`slot:${tomorrow}:${subject}`);
    assert.equal(nextSlot.state, "created"); assert.equal(nextSlot.taskId, secondTask.id);
    assert.equal((await h.journal.getTask(firstTask.id)).observedSkipped, true);
    assert.equal((await h.journal.getTask(secondTask.id)).createdDate, tomorrow);
    assert.equal(count(h, "POST", "/pages"), 2, "exactly one task is created per day");
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  // 19: crash after durable sending, before POST, must not cause a first/replay POST.
  {
    const l = lesson(23); const h = harness([l]);
    const r = await h.journal.reserve(day(), "化學", l.id, null);
    await h.journal.update(r.row.key, { state: "sending", attempts: 1 }, "injected_crash_before_fetch");
    h.ns.recreate(); const first = await h.run(); assert.equal(first.held, 1);
    h.ns.recreate(); const next = await h.run(NOW + DAY); assert.equal(next.held, 1);
    assert.equal(count(h, "POST", "/pages"), 0);
    assert.equal((await h.journal.get(r.row.key)).state, "uncertain");
    scenarios++; totalCalls += h.calls.length; h.close();
  }
  console.log(`durable offline tests passed (${scenarios} scenarios, ${totalCalls} mocked Notion calls)`);
} finally { Date.now = oldNow; globalThis.setTimeout = oldTimeout; }
