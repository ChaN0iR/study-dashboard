import assert from 'node:assert/strict';
import worker from './index.js';
const original = globalThis.fetch;
const pageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const photo = { type: 'image/png', data: 'iVBORw0KGgo=' };
let scenarios = 0;
async function run(payload, fault = '') {
  const calls = []; let uploads = 0, pages = 0, body;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url); assert.equal(u.origin, 'https://api.notion.com');
    assert.equal(options.method, 'POST'); calls.push(u.pathname);
    const id = () => `${String(uploads).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    if (u.pathname === '/v1/file_uploads') {
      uploads++;
      if (fault === `slot${uploads}`) return new Response('private-token', { status: 500 });
      return Response.json({ id: fault === 'bad-slot' ? '../invalid' : id() });
    }
    if (u.pathname.endsWith('/send')) {
      assert.equal(u.pathname, `/v1/file_uploads/${id()}/send`);
      assert.ok(options.body instanceof FormData);
      if (fault === `send${uploads}`) return new Response('private-token', { status: 500 });
      if (fault === 'send-throw') throw new Error('private-token');
      if (fault === 'send-json') return new Response('{');
      return Response.json({ id: fault === 'send-id' ? pageId : id(), status: fault === 'pending' ? 'pending' : 'uploaded' });
    }
    assert.equal(u.pathname, '/v1/pages'); body = JSON.parse(options.body);
    if (fault === 'create-lost') { pages++; throw new Error('private-token'); }
    if (fault.startsWith('create-status')) return Response.json({ message: 'private-token' }, { status: Number(fault.split(':')[1]) });
    if (fault === 'create-json') return new Response('{');
    if (fault === 'create-id') return Response.json({});
    pages++; return Response.json({ id: pageId });
  };
  const before = structuredClone(payload);
  const response = await worker.fetch(new Request('https://offline.example/api/note', {
    method: 'POST', headers: { 'x-app-key': 'offline', 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }), { APP_KEY: 'offline', NOTION_TOKEN: 'offline-fixture' });
  const result = await response.json(); assert.deepEqual(payload, before);
  assert.doesNotMatch(JSON.stringify(result), /private-token/); scenarios++;
  return { response, result, calls, pages, body };
}
try {
  for (const n of [0, 1, 2, 8]) {
    const r = await run({ title: 'offline', photos: Array(n).fill(photo) });
    assert.equal(r.response.status, 200); assert.equal(r.result.photos, n);
    assert.equal(r.calls.length, n * 2 + 1); assert.equal(r.calls.at(-1), '/v1/pages');
    assert.equal((r.body.children || []).length, n);
    for (let i = 0; i < n; i++) assert.equal(r.body.children[i].image.file_upload.id, `${String(i+1).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`);
  }
  const grouped = await run({ title: 'grouped', pages: [{ photos: [photo] }, { photos: [photo] }] });
  assert.deepEqual(grouped.body.children.map(b => b.type), ['paragraph', 'image', 'paragraph', 'image']);
  assert.deepEqual(grouped.body.children.filter(b => b.type === 'paragraph').map(b => b.paragraph.rich_text[0].text.content), ['第 1 頁', '第 2 頁']);
  for (const payload of [{ photos: [photo, { ...photo, type: 'text/plain' }] }, { pages: [{ photos: Array(5).fill(photo) }, { photos: Array(4).fill(photo) }] }, { pages: null }, { pages: [null] }, { photos: {} }, { photos: Array(9).fill(photo) }, { photos: [{ ...photo, data: 'x'.repeat(4_000_001) }] }]) {
    const r = await run({ title: 'invalid', ...payload }); assert.equal(r.response.status, 400); assert.equal(r.calls.length, 0);
  }
  for (const fault of ['slot1', 'slot2', 'send1', 'send2', 'bad-slot', 'send-throw', 'send-json', 'send-id', 'pending']) {
    const r = await run({ title: 'failure', photos: [photo, photo] }, fault);
    assert.equal(r.response.status, 502, fault); assert.equal(r.result.code, 'NOTE_UPLOAD_FAILED');
    assert.equal(r.pages, 0); assert.ok(!r.calls.includes('/v1/pages'));
  }
  for (const fault of ['create-status:400', 'create-status:429', 'create-status:500', 'create-lost', 'create-json', 'create-id']) {
    const r = await run({ title: 'uncertain', photos: [photo] }, fault);
    assert.equal(r.response.status, 502, fault); assert.equal(r.result.code, 'NOTE_CREATE_UNCERTAIN');
    assert.equal(r.calls.filter(p => p === '/v1/pages').length, 1); assert.match(r.result.error, /勿直接重送/);
    if (fault === 'create-lost') assert.equal(r.pages, 1);
  }
} finally { globalThis.fetch = original; }
console.log(`Offline note recovery: ${scenarios} scenarios passed; no external requests`);
