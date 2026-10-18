const clone = (value) => value == null ? value : structuredClone(value);

export const normalizeId = (id) => String(id ?? "").replace(/-/g, "").toLowerCase();

const now = () => new Date().toISOString();
const slotKey = (date, subject) => `slot:${date}:${subject}`;
const lessonKey = (id) => `lesson:${normalizeId(id)}`;
const taskKey = (id) => `task:${normalizeId(id)}`;
const audit = (event, at = now()) => ({ at, event: String(event) });
const appendHistory = (row, entry) => {
  const history = [...(Array.isArray(row.history) ? row.history : []), entry];
  row.history = history.slice(-100);
  row.eventCount = (Number.isFinite(row.eventCount) ? row.eventCount : history.length - 1) + 1;
};
const isTransaction = (storage) => typeof storage.transaction === "function";

export class AutomationJournal {
  constructor(storage) {
    if (!storage) throw new TypeError("storage is required");
    this.storage = storage;
  }

  async _tx(fn) {
    if (isTransaction(this.storage)) return this.storage.transaction(fn);
    throw new TypeError("storage.transaction is required");
  }

  async reserve(date, subject, lessonId, payload) {
    const key = slotKey(date, subject);
    const lkey = lessonKey(lessonId);
    return this._tx(async (tx) => {
      const existing = await tx.get(key);
      if (existing) return { acquired: false, row: clone(existing) };
      const lock = await tx.get(lkey);
      if (lock) {
        const lockedRow = await tx.get(typeof lock === "string" ? lock : lock.slotKey);
        return { acquired: false, row: clone(lockedRow || lock) };
      }
      const at = now();
      const row = {
        key, date, subject, lessonId,
        operationKey: `full-lesson:${date}:${subject}`,
        payload: clone(payload), state: "reserved", taskId: null,
        createdAt: at, updatedAt: at, history: [audit("reserved", at)], eventCount: 1,
      };
      await tx.put(key, clone(row));
      await tx.put(lkey, key);
      return { acquired: true, row: clone(row) };
    });
  }

  async get(key) { return clone(await this.storage.get(key)); }

  async update(key, patch, event) {
    return this._tx(async (tx) => {
      const current = await tx.get(key);
      if (!current) return null;
      const updated = { ...current, ...clone(patch), updatedAt: now() };
      appendHistory(updated, audit(event));
      await tx.put(key, clone(updated));
      return clone(updated);
    });
  }

  async listSlots() {
    const out = [];
    let startAfter;
    for (;;) {
      const options = { prefix: "slot:", limit: 1000 };
      if (startAfter) options.startAfter = startAfter;
      const listed = await this.storage.list(options);
      const entries = listed instanceof Map ? [...listed.entries()] : Array.isArray(listed)
        ? listed.map((x) => [x?.key, x?.value ?? x]) : Object.entries(listed || {});
      for (const [, value] of entries) out.push(clone(value?.value ?? value));
      if (entries.length < 1000) break;
      startAfter = entries[entries.length - 1][0];
      if (!startAfter) break;
    }
    return out;
  }

  async recordTask(row, taskId) {
    const key = row.key;
    const lkey = lessonKey(row.lessonId);
    const tkey = taskKey(taskId);
    return this._tx(async (tx) => {
      const prior = await tx.get(tkey);
      if (prior && (prior.lessonId !== row.lessonId || prior.slotKey !== key)) {
        throw new Error("task provenance mismatch");
      }
      const slot = await tx.get(key);
      if (slot?.taskId && slot.taskId !== taskId) throw new Error("slot already owned by another task");
      const at = now();
      const task = prior ? { ...prior } : {
        taskId, slotKey: key, lessonId: row.lessonId, operationKey: row.operationKey,
        createdDate: row.date, completion: null, owned: true,
        history: [audit("task-recorded", at)], eventCount: 1,
      };
      if (prior && prior.taskId !== taskId) throw new Error("task provenance mismatch");
      if (!prior) await tx.put(tkey, clone(task));
      const current = slot || row;
      const updated = { ...current, state: "created", taskId, updatedAt: at };
      appendHistory(updated, audit("task-recorded", at));
      await tx.put(key, clone(updated));
      return clone(task);
    });
  }

  async getTask(id) { return clone(await this.storage.get(taskKey(id))); }

  async updateTask(id, patch, event) {
    return this._tx(async (tx) => {
      const key = taskKey(id), current = await tx.get(key);
      if (!current) return null;
      const updated = { ...current, ...clone(patch), updatedAt: now() };
      appendHistory(updated, audit(event));
      await tx.put(key, clone(updated));
      return clone(updated);
    });
  }

  async releaseLesson(row) {
    return this._tx(async (tx) => {
      const key = lessonKey(normalizeId(row.lessonId)), lock = await tx.get(key);
      if (lock === row.key) await tx.delete(key);
      return lock === row.key;
    });
  }

  async completionIntent(taskId, date, source) {
    return this._tx(async (tx) => {
      const key = taskKey(taskId), task = await tx.get(key);
      if (!task || task.owned !== true) throw new Error("owned task required");
      if (task.completion) return clone(task);
      const at = now();
      const updated = { ...task, completion: { date, source, phase: "intent", observedAt: at } };
      appendHistory(updated, audit("completion-intent", at));
      await tx.put(key, clone(updated));
      return clone(updated);
    });
  }

  async completionPhase(taskId, phase, extra = {}) {
    return this._tx(async (tx) => {
      const key = taskKey(taskId), task = await tx.get(key);
      if (!task || task.owned !== true || !task.completion) throw new Error("completion intent required");
      const at = now();
      const safeExtra = { ...clone(extra) };
      delete safeExtra.date;
      delete safeExtra.source;
      const completion = { ...task.completion, phase, ...safeExtra,
        date: task.completion.date, source: task.completion.source };
      const updated = { ...task, completion };
      appendHistory(updated, audit(`completion-${phase}`, at));
      await tx.put(key, clone(updated));
      return clone(updated);
    });
  }
}

export default AutomationJournal;
