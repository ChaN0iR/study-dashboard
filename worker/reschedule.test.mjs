import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRescheduler } from "./reschedule.js";
import { APPROVED_LESSONS } from "./reschedule-allowlist.js";
import { DB, P, STATUS_DONE, STATUS_TODO } from "./config.js";

const DAY = 86400000;
const csv = await readFile(new URL("./fixtures/flexible-52-lessons-approval.csv", import.meta.url), "utf8");
const csvRows = csv.trim().split(/\n/).slice(1).map(line => { const [id, order, course, title, , , , targetWeekStart] = line.split(","); return { id, order: Number(order), course, title, targetWeekStart }; });
assert.equal(csvRows.length, 52);
assert.deepEqual(csvRows.map(({ id, order, course, title }) => ({ id, order, course, title })), APPROVED_LESSONS);
const text = s => ({ rich_text: [{ plain_text: s }] });
const title = s => ({ title: [{ plain_text: s }] });
const select = s => ({ select: s == null ? null : { name: s } });
const number = n => ({ number: n });
const date = (s, end = null, time_zone = null) => ({ date: s == null ? null : { start: s, end, time_zone } });
const plus = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const week = d => `W${String(1 + Math.round((Date.parse(d) - Date.parse("2026-10-12")) / (7 * DAY))).padStart(2, "0")}`;
const rd = { title: p => (p?.title || []).map(x => x.plain_text || x.text?.content || "").join(""), text: p => (p?.rich_text || []).map(x => x.plain_text || x.text?.content || "").join(""), select: p => p?.select?.name || null, number: p => typeof p?.number === "number" ? p.number : null, date: p => p?.date?.start || null };
const wr = { text, date };
const minLesson = () => [...APPROVED_LESSONS].sort((a, b) => a.order - b.order)[0];
const anchorId = "3f879ed2087381f4a355d8ef8155000e";

class Storage {
  constructor(seed) { this.m = new Map(seed ? [...seed] : []); }
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async list({ prefix }) { return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
  async transaction(fn) { return fn(this); }
}
function makePage(a, start, x = {}) {
  return { id: a.id, parent: { database_id: DB.lessons }, archived: false, in_trash: false,
    properties: { [P.lesson.title]: title(x.title ?? a.title), [P.lesson.course]: select(x.course ?? a.course), [P.lesson.order]: number(x.order ?? a.order), [P.lesson.status]: select(x.status ?? STATUS_TODO), [P.lesson.type]: select(x.type ?? "影片"), [P.lesson.length]: number(x.minutes ?? 30), [P.lesson.doneDate]: date(x.doneDate ?? null), [P.lesson.weekLabel]: text(x.week ?? week(start)), [P.lesson.weekStart]: date(start, x.end ?? null, x.time_zone ?? null) }, last_edited_time: x.edited ?? "2026-10-12T00:00:00.000Z" };
}
function makePages({ weekStart = "2027-01-25", mutate = {} } = {}) {
  return new Map(APPROVED_LESSONS.map((a, i) => { const x = mutate[a.id] || {}; const start = x.weekStart || csvRows.find(r => r.id === a.id)?.targetWeekStart || plus(weekStart, Math.floor(i / 2) * 7); return [a.id, makePage(a, start, x)]; }));
}
function harness(opts = {}) {
  const pages = opts.pages || makePages(opts), storage = opts.storage || new Storage(), calls = [];
  const notion = async (_env, path, method = "GET", body) => { calls.push({ path, method, body }); const id = path.split("/").at(-1), p = pages.get(id); if (!p) throw new Error("missing page"); if (method === "PATCH") p.properties = { ...p.properties, ...body.properties }; return structuredClone(p); };
  const r = createRescheduler({ notion, rd, wr, storage, now: opts.now || (() => Date.parse("2026-10-12T12:00:00Z")) });
  return { pages, storage, calls, r };
}
async function complete(h, id = minLesson().id, doneDate = "2026-10-12") {
  const p = h.pages.get(id); p.properties[P.lesson.status] = select(STATUS_DONE); p.properties[P.lesson.doneDate] = date(doneDate);
  await h.r.recordCompletion({ id, done: true, doneDate }); return h.r.refresh({});
}
const patches = h => h.calls.filter(x => x.method === "PATCH");
let scenarios = 0;

// Generation is read-only, ordered by original_sort (not CSV row order), and idempotent.
{ const h = harness(); const out = await complete(h); scenarios++; assert.equal(out.proposal.items.length, 2); assert.deepEqual(out.proposal.items.map(x => x.snapshot.order), [308, 309]); assert.equal(patches(h).length, 0); assert.equal(h.calls.filter(x => x.method === "GET").length, 53); const again = await h.r.refresh({}); assert.equal(again.proposal.id, out.proposal.id); }
// CSV historical target is irrelevant: before comes from the authoritative page; source is an earlier lesson in the same course.
{ const id = minLesson().id, outside = "cccccccccccc4ccc8ccccccccccccccc", h = harness({ mutate: { [id]: { weekStart: "2026-12-07", week: "W09" } } }); h.pages.set(outside, makePage({ id: outside, title: "既有普化精修前課次", course: "普化精修", order: 306 }, "2026-10-19")); const out = await complete(h, outside); scenarios++; const item = out.proposal.items.find(x => x.id === id); assert.ok(item); assert.equal(item.before.weekStart, "2026-12-07"); assert.equal(item.after.weekStart, "2026-11-30"); }
// Explicit approval, two-property writes, per-page read before each PATCH, and duplicate approval restart.
{ const h = harness(), out = await complete(h); scenarios++; await assert.rejects(() => h.r.approve({}, out.proposal.id, false), /explicit approval/); const applied = await h.r.approve({}, out.proposal.id, true); assert.equal(patches(h).length, 2); for (const p of patches(h)) assert.deepEqual(Object.keys(p.body.properties).sort(), [P.lesson.weekLabel, P.lesson.weekStart].sort()); assert.equal(applied.proposal.state, "applied"); const n = h.calls.length; assert.equal((await h.r.approve({}, out.proposal.id, true)).proposal.state, "applied"); assert.equal(h.calls.length, n); }
// Every mutable identity/state/date field is changed after generation; each item records conflictReason and no PATCH occurs.
for (const field of ["title", "course", "order", "status", "type", "doneDate", "week", "weekStart", "end", "time_zone", "archived", "parent", "edited"]) {
  const h = harness(), out = await complete(h), id = out.proposal.items[0].id; const p = h.pages.get(id), x = p.properties; scenarios++;
  if (field === "title") x[P.lesson.title] = title("tampered"); else if (field === "course") x[P.lesson.course] = select("tampered"); else if (field === "order") x[P.lesson.order] = number(999); else if (field === "status") x[P.lesson.status] = select("進行中"); else if (field === "type") x[P.lesson.type] = select("文章"); else if (field === "doneDate") x[P.lesson.doneDate] = date("2026-10-12"); else if (field === "week") x[P.lesson.weekLabel] = text("W99"); else if (field === "weekStart") x[P.lesson.weekStart] = date("2026-12-14"); else if (field === "end") x[P.lesson.weekStart] = date(out.proposal.items[0].before.weekStart, "2026-12-15"); else if (field === "time_zone") x[P.lesson.weekStart] = date(out.proposal.items[0].before.weekStart, null, "Asia/Taipei"); else if (field === "archived") p.archived = true; else if (field === "parent") p.parent = { database_id: "other-db" }; else p.last_edited_time = "2026-10-13T00:00:00.000Z";
  await assert.rejects(() => h.r.approve({}, out.proposal.id, true), /快照|變更|資格|順序|物理|過期/); const saved = await h.storage.get(`reschedule:v1:proposal:${out.proposal.id}`); assert.equal(saved.state, "conflict"); assert.ok(saved.items.some(i => i.conflictReason)); assert.equal(patches(h).length, 0, `${field}: zero PATCH`);
}
// Expiry is controlled by now(); approval is failed closed.
{ let t = Date.parse("2026-10-12T12:00:00Z"), h = harness({ now: () => t }); const out = await complete(h); t += DAY + 1; scenarios++; await assert.rejects(() => h.r.approve({}, out.proposal.id, true), /過期/); assert.equal(patches(h).length, 0); }
// Revoking the completion source invalidates approval without writes.
{ const h = harness(), out = await complete(h); const source = h.pages.get(minLesson().id); source.properties[P.lesson.status] = select(STATUS_TODO); scenarios++; await assert.rejects(() => h.r.approve({}, out.proposal.id, true), /完成紀錄|前序|順序/); assert.equal(patches(h).length, 0); }
// A non-whitelist item injected into the DO proposal is rejected and annotated.
{ const h = harness(), out = await complete(h); out.proposal.items.push({ id: "outside-proposal", snapshot: {}, before: { weekStart: "2027-01-25" }, after: { week: "W15", weekStart: "2027-01-18" } }); await h.storage.put(`reschedule:v1:proposal:${out.proposal.id}`, out.proposal); scenarios++; await assert.rejects(() => h.r.approve({}, out.proposal.id, true), /白名單|資格|快照/); const saved = await h.storage.get(`reschedule:v1:proposal:${out.proposal.id}`); assert.ok(saved.items.at(-1).conflictReason); assert.equal(patches(h).length, 0); }
// A completed outside-52 predecessor may trigger only later lessons in its exact course.
{ const outside = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", h = harness(); h.pages.set(outside, makePage({ id: outside, title: "既有普化精修前課次", course: "普化精修", order: 306 }, "2026-10-19")); const out = await complete(h, outside); scenarios++; assert.ok(out.proposal); assert.ok(out.proposal.items.every(x => x.snapshot.course === "普化精修" && x.snapshot.order > 306)); assert.equal(out.proposal.source.id, outside); await h.r.approve({}, out.proposal.id, true); assert.equal(patches(h).length, 2); assert.equal(patches(h).some(x => x.path.endsWith(outside)), false); }
// A completion in another course cannot move either chemistry series.
{ const outside = "bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb", h = harness(); h.pages.set(outside, makePage({ id: outside, title: "既有生物前課次", course: "生物", order: 1 }, "2026-10-19")); const out = await complete(h, outside); scenarios++; assert.equal(out.proposal, null); assert.equal(patches(h).length, 0); assert.equal((await h.r.refresh({})).proposal, null); }
// Physical 10-1 completion may advance only later physics lessons, never chemistry.
{ const h = harness(); h.pages.set(anchorId, makePage({ id: anchorId, title: "物理 第10-1堂", course: "物理", order: 306 }, "2027-02-08")); const out = await complete(h, anchorId); scenarios++; assert.ok(out.proposal); assert.ok(out.proposal.items.every(x => x.snapshot.course === "物理" && x.snapshot.order > 306)); assert.ok(out.proposal.items.some(x => x.title === "物理 第10-2堂")); }
// Physical 10-1 anchor is a real read-only page: 10-2 is blocked without it, then eligible when anchor is complete; duplicate events do not cascade.
{ const id = APPROVED_LESSONS.find(x => x.title === "物理 第10-2堂").id, outside = "dddddddddddd4ddd8ddddddddddddddd", h = harness(); for (const [k, p] of h.pages) if (k !== id) p.properties[P.lesson.status] = select(STATUS_DONE); h.pages.set(outside, makePage({ id: outside, title: "物理前課次", course: "物理", order: 305 }, "2026-10-19")); await h.r.recordCompletion({ id: outside, done: true, doneDate: "2026-10-12" }); const one = await h.r.refresh({}); scenarios++; assert.equal(one.proposal, null);
  const h2 = harness(); for (const [k, p] of h2.pages) if (k !== id) p.properties[P.lesson.status] = select(STATUS_DONE); const anchor = makePage({ id: anchorId, title: "物理 第10-1堂", course: "物理", order: 306 }, "2027-02-08", { status: STATUS_DONE, doneDate: "2026-10-12" }); h2.pages.set(anchorId, anchor); await h2.r.recordCompletion({ id: anchorId, done: true, doneDate: "2026-10-12" }); const yes = await h2.r.refresh({}); assert.ok(yes.proposal?.items.some(x => x.id === id)); assert.ok(yes.proposal.items.every(x => x.snapshot.course === "物理")); const two = await h2.r.refresh({}); assert.equal(two.proposal.id, yes.proposal.id); }
// A completion during or after its own scheduled week does not look like early progress.
for (const doneDate of ["2026-10-12", "2026-10-13"]) { const id = minLesson().id, h = harness({ mutate: { [id]: { weekStart: "2026-10-12", week: "W01" } } }); const out = await complete(h, id, doneDate); scenarios++; assert.equal(out.proposal, null); assert.equal(patches(h).length, 0); }
// Target no-op, applying/restart hold, ambiguous PATCH is once-only; min/max week bounds are enforced.
{ const h = harness(), out = await complete(h), item = out.proposal.items[0], p = h.pages.get(item.id); p.properties[P.lesson.weekLabel] = text(item.after.week); p.properties[P.lesson.weekStart] = date(item.after.weekStart); scenarios++; assert.equal((await h.r.approve({}, out.proposal.id, true)).proposal.results[0].state, "noop"); const h2 = harness(), x = await complete(h2); await h2.storage.put(`reschedule:v1:proposal:${x.proposal.id}`, { ...x.proposal, state: "applying" }); assert.equal((await h2.r.refresh({})).proposal.state, "applying"); const h3 = harness(), z = await complete(h3); let n = 0; const failing = createRescheduler({ notion: async (_e, path, method = "GET") => { if (method === "PATCH") { n++; throw Error("ambiguous"); } return h3.pages.get(path.split("/").at(-1)); }, rd, wr, storage: h3.storage, now: () => Date.parse("2026-10-12T12:00:00Z") }); await assert.rejects(() => failing.approve({}, z.proposal.id, true), /結果不明/); assert.equal(n, 1); }
// Queue/event deduplication: same completion cannot mint a second card.
{ const h = harness(); await complete(h); const n = h.calls.length; await h.r.recordCompletion({ id: minLesson().id, done: true, doneDate: "2026-10-12" }); const again = await h.r.refresh({}); scenarios++; assert.equal(again.proposal.id, (await h.r.current()).proposal.id); assert.equal(patches(h).length, 0); assert.ok(h.calls.length >= n); }

// Generation, not just approval, excludes completed, in-progress, micro,
// non-video, missing-type and mismatched-ID targets.
for (const variant of ["完成", "進行中", "微課", "文章", "missing-type", "outside-id"]) {
  const h = harness(), target = APPROVED_LESSONS.find(x => x.order === 308).id;
  const p = h.pages.get(target);
  if (["完成", "進行中"].includes(variant)) p.properties[P.lesson.status] = select(variant);
  else if (variant === "微課") p.properties[P.lesson.title] = title("微課｜資料頁");
  else if (variant === "文章") p.properties[P.lesson.type] = select("文章");
  else if (variant === "missing-type") delete p.properties[P.lesson.type];
  else p.id = "not-an-approved-id";
  const out = await complete(h); scenarios++;
  assert.ok(!out.proposal?.items.some(x => x.id === target || x.id === "not-an-approved-id"));
  assert.equal(patches(h).length, 0);
  for (const item of out.proposal?.items || []) {
    assert.ok(APPROVED_LESSONS.some(x => x.id === item.id));
    assert.equal((Date.parse(item.before.weekStart) - Date.parse(item.after.weekStart)) / DAY, 7);
    assert.ok(item.after.weekStart <= "2027-03-15");
  }
}
// A destination cannot precede the current week, and dates outside the final
// authorized week are not repaired by silently broadening proposal eligibility.
for (const beforeDate of ["2026-10-12", "2027-03-22"]) {
  const h = harness(), target = APPROVED_LESSONS.find(x => x.order === 308).id;
  h.pages.get(target).properties[P.lesson.weekStart] = date(beforeDate);
  const out = await complete(h); scenarios++;
  assert.ok(!out.proposal?.items.some(x => x.id === target));
}
{ const h = harness({ now: () => Date.parse("2027-03-20T02:00:00Z") }); const out = await complete(h); scenarios++; assert.equal(out.proposal, null); assert.equal(patches(h).length, 0); }
// An in-progress same-course predecessor is not moved and blocks a descendant
// from being placed in a week before it.
{ const h = harness(), first = minLesson().id, second = APPROVED_LESSONS.find(x => x.order === 308).id;
  h.pages.get(first).properties[P.lesson.status] = select("進行中");
  const out = await complete(h, APPROVED_LESSONS.find(x => x.order === 317).id); scenarios++;
  assert.ok(!out.proposal?.items.some(x => x.id === first || x.id === second));
}
// A cron-like refresh preserves legitimate already-at-target no-ops.
{ const h = harness(), out = await complete(h);
  for (const item of out.proposal.items) { const p = h.pages.get(item.id); p.properties[P.lesson.weekLabel] = text(item.after.week); p.properties[P.lesson.weekStart] = date(item.after.weekStart); p.last_edited_time = "2026-10-13T00:00:00Z"; }
  scenarios++; assert.equal((await h.r.refresh({})).proposal.state, "pending");
  const result = await h.r.approve({}, out.proposal.id, true); assert.ok(result.proposal.results.every(x => x.state === "noop")); assert.equal(patches(h).length, 0);
}
// A late manual edit seen only at the final single-page re-read must stop.
// If it affects item two, item one remains applied; there is no unsafe rollback.
for (const lateIndex of [0, 1]) {
  const h = harness(), out = await complete(h), lateId = out.proposal.items[lateIndex].id;
  const gets = new Map(); let writes = 0;
  const r = createRescheduler({ storage: h.storage, rd, wr, now: () => Date.parse("2026-10-12T12:00:00Z"),
    notion: async (_e, path, method = "GET", body, options) => {
      const id = path.split("/").at(-1), p = h.pages.get(id); if (!p) throw Error("offline missing");
      if (method === "GET") { const n = (gets.get(id) || 0) + 1; gets.set(id, n); if (id === lateId && n === 2) p.properties[P.lesson.length] = number(999); }
      else { assert.equal(options.once, true); writes++; p.properties = { ...p.properties, ...body.properties }; }
      return structuredClone(p);
    } });
  scenarios++; await assert.rejects(() => r.approve({}, out.proposal.id, true), /再次變更/);
  assert.equal(writes, lateIndex);
  const stored = (await r.current()).proposal; assert.equal(stored.state, "conflict"); assert.equal(stored.items[lateIndex].state, "conflict");
  if (lateIndex === 1) assert.equal(stored.results[0].state, "applied");
}
console.log(`reschedule offline tests passed (${scenarios} scenarios)`);
