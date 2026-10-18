import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const config = await readFile(new URL('./config.js', import.meta.url), 'utf8');

class Node {
  constructor(tag = '') { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  get textContent() { return this._text ?? this.children.map((n) => typeof n === 'object' ? n.textContent : String(n)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  click() { return this.listeners.click?.({ currentTarget: this, target: this, preventDefault() {} }); }
}

function harness({ proposal, search = '', apiImpl, now = 1760000000000 } = {}) {
  const nodes = new Map();
  const calls = [];
  const local = new Map([['apiBase', 'https://api.test'], ['appKey', 'test-key']]);
  const fetch = async (input, init = {}) => {
    calls.push({ path: String(input), method: init.method || 'GET', body: init.body });
    if (!apiImpl) throw Error('TEST_NETWORK_BLOCKED');
    return apiImpl(String(input), init);
  };
  const context = {
    URLSearchParams, URL, Request, Date: class extends Date { static now() { return now; } }, Intl, console,
    setTimeout, clearTimeout, structuredClone, prompt() { return null; },
    location: { search, href: 'https://test.invalid/' },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) },
    fetch, window: { fetch, CONFIG: null, addEventListener() {}, removeEventListener() {} },
    document: {
      createElement: (tag) => new Node(tag), createTextNode: (text) => String(text),
      getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
      querySelectorAll: () => [],
      hidden: false,
    },
  };
  vm.createContext(context);
  vm.runInContext(config, context);
  context.window.CONFIG = context.CONFIG || context.window.CONFIG;
  const withoutInit = source.replace(/\n\s*init\(\);\s*\n?\s*\}\)\(\);\s*$/, '\n})();');
  const expose = `\n globalThis.testing = {\n  setProposal(value) { rescheduleProposal = value; },\n  setState(value) { state = value; },\n  renderReschedule, loadReschedule, approveReschedule, toggleTask,\n  getProposal() { return rescheduleProposal; }\n };`;
  vm.runInContext(withoutInit.replace('\n})();', expose + '\n})();'), context);
  context.testing.setProposal(proposal ?? null);
  return { context, testing: context.testing, nodes, calls };
}

const pending = (extra = {}) => ({
  id: 'proposal-1', state: 'pending', expiresAt: '2099-03-20T23:59:59+08:00',
  reason: '保留考試日前緩衝。',
  items: [{ id: 'lesson-1', title: '普化第02-1堂', estimatedMinutes: 82, before: { week: 'W01', weekStart: '2026-10-12' }, after: { week: 'W22', weekStart: '2027-03-15' }, reason: '順延。' }],
  ...extra,
});

function approveButton(nodes) { return nodes.get('reschedule-card').children.find((n) => n?.tag === 'button'); }

test('load/render 只 GET，畫面展示估計分鐘且不會自動核准', async () => {
  const h = harness({ proposal: pending(), apiImpl: async (_path, init) => ({ ok: true, async json() { return { proposal: pending() }; }, status: 200, ...init }) });
  await h.testing.loadReschedule();
  assert.deepEqual(h.calls.map((x) => x.method), ['GET']);
  assert.match(h.nodes.get('reschedule-card').textContent, /估計 82 分鐘/);
  assert.match(h.nodes.get('reschedule-card').textContent, /週分鐘估算/);
  assert.equal(approveButton(h.nodes).disabled, false);
});

test('點擊只對正確 proposal id 發固定 approve payload POST', async () => {
  let resolve;
  const h = harness({ proposal: pending(), apiImpl: async (path, init) => {
    if (init.method === 'POST') { await new Promise((r) => { resolve = r; }); return { ok: true, async json() { return { proposal: pending({ state: 'applied' }) }; }, status: 200 }; }
    return { ok: true, async json() { return { proposal: pending() }; }, status: 200 };
  } });
  h.testing.renderReschedule();
  const click = approveButton(h.nodes).click();
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'POST');
  assert.match(h.calls[0].path, /\/api\/reschedule\/proposal-1\/approve$/);
  assert.deepEqual(JSON.parse(h.calls[0].body), { approve: true });
  assert.equal(approveButton(h.nodes).disabled, true);
  resolve(); await click;
});

test('並發連點只送一次 POST，409 僅 GET 不重送 approve', async () => {
  let postCount = 0, getCount = 0;
  const h = harness({ proposal: pending(), apiImpl: async (_path, init) => {
    if (init.method === 'POST') { postCount++; const e = Error('conflict'); e.status = 409; throw e; }
    getCount++; return { ok: true, async json() { return { proposal: pending({ state: 'conflict' }) }; }, status: 200 };
  } });
  h.testing.renderReschedule();
  await Promise.all([h.nodes.get('reschedule-card').children.find((n) => n?.tag === 'button').click(), h.nodes.get('reschedule-card').children.find((n) => n?.tag === 'button').click()]);
  assert.equal(postCount, 1);
  assert.equal(getCount, 1);
  assert.match(h.nodes.get('reschedule-card').textContent, /已停止核准/);
});

test('過期與 conflict 禁止核准，applying 顯示未知結果且不自動重送', async () => {
  for (const proposal of [pending({ expiresAt: 1000 }), pending({ state: 'conflict' }), pending({ state: 'applying', reason: '後端回覆不明' })]) {
    const h = harness({ proposal, apiImpl: async () => { throw Error('must not call'); } });
    h.testing.renderReschedule();
    const b = approveButton(h.nodes);
    assert.equal(b, undefined, `${proposal.state} should not expose an active approve button`);
    if (proposal.state === 'applying') assert.match(h.nodes.get('reschedule-card').textContent, /已停止自動重送，需核對/);
  }
});

test('DEMO 模式載入與核准不出網', async () => {
  const h = harness({ proposal: pending(), search: '?demo=1', apiImpl: async () => { throw Error('network must not be called'); } });
  await h.testing.loadReschedule();
  assert.equal(h.calls.length, 0);
  h.testing.renderReschedule();
  await h.nodes.get('reschedule-card').children.find((n) => n?.tag === 'button').click();
  assert.equal(h.calls.length, 0);
});


test('衝突列保留原差異並顯示原因；未知分鐘不誤算為零', () => {
  const proposal = pending({ state: 'conflict' });
  proposal.items[0].state = 'conflict';
  proposal.items[0].conflictReason = '狀態已變更';
  proposal.items[0].estimatedMinutes = null;
  const h = harness({ proposal });
  h.testing.renderReschedule();
  const text = h.nodes.get('reschedule-card').textContent;
  assert.match(text, /此列衝突：狀態已變更/);
  assert.match(text, /未知分鐘未當零/);
  assert.doesNotMatch(text, /W22 0 分鐘/);
  assert.match(text, /Notion 不支援原子條件更新/);
  assert.equal(approveButton(h.nodes), undefined);
});
