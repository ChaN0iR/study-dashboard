import assert from "node:assert/strict";
import { AutomationJournal, normalizeId } from "./journal.js";

class FakeStorage {
  constructor() { this.data = new Map(); this.tail = Promise.resolve(); }
  async get(k) { return structuredClone(this.data.get(k)); }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = startAfter ? keys.findIndex((k) => k > startAfter) : 0;
    return new Map(keys.slice(from < 0 ? keys.length : from, (from < 0 ? keys.length : from) + limit)
      .map((k) => [k, structuredClone(this.data.get(k))]));
  }
  async transaction(fn) {
    const run = this.tail.then(async () => {
      const tx = {
        get: async (k) => structuredClone(this.data.get(k)),
        put: async (k, v) => this.data.set(k, structuredClone(v)),
        delete: async (k) => this.data.delete(k),
      };
      return fn(tx);
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowArgs = (date = "2026-10-18", subject = "化學", lessonId = "AB-CD") =>
  [date, subject, lessonId, { notionTask: "safe content" }];

const storage = new FakeStorage();
const a = new AutomationJournal(storage), b = new AutomationJournal(storage);
const [r1, r2] = await Promise.all([a.reserve(...rowArgs()), b.reserve(...rowArgs())]);
assert.equal(Number(r1.acquired) + Number(r2.acquired), 1);
const winner = r1.acquired ? r1.row : r2.row;
assert.equal((await a.reserve(...rowArgs())) .acquired, false);
assert.equal((await a.reserve(...rowArgs("2026-10-19", "物理", "ABCD"))).acquired, false);
assert.equal(normalizeId("Ab-CD"), "abcd");
assert.deepEqual(await new AutomationJournal(storage).get(winner.key), winner);

const task = await a.recordTask(winner, "task-1");
assert.deepEqual(task, await b.getTask("task-1"));
assert.equal(task.slotKey, winner.key); assert.equal(task.owned, true);
await assert.rejects(() => a.recordTask(winner, "task-2"), /another task|provenance/);
const afterRecord = await a.getTask("task-1");
const intent = await a.completionIntent("task-1", "2026-10-18", "notion");
assert.equal(intent.completion.date, "2026-10-18");
const retry = await b.completionIntent("task-1", "2026-10-19", "retry");
assert.equal(retry.completion.date, "2026-10-18");
const phased = await a.completionPhase("task-1", "done", { date: "2099-01-01", source: "evil", note: "ok" });
assert.equal(phased.completion.date, "2026-10-18"); assert.equal(phased.completion.source, "notion");
assert.equal(phased.completion.note, "ok");
assert.equal((await a.getTask("task-1")).history.length > afterRecord.history.length, true);

const fresh = new AutomationJournal(storage);
assert.equal((await fresh.getTask("task-1")).completion.phase, "done");
await fresh.releaseLesson({ lessonId: "ab-cd", key: "slot:wrong" });
assert.equal(await fresh.get("lesson:abcd"), winner.key);
await fresh.releaseLesson(winner);
assert.equal(await fresh.get("lesson:abcd"), undefined);
const other = (await fresh.reserve(...rowArgs("2026-10-20", "英文", "X-Y"))).row;
await fresh.releaseLesson(winner);
assert.equal(await fresh.get("lesson:xy"), other.key === "slot:2026-10-20:英文" ? other.key : undefined);

const historyRow = (await fresh.reserve("2026-10-21", "生物", "H-I")).row;
for (let i = 0; i < 125; i++) await fresh.update(historyRow.key, { marker: i }, `event-${i}`);
const audited = await fresh.get(historyRow.key);
assert.equal(audited.history.length, 100); assert.equal(audited.eventCount, 126);
assert.equal(audited.history.at(-1).event, "event-124");

// Exercise list pagination with a storage wrapper that caps each page at 1000.
const many = new FakeStorage();
const originalList = many.list.bind(many);
many.list = async (opts) => originalList({ ...opts, limit: Math.min(opts.limit ?? Infinity, 1000) });
for (let i = 0; i < 1001; i++) await many.transaction((tx) => tx.put(`slot:${String(i).padStart(4, "0")}:s`, { i }));
assert.equal((await new AutomationJournal(many).listSlots()).length, 1001);

console.log("journal tests passed");
