import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const policy = await readFile(new URL('./task-policy.js', import.meta.url), 'utf8');
const config = await readFile(new URL('./config.js', import.meta.url), 'utf8');
const today = '2026-10-17';
const plain = value => JSON.parse(JSON.stringify(value));
class Node {
  constructor(tag = '') { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; }
  append(...nodes) { this.children.push(...nodes.flat().filter(n => n != null)); }
  replaceChildren(...nodes) { this.children = nodes.flat().filter(n => n != null); }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  get textContent() { return this._text ?? this.children.map(n => typeof n === 'object' ? n.textContent : String(n)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
}
function harness(tasks = [], { weekday = 'Sat', min = 600, response } = {}) {
  const nodes = new Map(), calls = [];
  const context = {
    URLSearchParams, location: { search: '' }, window: { fetch() { throw Error('NETWORK_BLOCKED'); } },
    document: { createElement: tag => new Node(tag), getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id);
    } }, localStorage: { getItem: () => null }, Date, Intl, console,
    setTimeout: () => 0, clearTimeout() {},
    __api: async (path, body) => {
      calls.push({ path, body });
      if (response instanceof Error) throw response;
      return response ?? { id: path.split('/').pop(), done: body.done, skipped: body.skip };
    },
  };
  vm.createContext(context);
  vm.runInContext(config + '\n' + policy, context);
  const expose = `
    renderAll = () => {}; loadReschedule = async () => {};
    api = (...args) => globalThis.__api(...args);
    globalThis.testing = {
      setClock(wd, min) { taipeiNow = () => ({ date: '${today}', wd, min }); },
      setState(value) { state = value; },
      getState() { return state; },
      setPending(id) { pendingTaskWrites.add(id); },
      taskScheduledSlot, taskCourseSlot, taskScheduleSlot, taskItem, renderTasks,
      isStudyTask, isLifeTask, taskStages, taskSubject, taskSummary, taskBlocked,
      taskCanSetDone, taskCheckboxDisabled, coursePointAllocation, courseSelectionData,
      taskViewNow, compareTaskDisplay, taskDisplayIsCurrent, toggleTask, skipTask,
    };`;
  vm.runInContext(source.replace('  init();', expose), context);
  const api = context.testing;
  api.setClock(weekday, min);
  api.setState({ today, tasks, lessons: [], courseStats: [] });
  return { api, nodes, calls, policy: context.TaskPolicy, slots: context.window.CONFIG.SCHEDULE };
}
const task = (extra = {}) => ({ id: 'task', title: '化學第02堂練習', type: '練習', date: today,
  done: false, skipped: false, order: 2, estimatedMinutes: 30, difficulty: '標準',
  relatedSubjects: ['化學'], relatedCourses: ['普化'], relatedLessonIds: [], ...extra });
const options = h => ({ today, weekday: 'Sat', nowMin: 16 * 60, slots: h.slots,
  activeSlot: h.slots.find(s => s.start === '15:45'), bedMinute: 22 * 60,
  isStudyTask: h.api.isStudyTask, isLifeTask: h.api.isLifeTask,
  getSlot: t => h.api.taskScheduleSlot(t, h.slots) });

test('缺值與空白欄位完全回退舊排程、分類與顯示', () => {
  const h = harness();
  for (const original of [task(), task({ title: 'Anki 到期卡', relatedSubjects: [], relatedCourses: [] }),
    task({ title: '晚餐＋蛋白粉', type: '生活' }), task({ title: '無分類', type: null, relatedSubjects: [], relatedCourses: [] })]) {
    for (const scheduledTime of [undefined, null, '', '  \t\n']) {
      const withFields = { ...original, scheduledTime, recallRoom: false };
      assert.equal(h.api.taskScheduleSlot(withFields, h.slots), h.api.taskScheduleSlot(original, h.slots));
      assert.equal(h.api.taskItem(withFields).textContent, h.api.taskItem(original).textContent);
      assert.equal(h.api.isStudyTask(withFields), h.api.isStudyTask(original));
      assert.equal(h.api.isLifeTask(withFields), h.api.isLifeTask(original));
    }
  }
});

test('有效排定時段優先於標題、科目與關聯，邊界內子時段唯一映射', () => {
  const h = harness();
  for (const scheduledTime of ['15:45–16:30', '16:00–16:20', '15:45–16:00', '16:00–16:30']) {
    const row = task({ scheduledTime });
    assert.equal(h.api.taskScheduleSlot(row, h.slots), h.slots.find(s => s.start === '15:45'));
    assert.match(h.api.taskItem(row).textContent, new RegExp(`${scheduledTime} · 排定時段`));
    assert.equal(h.api.taskSubject(row), '化學', '排定時段不改科目分類');
    assert.equal(h.api.taskDisplayIsCurrent(row, options(h)), true);
  }
  const conflict = task({ title: '化學與英文練習', relatedSubjects: ['化學', '英文'], scheduledTime: '13:30–15:30' });
  assert.equal(h.api.taskScheduleSlot(conflict, h.slots).start, '13:30');
  const life = task({ title: '午餐', type: '生活', scheduledTime: '17:30–19:00' });
  assert.equal(h.api.taskScheduleSlot(life, h.slots).start, '17:30');
  assert.equal(h.api.isLifeTask(life), true);
});

test('非法格式、時間範圍、跨日、跨段與空檔不猜配，也不丟掉任務', () => {
  const values = ['8:30–12:00', '08:30-12:00', '08:30—12:00', '08:30～12:00',
    '08:30 – 12:00', ' 08:30–12:00', '08:30–12:00\n', '08:30–12:00 ',
    '24:00–25:00', '08:60–12:00', '08:30–24:00', '16:30–15:45', '08:30–08:30',
    '23:00–01:00', '11:00–14:00', '15:20–16:00', '06:00–07:00', '22:00–23:00',
    '08:30–12:00,15:45–16:30', 123, false, {}];
  for (const scheduledTime of values) {
    const row = task({ scheduledTime });
    const before = JSON.stringify(row);
    const h = harness([row]);
    assert.equal(h.api.taskScheduleSlot(row, h.slots), null, String(scheduledTime));
    assert.match(h.api.taskItem(row).textContent, /未配時/);
    h.api.renderTasks();
    assert.equal(h.nodes.get('tasks').children.length, 1);
    assert.match(h.nodes.get('tasks').textContent, /未配時/);
    assert.equal(h.api.taskViewNow().view.tasks[0].id, row.id);
    assert.equal(JSON.stringify(row), before, '配時失敗不修改任務');
  }
});

test('缺少、重複或重疊可用時段明示未配時，不選第一筆', () => {
  const h = harness();
  const physics = h.slots.find(s => s.start === '15:45');
  const row = task({ scheduledTime: '16:00–16:20' });
  for (const slots of [[], h.slots.filter(s => s !== physics), [...h.slots, { ...physics }],
    [...h.slots, { start: '16:10', end: '16:40', name: '重疊' }],
    [...h.slots.filter(s => s !== physics), { start: '15:45', end: '16:05' }, { start: '16:10', end: '16:30' }]]) {
    assert.equal(h.api.taskScheduleSlot(row, slots), null);
    assert.match(h.api.taskCourseSlot(row, slots).reason, /未配時/);
  }
});

test('補做和略過清單保留欄位及未配時資訊，排序仍可用', () => {
  const prior = task({ id: 'prior', date: '2026-10-16', makeup: true, carryover: true, scheduledTime: '11:00–14:00', recallRoom: true });
  const skipped = task({ id: 'skip', skipped: true, scheduledTime: 'bad', recallRoom: true });
  const current = task({ id: 'current', order: 99, scheduledTime: '15:45–16:30' });
  const h = harness([prior, skipped, current], { min: 16 * 60 });
  const view = h.api.taskViewNow().view;
  assert.equal(view.tasks.find(t => t.id === 'prior').scheduledTime, prior.scheduledTime);
  assert.equal(view.skipped[0].recallRoom, true);
  const sorted = [prior, current].sort((a, b) => h.api.compareTaskDisplay(a, b, options(h)));
  assert.deepEqual(sorted.map(t => t.id), ['current', 'prior']);
  h.api.renderTasks();
  assert.match(h.nodes.get('tasks').textContent, /補做.*回想室.*未配時/);
  assert.match(h.nodes.get('skipped').textContent, /回想室.*未配時/);
});

test('回想室僅新增標籤；分類、Anki、每日必做、前置、完成與 XP 逐筆不變', () => {
  const rows = [task({ done: true }), task({ id: 'anki', title: 'Anki：清完到期卡＋新卡 20 張', done: true, relatedSubjects: [], relatedCourses: [] }),
    task({ id: 'life', title: '午餐', type: '生活', done: true }), task({ id: 'admin', title: '設定 Anki', type: null, done: true }),
    task({ id: 'unknown', title: '回想室', type: null, relatedSubjects: [], relatedCourses: [], done: true }),
    task({ id: 'skip', done: true, skipped: true }), task({ id: 'blocked', prerequisiteTaskIds: ['missing'], blocked: true }),
    task({ id: 'old', date: '2026-10-16', makeup: true, carryover: true }), task({ id: 'required', title: '每日必做｜物理公式回想' })];
  const snapshot = JSON.stringify(rows);
  const h = harness(rows);
  const originalXP = h.api.coursePointAllocation(rows, today);
  const semantic = row => plain({ study: h.api.isStudyTask(row), life: h.api.isLifeTask(row),
    stages: h.api.taskStages(row), subject: h.api.taskSubject(row), summary: h.api.taskSummary(row),
    daily: h.policy.isDailyRequired(row), blocked: h.api.taskBlocked(row),
    canComplete: h.api.taskCanSetDone(row, true), canCancel: h.api.taskCanSetDone(row, false),
    disabled: h.api.taskCheckboxDisabled(row, false), slot: h.api.taskScheduleSlot(row, h.slots) });
  for (const row of rows) {
    for (const recallRoom of [false, true]) {
      const marked = { ...row, recallRoom };
      assert.deepEqual(semantic(marked), semantic(row));
      const oldItem = h.api.taskItem(row), item = h.api.taskItem(marked);
      assert.equal(item.children[0].attrs['aria-checked'], oldItem.children[0].attrs['aria-checked']);
      assert.equal(item.children[0].disabled, oldItem.children[0].disabled);
      assert.equal(item.className, oldItem.className);
      const labels = node => node.children.find(n => n.className === 't task-copy').children[0].children.slice(1).map(n => n.textContent);
      const expected = labels(oldItem);
      if (recallRoom) expected.splice(h.api.taskStages(row).length + Number(row.carryover === true), 0, '回想室');
      assert.deepEqual(labels(item), expected);
    }
  }
  const markedRows = rows.map(row => ({ ...row, recallRoom: true }));
  const markedXP = h.api.coursePointAllocation(markedRows, today);
  assert.deepEqual(plain(markedXP), plain(originalXP));
  assert.deepEqual([...markedXP.byCourse], [...originalXP.byCourse]);
  for (const weekday of ['Sat', 'Sun']) for (const nowMin of [7 * 60 + 15, 600, 21 * 60 + 10]) {
    const opts = { ...options(h), weekday, nowMin };
    const normalize = view => plain({ ...view, tasks: view.tasks.map(t => ({ ...t, recallRoom: undefined })),
      skipped: view.skipped.map(t => ({ ...t, recallRoom: undefined })), restCourse: view.restCourse && { ...view.restCourse, recallRoom: undefined } });
    assert.deepEqual(normalize(h.policy.taskView(markedRows, opts)), normalize(h.policy.taskView(rows, opts)));
  }
  assert.equal(JSON.stringify(rows), snapshot);
});

test('task 更新只送既有 done/skip；成功、取消及失敗回復皆保留新欄位', async () => {
  for (const response of [undefined, new Error('offline')]) {
    const row = task({ scheduledTime: '15:45–16:30', recallRoom: true });
    const h = harness([row], { response });
    for (const operation of [() => h.api.toggleTask(row), () => h.api.toggleTask(row), () => h.api.skipTask(row, true), () => h.api.skipTask(row, false)]) {
      await operation();
      assert.equal(row.scheduledTime, '15:45–16:30'); assert.equal(row.recallRoom, true);
    }
    assert.deepEqual(plain(h.calls.map(c => c.body)), [{ done: true }, { done: response ? true : false }, { skip: true }, { skip: false }]);
    assert.equal(row.done, false); assert.equal(row.skipped, false);
  }
});
