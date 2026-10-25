import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
const current = source.match(/^const CACHE = "([^"]+)";$/m)[1];

function activate(names, remove) {
  const handlers = new Map();
  const remaining = new Set(names);
  const deleted = [];
  let claims = 0;
  vm.runInNewContext(source, {
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      clients: { claim: () => { claims++; return Promise.resolve(); } },
    },
    caches: {
      keys: async () => [...remaining],
      delete: async name => {
        deleted.push(name);
        if (remove) await remove(name);
        return remaining.delete(name);
      },
    },
  });
  let completion;
  handlers.get('activate')({ waitUntil: promise => { completion = promise; } });
  assert.ok(completion, 'activation extends its lifetime through cleanup and claim');
  return { completion, remaining, deleted, claims: () => claims };
}

test('activation removes only legacy dashboard caches and waits for every deletion before claiming', async () => {
  const preserved = [current, 'sibling-pwa-v1', 'sd-smoke-legacy', 'sd-v', 'sd-vx', 'sd-v135-copy', 'other-sd-v135', 'sd-v135x'];
  const legacy = ['sd-v132', 'sd-v135'];
  const release = new Map();
  let started;
  const allStarted = new Promise(resolve => { started = resolve; });
  const lifecycle = activate([...preserved, ...legacy], name => new Promise(resolve => {
    release.set(name, resolve);
    if (legacy.every(key => release.has(key))) started();
  }));
  await allStarted;
  assert.deepEqual(lifecycle.deleted, legacy);
  assert.equal(lifecycle.claims(), 0, 'clients remain unclaimed while cleanup is pending');
  release.get(legacy[0])();
  await setImmediate();
  assert.equal(lifecycle.claims(), 0, 'one completed deletion cannot finish cleanup');
  release.get(legacy[1])();
  await lifecycle.completion;
  assert.deepEqual([...lifecycle.remaining], preserved);
  assert.equal(lifecycle.claims(), 1);
});

test('activation preserves current and sibling caches when no dashboard legacy exists', async () => {
  const preserved = [current, 'sibling-pwa-v1'];
  const lifecycle = activate(preserved);
  await lifecycle.completion;
  assert.deepEqual(lifecycle.deleted, []);
  assert.deepEqual([...lifecycle.remaining], preserved);
  assert.equal(lifecycle.claims(), 1);
});

test('failed legacy cleanup rejects activation without claiming clients', async () => {
  const failure = new Error('cache storage unavailable');
  const lifecycle = activate([current, 'sd-v135', 'sibling-pwa-v1'], () => Promise.reject(failure));
  await assert.rejects(lifecycle.completion, error => error === failure);
  assert.equal(lifecycle.claims(), 0);
  assert.deepEqual([...lifecycle.remaining], [current, 'sd-v135', 'sibling-pwa-v1']);
});
