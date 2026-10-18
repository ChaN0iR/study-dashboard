import { LessonAutomationCoordinator } from "./index.js";

const clone = (v) => v == null ? v : structuredClone(v);

export function makeStorage(seed = {}) {
  const data = new Map(Object.entries(clone(seed)));
  let tail = Promise.resolve();
  const api = {
    async get(key) { return clone(data.get(String(key))); },
    async put(key, value) { data.set(String(key), clone(value)); },
    async delete(key) { return data.delete(String(key)); },
    async list({ prefix = "", limit = 1000, startAfter } = {}) {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = startAfter == null ? 0 : Math.max(0, keys.indexOf(String(startAfter)) + 1);
      return new Map(keys.slice(start, start + limit).map((k) => [k, clone(data.get(k))]));
    },
    async transaction(fn) {
      const run = tail.then(async () => {
        const snapshot = new Map([...data.entries()].map(([k, v]) => [k, clone(v)]));
        const tx = {
          get: api.get, put: api.put,
          delete: api.delete,
          list: api.list,
        };
        try {
          return await fn(tx);
        } catch (error) {
          data.clear();
          for (const [key, value] of snapshot) data.set(key, value);
          throw error;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
    _data: data,
  };
  return api;
}

export function makeNamespace(env, storage = makeStorage()) {
  let actor;
  const binding = {
    idFromName(name) { return String(name); },
    get() {
      if (!actor) actor = new LessonAutomationCoordinator({ storage }, env);
      return { fetch: (input, init) => actor.fetch(input instanceof Request ? input : new Request(input, init)) };
    },
    recreate() { actor = new LessonAutomationCoordinator({ storage }, env); return actor; },
    storage,
  };
  return { storage, binding, recreate: () => binding.recreate() };
}

export function ensureRequest(input, init) {
  return input instanceof Request ? input : new Request(input, init);
}
