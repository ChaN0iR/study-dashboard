import assert from 'node:assert/strict';
import test from 'node:test';
import { runAcceptance, STAGING_TITLE } from './note-staging-acceptance.mjs';
import { DB, P } from './config.js';

const staging = '11111111111111111111111111111111';
const page = '22222222222222222222222222222222';
const live = { mode: 'live', databaseId: staging, token: 'synthetic-test-token',
  confirmation: `WRITE SYNTHETIC NOTE TO ${staging}` };
function mock({ title = STAGING_TITLE, database = staging, schema = true, failSend = false,
  failCreate = false, badReadback = false } = {}) {
  const calls = [];
  let uploads = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, init });
    assert.equal(u.origin, 'https://api.notion.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (u.pathname.startsWith('/v1/databases/')) return Response.json({ id: database,
      title: [{ plain_text: title }], properties: schema ? {
        [P.note.title]: {type: 'title'}, [P.note.date]: {type: 'date'},
        [P.note.status]: {type: 'select', select: { options: [{name: '未複習'}] }},
      } : {} });
    if (u.pathname === '/v1/file_uploads') return Response.json({ id: `33333333-3333-3333-3333-${String(++uploads).padStart(12, '0')}` });
    if (u.pathname.endsWith('/send')) {
      assert.ok(init.body instanceof FormData);
      return new Response('', {status: failSend ? 503 : 200});
    }
    if (u.pathname === '/v1/pages') {
      const body = JSON.parse(init.body);
      assert.equal(body.parent.database_id, staging);
      assert.match(body.properties[P.note.title].title[0].text.content, /^\[STAGING ACCEPTANCE\] /);
      assert.deepEqual(body.children.map(b => b.type), ['paragraph', 'image', 'paragraph', 'image']);
      if (failCreate) throw new Error('synthetic-test-token upstream secret');
      return Response.json({id: page});
    }
    if (u.pathname === `/v1/blocks/${page}/children`) return Response.json({has_more: false,
      results: badReadback ? [] : [
        {type: 'paragraph', paragraph: {rich_text: [{plain_text: '第 1 頁'}]}}, {type: 'image'},
        {type: 'paragraph', paragraph: {rich_text: [{plain_text: '第 2 頁'}]}}, {type: 'image'},
      ]});
    throw new Error('unexpected endpoint');
  };
  return {calls, fetchImpl};
}

test('default plan cannot use a supplied token or network', async () => {
  const result = await runAcceptance({token: 'unused', fetchImpl: () => {throw new Error('network');}});
  assert.equal(result.mode, 'plan');
  assert.equal(result.networkCalls, 0);
  assert.equal(result.writes, 0);
});

test('known production IDs, malformed IDs and absent confirmation/token fail before network', async () => {
  let calls = 0;
  const fetchImpl = () => {calls++; throw new Error('network');};
  for (const databaseId of [...Object.values(DB), DB.notes.toUpperCase(),
    DB.notes.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), '', 'not-an-id']) {
    await assert.rejects(runAcceptance({...live, databaseId, fetchImpl}));
  }
  await assert.rejects(runAcceptance({...live, confirmation: undefined, fetchImpl}));
  await assert.rejects(runAcceptance({...live, token: undefined, fetchImpl}));
  assert.equal(calls, 0);
});

test('staging metadata mismatch permits only the initial GET', async () => {
  for (const options of [{title: '正式筆記'}, {database: page}, {schema: false}]) {
    const m = mock(options);
    await assert.rejects(runAcceptance({...live, fetchImpl: m.fetchImpl}));
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].init.method, undefined);
  }
});

test('candidate uploads two synthetic images, creates once in staging, and reads back only that page', async () => {
  const originalFetch = globalThis.fetch;
  const originalNotes = DB.notes;
  const m = mock();
  const result = await runAcceptance({...live, fetchImpl: m.fetchImpl});
  assert.equal(result.status, 'PASS');
  assert.equal(result.pageId, page);
  assert.equal(result.networkCalls, 7);
  assert.equal(m.calls.filter(c => c.path === '/v1/pages').length, 1);
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(DB.notes, originalNotes);
});

test('upload failure leaves no page; ambiguous page create is never retried or cleaned up', async () => {
  const originalFetch = globalThis.fetch;
  const originalNotes = DB.notes;
  for (const options of [{failSend: true}, {failCreate: true}, {badReadback: true}]) {
    const m = mock(options);
    await assert.rejects(runAcceptance({...live, fetchImpl: m.fetchImpl}), error => {
      assert.equal(error.message.includes('synthetic-test-token'), false);
      assert.equal(error.evidence.pageCreateAttempted, !options.failSend);
      if (options.badReadback) assert.equal(error.evidence.pageId, page);
      return true;
    });
    assert.equal(m.calls.filter(c => c.path === '/v1/pages').length, options.failSend ? 0 : 1);
    assert.equal(m.calls.some(c => c.init.method === 'PATCH' || c.init.method === 'DELETE'), false);
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(DB.notes, originalNotes);
  }
});

test('parallel invocation cannot overlap the process-wide staging override', async () => {
  const m = mock();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = runAcceptance({...live, fetchImpl: async (...args) => {
    await gate;
    return m.fetchImpl(...args);
  }});
  try {
    await assert.rejects(runAcceptance({...live, fetchImpl: m.fetchImpl}), /Only one/);
  } finally { release(); }
  assert.equal((await first).status, 'PASS');
});
