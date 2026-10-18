import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from "miniflare";
import { DB, P, STATUS_DONE } from "./config.js";

const root = await mkdtemp(path.join(tmpdir(), "study-durable-runtime-"));
const bundle = path.join(root, "worker.mjs");
await build({ entryPoints: [new URL("./index.js", import.meta.url).pathname], bundle: true, format: "esm", outfile: bundle });
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const lid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const text = (s) => ({ title: [{ plain_text: s, text: { content: s } }] });
const check = (b) => ({ checkbox: !!b });
const select = (s) => ({ select: { name: s } });
const date = (s) => ({ date: s ? { start: s } : null });
const pages = new Map([[lid, { id: lid, parent: { database_id: DB.lessons }, properties: {
  [P.lesson.title]: text("真實 runtime 課次"), [P.lesson.subject]: select("化學"),
  [P.lesson.status]: select("未開始"), [P.lesson.weekStart]: date(today),
  [P.lesson.order]: { number: 1 }, [P.lesson.length]: { number: 50 }, [P.lesson.doneDate]: date(null),
} }]]);
const plain = (p) => (p?.title || p?.rich_text || []).map((x) => x.plain_text || x.text?.content || "").join("");
function match(page, f) {
  if (!f) return true;
  if (f.and) return f.and.every((x) => match(page, x));
  if (f.or) return f.or.some((x) => match(page, x));
  if (f.timestamp) return true;
  const p = page.properties[f.property] || {};
  if (f.checkbox) return !!p.checkbox === f.checkbox.equals;
  if (f.rich_text) return plain(p) === f.rich_text.equals;
  if (f.relation) return (p.relation || []).some((x) => x.id === f.relation.contains);
  if (f.date?.equals) return p.date?.start === f.date.equals;
  if (f.date?.before) return !!p.date?.start && p.date.start < f.date.before;
  throw new Error("unhandled runtime filter " + JSON.stringify(f));
}
let creates = 0, lessonWrites = 0, networkCalls = 0;
const response = (value, status = 200) => new RuntimeResponse(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const options = {
  rootPath: root, name: "study-runtime-test", scriptPath: bundle, modules: true, compatibilityDate: "2026-01-01",
  durableObjects: { LESSON_AUTOMATION: { className: "LessonAutomationCoordinator", useSQLite: true } },
  resourcePersistencePath: path.join(root, "storage"),
  bindings: { APP_KEY: "offline-test-key", NOTION_TOKEN: "offline-test-token" },
  outboundService: async (request) => {
    assert.equal(new URL(request.url).origin, "https://api.notion.com", "no real external requests allowed");
    networkCalls++;
    const u = new URL(request.url); const body = request.method === "GET" ? null : await request.json();
    if (u.pathname.endsWith("/query")) {
      const db = u.pathname.split("/databases/")[1].split("/")[0];
      return response({ results: [...pages.values()].filter((p) => p.parent.database_id.replaceAll("-", "") === db && match(p, body.filter)), has_more: false });
    }
    if (u.pathname === "/v1/pages" && request.method === "POST") {
      creates++;
      const p = { id: tid, parent: body.parent, properties: body.properties };
      for (const prop of Object.values(p.properties)) for (const entry of prop.title || prop.rich_text || []) entry.plain_text = entry.text.content;
      pages.set(tid, p); return response(p);
    }
    const id = u.pathname.split("/").at(-1); const p = pages.get(id);
    if (!p) return response({}, 404);
    if (request.method === "PATCH") {
      if (id === lid) lessonWrites++;
      p.properties = { ...p.properties, ...body.properties };
    }
    return response(p);
  },
};
let runtime;
try {
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  let ns = await runtime.getDurableObjectNamespace("LESSON_AUTOMATION");
  let actor = ns.get(ns.idFromName("study-dashboard-lessons-v1"));
  const daily = () => actor.fetch("https://internal/daily", { method: "POST", body: JSON.stringify({ cron: "10 16 * * *", scheduledTime: Date.now() }) });
  const results = await Promise.all([daily(), daily()]);
  for (const r of results) assert.equal(r.status, 200, await r.clone().text());
  assert.equal(creates, 1, "actual workerd actor serializes concurrent daily requests");
  let app = await runtime.getWorker();
  const auditRequest = (suffix = "", headers = { "x-app-key": "offline-test-key" }) => app.fetch("https://app/api/automation/audit" + suffix, { headers });
  const beforeAudit = networkCalls;
  assert.equal((await auditRequest("", {})).status, 401);
  const audit = await (await auditRequest()).json();
  assert.equal(audit.slots.length, 1); assert.equal(audit.slots[0].state, "created");
  assert.equal(networkCalls, beforeAudit, "audit must not call Notion");
  // Recreate the full runtime, retaining the actual on-disk SQLite database.
  await runtime.dispose(); runtime = new Miniflare(convertV4MiniflareOptions(options));
  ns = await runtime.getDurableObjectNamespace("LESSON_AUTOMATION");
  actor = ns.get(ns.idFromName("study-dashboard-lessons-v1"));
  assert.equal((await daily()).status, 200); assert.equal(creates, 1);
  app = await runtime.getWorker();
  const complete = await app.fetch(`https://app/api/task/${tid}`, {
    method: "POST", headers: { "x-app-key": "offline-test-key", "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  assert.equal(complete.status, 200, await complete.clone().text());
  assert.equal(pages.get(lid).properties[P.lesson.status].select.name, STATUS_DONE);
  assert.equal(pages.get(lid).properties[P.lesson.doneDate].date.start, today);
  assert.equal(lessonWrites, 1);
  const taskAudit = await (await auditRequest(`?taskId=${tid}`)).json();
  assert.equal(taskAudit.task.completion.phase, "applied");
  assert.equal(taskAudit.task.completion.source, "dashboard");
  assert.equal(taskAudit.task.completion.date, today);
  await daily(); assert.equal(creates, 1); assert.equal(lessonWrites, 1);
  console.log(`workerd SQLite durable tests passed (${networkCalls} mocked Notion calls)`);
} finally {
  if (runtime) await runtime.dispose();
  await rm(root, { recursive: true, force: true });
}
