import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "./index.js";
import { makeNamespace } from "./test-fixtures.mjs";
import { APPROVED_LESSONS } from "./reschedule-allowlist.js";
import { DB, P } from "./config.js";

const NOW = Date.parse("2026-10-19T02:00:00Z");
const nativeNow = Date.now, nativeFetch = globalThis.fetch;
const normalize = (s) => s.replaceAll("-", "").toLowerCase();
const csv = await readFile(new URL("./fixtures/flexible-52-lessons-approval.csv", import.meta.url), "utf8");
const dates = new Map(csv.trim().split(/\r?\n/).slice(1).map((line) => { const row = line.split(","); return [row[0], row[7]]; }));
const title = (s) => ({ title: [{ plain_text: s, text: { content: s } }] });
const rich = (s) => ({ rich_text: [{ plain_text: s, text: { content: s } }] });
const select = (s) => ({ select: s ? { name: s } : null });
const date = (s) => ({ date: s ? { start: s, end: null, time_zone: null } : null });
const page = (a, start = "2026-10-19") => ({
  id: a.id, parent: { database_id: DB.lessons }, archived: false, in_trash: false,
  last_edited_time: "2026-10-18T00:00:00Z", properties: {
    [P.lesson.title]: title(a.title), [P.lesson.course]: select(a.course), [P.lesson.order]: { number: a.order },
    [P.lesson.status]: select("未開始"), [P.lesson.type]: select("影片"), [P.lesson.subject]: select("化學"),
    [P.lesson.weekLabel]: rich("目前週標籤"), [P.lesson.weekStart]: date(start),
    [P.lesson.doneDate]: date(null), [P.lesson.length]: { number: 30 }, [P.lesson.reviews]: { number: 0 },
  },
});
const approvedIds = new Set(APPROVED_LESSONS.map((x) => x.id));
const pages = new Map(APPROVED_LESSONS.map((a) => [a.id, page(a, dates.get(a.id))]));
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source2Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
for (const id of [sourceId, source2Id]) pages.set(normalize(id), page({ id, title: "既有普化精修前序課次", course: "普化精修", order: 306 }, "2026-10-26"));
const calls = [];
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
Date.now = () => NOW;
// This interceptor is installed before any Worker / DO request. No external
// request is forwarded; unexpected origins, paths or methods fail the test.
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, "https://api.notion.com");
  assert.match(url.pathname, /^\/v1\/pages\/[0-9a-f-]+$/);
  const method = init.method || "GET", id = normalize(url.pathname.split("/").at(-1));
  assert.ok(["GET", "PATCH"].includes(method));
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ id, method, body });
  const row = pages.get(id);
  if (!row) return response({ message: "offline missing page" }, 404);
  if (method === "PATCH") {
    row.properties = { ...row.properties, ...body.properties };
    for (const p of Object.values(row.properties)) for (const t of p.rich_text || p.title || []) t.plain_text = t.text?.content ?? t.plain_text;
    row.last_edited_time = new Date(NOW).toISOString();
  }
  return response(row);
};
const env = { APP_KEY: "offline-key", NOTION_TOKEN: "offline-token" };
const ns = makeNamespace(env); env.LESSON_AUTOMATION = ns.binding;
const api = (path, body, auth = "offline-key", method = body === undefined ? "GET" : "POST") => worker.fetch(new Request(`https://offline.test${path}`, {
  method, headers: { "x-app-key": auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), env);
const scheduleWrites = () => calls.filter((c) => c.method === "PATCH" && approvedIds.has(c.id));
try {
  // API auth and read-only retrieval never generate or approve.
  assert.equal((await api("/api/reschedule", undefined, "bad")).status, 401);
  assert.deepEqual(await (await api("/api/reschedule")).json(), { proposal: null });
  assert.equal(calls.length, 0);

  // Existing explicit completion may update its source, but generation itself
  // only reads whitelist pages. Outside source never receives week changes.
  assert.equal((await api(`/api/lesson/${sourceId}`, { done: true })).status, 200);
  assert.equal(scheduleWrites().length, 0);
  const card = (await (await api("/api/reschedule")).json()).proposal;
  assert.equal(card.state, "pending"); assert.equal(card.items.length, 2);
  const sourcePatches = calls.filter((c) => c.method === "PATCH" && c.id === normalize(sourceId));
  assert.equal(sourcePatches.length, 1);
  assert.deepEqual(Object.keys(sourcePatches[0].body.properties).sort(), [P.lesson.status, P.lesson.doneDate].sort());
  for (const a of APPROVED_LESSONS) assert.ok(calls.some((c) => c.id === a.id && c.method === "GET"));
  let before = calls.length;
  assert.equal((await api(`/api/reschedule/${card.id}/approve`, { approve: false })).status, 409);
  assert.equal((await api(`/api/reschedule/${card.id}/approve`, { approve: true }, "bad")).status, 401);
  assert.equal((await api(`/api/reschedule/${card.id}/approve`)).status, 404);
  assert.equal(calls.length, before);

  // Concurrent approves serialize in the named DO. Client-supplied item lists,
  // before/after values and outside IDs cannot replace the saved card.
  const forged = { approve: true, items: [{ id: sourceId, after: { week: "W99", weekStart: "2099-01-01" } }] };
  const [a, b] = await Promise.all([api(`/api/reschedule/${card.id}/approve`, forged), api(`/api/reschedule/${card.id}/approve`, { approve: true })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(scheduleWrites().length, 2);
  for (const call of scheduleWrites()) {
    assert.ok(approvedIds.has(call.id));
    assert.deepEqual(Object.keys(call.body.properties).sort(), [P.lesson.weekLabel, P.lesson.weekStart].sort());
  }
  ns.recreate(); before = calls.length;
  assert.equal((await api(`/api/reschedule/${card.id}/approve`, { approve: true })).status, 200);
  assert.equal(calls.length, before, "restart duplicate approval must not replay external I/O");

  // A duplicate completion request cannot create a new proposal or more shifts.
  assert.equal((await api(`/api/lesson/${sourceId}`, { done: true })).status, 200);
  assert.equal((await (await api("/api/reschedule")).json()).proposal.id, card.id);
  assert.equal(scheduleWrites().length, 2);

  // A genuinely new event may propose at most another two, still no writes.
  assert.equal((await api(`/api/lesson/${source2Id}`, { done: true })).status, 200);
  const second = (await (await api("/api/reschedule")).json()).proposal;
  assert.notEqual(second.id, card.id); assert.ok(second.items.length <= 2);
  assert.equal(scheduleWrites().length, 2);
  const changed = second.items[0].id;
  pages.get(changed).properties[P.lesson.status] = select("進行中");
  const rejected = await api(`/api/reschedule/${second.id}/approve`, { approve: true });
  assert.equal(rejected.status, 409);
  assert.equal(scheduleWrites().length, 2);
  const conflict = (await (await api("/api/reschedule")).json()).proposal;
  assert.equal(conflict.state, "conflict");
  assert.equal(conflict.items.find((x) => x.id === changed).state, "conflict");
  console.log(`reschedule API/DO offline integration passed (auth, GET-only, explicit approval, forged payload, concurrent duplicate, restart, stale conflict; ${calls.length} intercepted calls)`);
} finally {
  globalThis.fetch = nativeFetch; Date.now = nativeNow;
}
