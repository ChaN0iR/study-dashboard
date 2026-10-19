import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const policy = await readFile(new URL('./task-policy.js', import.meta.url), 'utf8');
const config = await readFile(new URL('./config.js', import.meta.url), 'utf8');
const today = '2026-10-17';

class Node {
  constructor(tag = '') { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; }
  append(...nodes) { this.children.push(...nodes.flat().filter((n) => n != null)); }
  replaceChildren(...nodes) { this.children = nodes.flat().filter((n) => n != null); }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'class') this.className = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  focus() {}
  querySelector() { return null; }
  closest() { return null; }
  get textContent() { return this._text ?? this.children.map((n) => typeof n === 'object' ? n.textContent : String(n)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
}

function harness(data = {}, { weekday = 'Sat', min = 600, responses = {} } = {}) {
  const nodes = new Map();
  const fetchCalls = [];
  const document = {
    hidden: false, activeElement: null,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
    querySelector: () => new Node('main'),
    addEventListener() {},
    body: new Node('body'),
  };
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url), 'http://test.local').pathname;
    fetchCalls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (responses[path] instanceof Error) throw responses[path];
    const value = path === '/api/reschedule' ? {} : (responses[path] ?? {});
    return { ok: true, status: 200, async json() { return value; } };
  };
  const context = {
    URLSearchParams, location: { search: '', protocol: 'http:' },
    window: { fetch }, document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Date, Intl, console, fetch, navigator: { userAgent: '', serviceWorker: { register: async () => {} } },
    ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }), requestAnimationFrame: (fn) => fn(),
    addEventListener() {}, setInterval() { return 0; }, clearInterval() {}, setTimeout, clearTimeout,
    structuredClone, prompt: () => null,
    __apiHandler: async () => ({}),
  };
  vm.createContext(context);
  vm.runInContext(config + '\n' + policy, context);
  context.window.CONFIG = context.window.CONFIG;
  const inject = `globalThis.testing = {
    setState(value, verified = true) { state = value; xpVerified = verified; },
    setClock() { taipeiNow = () => ({date: '${today}', wd: '${weekday}', min: ${min}}); },
    setPending(id) { pendingTaskWrites.add(id); },
    courseSelectionData, lessonChoiceItem, renderCourseSelection, renderTasks, renderLessons,
    achievementData, toggleLesson, taskItem,
  };`;
  vm.runInContext(source.replace('  init();', `renderAll = () => {}; loadReschedule = async () => {}; api = (...args) => globalThis.__apiHandler(...args);\n${inject}`), context);
  context.__apiHandler = async (path, body) => { fetchCalls.push({ path, body }); const value = responses[path]; if (value instanceof Error) throw value; return typeof value === 'function' ? value(path, body) : (value ?? {}); };
  context.testing.setClock();
  context.testing.setState({ today, tasks: [], lessons: [], ...data });
  return { api: context.testing, nodes, fetchCalls, context };
}
const lesson = (id, extra = {}) => ({ id, title: id, course: '普化', weekStart: '2026-10-12', done: false, skipped: false, order: 1, ...extra });
const studyTask = (id, extra = {}) => ({ id, title: id, type: '練習', date: today, done: false, skipped: false, estimatedMinutes: 30, relatedCourses: ['普化'], ...extra });
const click = (node) => node.listeners.click();

 test('補做週優先；只列 weekStart<=today，未來與無日期不杜撰', () => {
  const { api } = harness({ lessons: [lesson('future', { weekStart: '2026-10-20' }), lesson('unknown', { weekStart: null }), lesson('current', { order: 2 }), lesson('carry', { weekStart: '2026-10-05' })] });
  const d = api.courseSelectionData();
  assert.deepEqual(d.lessons.map((x) => [x.id, x.carryover]), [['carry', true], ['current', false]]);
  assert.match(d.status, /部分課次日期未提供/);
});

test('selector 與今日完成明細分離，完成日期才會進今日明細', () => {
  const lessons = [lesson('open'), lesson('done', { done: true, doneDate: today }), lesson('old', { done: true, doneDate: '2026-10-16' })];
  const { api, nodes } = harness({ lessons, courseStats: [{ course: '普化', total: 3, done: 2 }] });
  assert.deepEqual(api.courseSelectionData().lessons.map((x) => x.id), ['open']);
  api.renderLessons();
  assert.match(nodes.get('lessons').textContent, /done/);
  assert.doesNotMatch(nodes.get('lessons').textContent, /open|old/);
});

test('task/lesson blocked、skipped、pending prerequisite 不可繞過', () => {
  const blocked = lesson('blocked', { blocked: true });
  const skipped = lesson('skipped', { skipped: true });
  const linked = lesson('linked');
  const { api } = harness({ lessons: [blocked, skipped, linked], tasks: [studyTask('pre', { blocked: true, relatedLessonIds: ['linked'] })] });
  const d = api.courseSelectionData();
  assert.deepEqual(d.lessons.map((x) => x.id), ['blocked', 'linked']);
  const blockedButton = api.lessonChoiceItem(d.lessons[0]).children[1];
  assert.equal(blockedButton.disabled, true);
  assert.equal(api.lessonChoiceItem(d.lessons[1]).children[1].disabled, true);
});

test('toggleLesson 以原始同 id target；double click 只有一次 API，server doneDate 才移入明細，失敗不虛增', async () => {
  const first = lesson('same', { title: 'old target' });
  const duplicate = lesson('same', { title: 'duplicate target' });
  let calls = 0;
  const { api, nodes, fetchCalls } = harness({ lessons: [first, duplicate], courseStats: [{ course: '普化', total: 2, done: 0 }] }, { responses: { '/api/lesson/same': new Error('offline') } });
  const choice = api.lessonChoiceItem(api.courseSelectionData().lessons[0]);
  const p1 = click(choice.children[1]); const p2 = click(choice.children[1]);
  await Promise.all([p1, p2]);
  calls = fetchCalls.filter((x) => x.path === '/api/lesson/same').length;
  assert.equal(calls, 1);
  assert.equal(first.done, false, 'empty server response must not fabricate completion');
  assert.equal(duplicate.done, false, 'write target is first original id owner');
  assert.equal(api.achievementData().rows[0].items.length, 0);
});

test('toggleLesson 成功採 server doneDate；取消會清空日期', async () => {
  const l = lesson('ok');
  const responses = { '/api/lesson/ok': { id: 'ok', done: true, doneDate: today, status: '完成' } };
  const { api } = harness({ lessons: [l] }, { responses });
  await api.toggleLesson(l);
  assert.equal(l.done, true); assert.equal(l.doneDate, today);
  assert.equal(api.achievementData().rows[0].items.length, 1);
  responses['/api/lesson/ok'] = { id: 'ok', done: false, doneDate: null, status: '未開始' };
  await api.toggleLesson(l);
  assert.equal(l.done, false); assert.equal(l.doneDate, null);
  assert.equal(api.achievementData().rows[0].items.length, 0);
});

test('fresh complete、empty/unverified/skipped/unknown status 可辨識', () => {
  const complete = harness({ lessons: [lesson('done', { done: true })], tasks: [studyTask('t', { done: true })] });
  assert.equal(complete.api.courseSelectionData().status, '已完成現階段任務');
  const empty = harness(); assert.match(empty.api.courseSelectionData().status, /沒有已載入/);
  const unverified = harness({ lessons: [lesson('x')] }); unverified.api.setState({ today, lessons: [lesson('x')], tasks: [] }, false); assert.match(unverified.api.courseSelectionData().status, /未驗證/);
  const skipped = harness({ lessons: [lesson('s', { skipped: true })] }); assert.match(skipped.api.courseSelectionData().status, /略過/);
  const unknown = harness({ lessons: [lesson('u', { weekStart: null })] }); assert.match(unknown.api.courseSelectionData().status, /日期未提供/);
  const pending = harness({ lessons: [lesson('p')] }); pending.api.setPending('p'); assert.match(pending.api.courseSelectionData().status, /儲存確認中/);
});

test('Sunday Today 任務缺時用 lesson fallback，但 bedtime 不露未完成 lesson', () => {
  const data = { lessons: [lesson('fallback')], tasks: [{ id: 'meal', title: '晚餐', type: '生活', date: today, done: false, skipped: false }] };
  const sunday = harness(data, { weekday: 'Sun', min: 600 }); sunday.api.renderTasks();
  assert.match(sunday.nodes.get('tasks').textContent, /fallback/);
  assert.ok(sunday.nodes.get('tasks').textContent.indexOf('晚餐') < sunday.nodes.get('tasks').textContent.indexOf('fallback'));
  const bedtime = harness(data, { weekday: 'Sun', min: 22 * 60 }); bedtime.api.renderTasks();
  assert.doesNotMatch(bedtime.nodes.get('tasks').textContent, /fallback/);
});


test('課次入口不繞過缺失／略過前置與樂觀完成尚待儲存的關聯任務', async () => {
  for (const prerequisite of [null, { id: 'parent', done: false }, { id: 'parent', done: true, skipped: true }]) {
    const l = lesson('child');
    const child = studyTask('child-task', { relatedLessonIds: ['child'], prerequisiteTaskIds: ['parent'] });
    const { api, fetchCalls } = harness({ lessons: [l], tasks: [...(prerequisite ? [prerequisite] : []), child] });
    assert.equal(api.lessonChoiceItem(l).children[1].disabled, true);
    await api.toggleLesson(l);
    assert.equal(fetchCalls.length, 0);
    assert.equal(l.done, false);
  }
  for (const done of [false, true]) {
    const l = lesson('pending-lesson');
    const linked = studyTask('pending-task', { done, relatedLessonIds: [l.id] });
    const { api, fetchCalls } = harness({ lessons: [l], tasks: [linked] });
    api.setPending(linked.id);
    assert.equal(api.lessonChoiceItem(l).children[1].disabled, true);
    await api.toggleLesson(l);
    assert.equal(fetchCalls.length, 0);
    assert.equal(l.done, false);
  }
  const skippedLesson = lesson('skipped-linked');
  const skipped = harness({ lessons: [skippedLesson], tasks: [studyTask('skip', { skipped: true, relatedLessonIds: [skippedLesson.id] })] });
  assert.equal(skipped.api.lessonChoiceItem(skippedLesson).children[1].disabled, true);
  await skipped.api.toggleLesson(skippedLesson);
  assert.equal(skipped.fetchCalls.length, 0);
});

test('選課以同 ID 原物件寫入並同步真實統計，未回覆前不冒稱完成', async () => {
  const original = lesson('stable');
  const copy = { ...original };
  const stats = { course: '普化', total: 3, done: 0 };
  let resolveWrite;
  const h = harness({ lessons: [original], courseStats: [stats] }, { responses: {
    '/api/lesson/stable': () => new Promise(resolve => { resolveWrite = resolve; }),
  } });
  const writing = h.api.toggleLesson(copy);
  assert.equal(original.done, false);
  assert.equal(stats.done, 0);
  assert.equal(h.api.lessonChoiceItem(original).children[1].disabled, true);
  resolveWrite({ id: original.id, done: true, doneDate: today, status: '完成' });
  await writing;
  assert.equal(original.done, true);
  assert.equal(copy.done, false);
  assert.equal(stats.done, 1);
  assert.equal(h.api.achievementData().rows[0].items.length, 1);
});


test('不完整成功回應不虛增完成數，休息日有課時不顯示沒有任務', async () => {
  const l = lesson('malformed');
  const stats = { course: '普化', total: 2, done: 0 };
  const h = harness({ lessons: [l], courseStats: [stats] }, { responses: { '/api/lesson/malformed': {} } });
  await h.api.toggleLesson(l);
  assert.equal(l.done, false);
  assert.equal(stats.done, 0);
  assert.equal(h.api.achievementData().rows[0].items.length, 0);
  const sunday = harness({ lessons: [lesson('available')] }, { weekday: 'Sun' });
  sunday.api.renderTasks();
  assert.match(sunday.nodes.get('tasks').textContent, /available/);
  assert.doesNotMatch(sunday.nodes.get('tasks').textContent, /今天沒有任務|已完成現階段任務/);
});


test('成就兩卡各自 Toggle，說明／規則歸屬正確且選課是獨立按鈕', () => {
  const { api, nodes } = harness({ lessons: [lesson('choose-me')], courseStats: [{ course: '普化', total: 10, done: 2 }] });
  api.renderLessons();
  const root = nodes.get('achievement-summary');
  const metrics = root.children.find(node => node.className === 'achievement-metrics');
  assert.equal(metrics.children.length, 2);
  const [course, xp] = metrics.children;
  assert.match(course.textContent, /已完成／總課次.*課程進度.*2／10 堂.*20%/);
  assert.match(xp.textContent, /今日任務已得 XP.*0 XP.*未指派課程.*0 XP/);
  const [courseHeading, courseBody] = course.children;
  const [xpHeading, xpBody] = xp.children;
  const courseToggle = courseHeading.children[0], xpToggle = xpHeading.children[0];
  for (const [button, body] of [[courseToggle, courseBody], [xpToggle, xpBody]]) {
    assert.equal(button.tag, 'button');
    assert.equal(button.attrs.type, 'button');
    assert.equal(button.attrs['aria-expanded'], 'true');
    assert.equal(button.attrs['aria-controls'], body.attrs.id);
    assert.equal(body.hidden, false);
  }
  const notes = courseBody.children.find(node => node.tag === 'details');
  assert.equal(notes.children[0].textContent, '資料狀態與說明');
  assert.match(notes.textContent, /資料日期.*今日 XP 僅依.*課次明細只顯示.*選課補做優先/);
  assert.ok(courseBody.children.includes(nodes.get('lessons')));
  assert.ok(xpBody.children.includes(nodes.get('achievement-xp-rules')));
  click(courseToggle);
  assert.equal(courseBody.hidden, true);
  assert.equal(courseToggle.attrs['aria-expanded'], 'false');
  assert.equal(xpBody.hidden, false);
  click(xpToggle);
  assert.equal(xpBody.hidden, true);
  api.renderLessons();
  const rerendered = root.children[0].children;
  assert.ok(rerendered.every(panel => panel.children[1].hidden), '各自狀態跨重繪保留');
  const selector = root.children[1], [button, content] = selector.children;
  assert.equal(button.tag, 'button');
  assert.equal(button.textContent, '選擇課程去完成');
  assert.equal(button.attrs.type, 'button');
  assert.equal(button.attrs['aria-controls'], content.attrs.id);
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(content.hidden, true);
  click(button);
  assert.equal(content.hidden, false);
  assert.equal(button.attrs['aria-expanded'], 'true');
  assert.match(content.textContent, /choose-me.*標記完成/);
  api.renderLessons();
  assert.equal(root.children[1].children[1].hidden, false, '選課跨儲存重繪不收合');
  assert.doesNotMatch(nodes.get('lessons').textContent, /choose-me/);
});
