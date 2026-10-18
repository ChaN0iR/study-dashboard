import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const policy = await readFile(new URL('./task-policy.js', import.meta.url), 'utf8');
const config = await readFile(new URL('./config.js', import.meta.url), 'utf8');
const today = '2026-10-17';
function harness(data = {}, search = '') {
  class Node {
    constructor(tag = '') { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes.map((node) => node == null ? String(node) : node); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener() {}
    get textContent() { return this._text ?? this.children.map((n) => typeof n === 'object' ? n.textContent : n).join(''); }
    set textContent(value) { this._text = value; this.children = []; }
  }
  const nodes = new Map();
  const context = { URLSearchParams, location: { search }, window: { fetch() { throw Error('TEST_NETWORK_BLOCKED'); } }, document: {
    createElement: (tag) => new Node(tag), getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id);
    },
  }, localStorage: { getItem: () => null }, Date, Intl, console };
  vm.createContext(context);
  vm.runInContext(config + '\n' + policy, context);
  context.window.CONFIG = context.window.CONFIG;
  vm.runInContext(source.replace('  init();', `globalThis.testing = {
    setState(value, verified = true) { state = value; xpVerified = verified; },
    setPending(id) { pendingTaskWrites.add(id); },
    coursePointAllocation, achievementData, renderLessons, taskCourseSlot, taskScheduleSlot,
    isStudyTask, isLifeTask,
    setClock() { taipeiNow = () => ({date: '${today}', wd: 'Sat', min: 600}); }
  };`), context);
  context.testing.setClock();
  context.testing.setState({ today, tasks: [], lessons: [], ...data });
  return { api: context.testing, nodes, slots: context.window.CONFIG.SCHEDULE };
}
const task = (extra = {}) => ({ id: 't', title: '普化練習題', type: '練習', date: today, done: true, skipped: false, estimatedMinutes: 30, difficulty: '標準', relatedCourses: ['普化'], ...extra });

test('XP 只計今日完成學習，去重且生活行政跳過不計', () => {
  const { api } = harness({ tasks: [task(), task(), task({ id: 'skip', skipped: true }), task({ id: 'life', title: '早餐', type: '生活' }), task({ id: 'admin', title: '同步資料', type: null }), task({ id: 'open', done: false })] });
  const p = api.achievementData().points;
  assert.equal(p.total, 10); assert.equal(p.eligibleTasks, 1);
});
test('先加總後四捨五入、多課程均分且保留未指派', () => {
  const { api } = harness({ tasks: [task({ estimatedMinutes: 31, relatedCourses: ['普化', '物理', '普化'] }), task({ id: 'free', estimatedMinutes: 10, relatedCourses: [] })] });
  const p = api.achievementData().points;
  assert.equal(p.total, 14); assert.equal(p.byCourse.get('普化'), 31 / 6);
  assert.equal(p.byCourse.get('物理'), 31 / 6); assert.equal(p.unassignedRaw, 10 / 3);
  assert.ok(Math.abs([...p.byCourse.values()].reduce((a, b) => a + b, p.unassignedRaw) - p.totalRaw) < 1e-9);
});
test('缺估時難度、日期缺失和跨日完成不冒稱今日所得', () => {
  const { api } = harness({ tasks: [task({ estimatedMinutes: null }), task({ id: 'difficulty', difficulty: '未知' }), task({ id: 'date', date: null }), task({ id: 'prior', date: '2026-10-16', carryover: true })] });
  const p = api.achievementData().points;
  assert.equal(p.total, 0); assert.equal(p.unscoredTasks, 2); assert.equal(p.undatedTasks, 2);
});
test('缺全課統計不能以載入課次推算完整進度，也不猜課程名', () => {
  const { api } = harness({ lessons: [{ title: '普化第01-1堂', done: true, subject: '化學' }] });
  const d = api.achievementData(); assert.equal(d.complete, false); assert.equal(d.total, 1);
  assert.equal(d.rows[0].name, '化學（未設定課程）'); assert.equal(d.rows[0].complete, false);
});
test('完整統計採後端總堂數，零完成不能被 fallback 取代', () => {
  const { api } = harness({ courseStats: [{ course: '普化', subject: '化學', total: 10, done: 0 }], lessons: [{ course: '普化', done: false }] });
  const d = api.achievementData(); assert.equal(d.complete, true); assert.equal(d.total, 10); assert.equal(d.done, 0); assert.equal(d.rows[0].pct, 0);
});
test('異常統計和只有 XP 沒有統計的課程均標未驗證', () => {
  const { api } = harness({ courseStats: [{ course: '普化', total: 1, done: 2 }], tasks: [task({ relatedCourses: ['物理'] })] });
  const d = api.achievementData(); assert.equal(d.complete, false);
  assert.equal(d.rows.find((g) => g.name === '物理').points, 10);
  assert.equal(d.rows.find((g) => g.name === '物理').complete, false);
});
for (const [subject, start, end] of [['化學','08:30','12:00'], ['生物','13:30','15:30'], ['生化','13:30','15:30'], ['物理','15:45','16:30'], ['英文','19:00','20:00']]) {
  test(`${subject} 課程任務優先對應固定時段，不被 Anki／錯題／回顧關鍵字帶走`, () => {
    const { api, slots } = harness();
    const t = task({ title: `Anki 錯題回顧 ${subject}`, relatedSubjects: [subject] });
    assert.equal(api.taskScheduleSlot(t, slots).start, start); assert.equal(api.taskScheduleSlot(t, slots).end, end);
  });
}
test('關聯課程可由統計科目對應，無需從課名猜科目', () => {
  const { api, slots } = harness({ courseStats: [{ course: 'A', subjects: ['物理'] }] });
  assert.equal(api.taskScheduleSlot(task({ title: '第02堂練習', relatedCourses: ['A'] }), slots).start, '15:45');
});
test('跨時段／未知科目／無科目關聯課程不猜時間，生物加生化可共用時段', () => {
  const { api, slots } = harness();
  for (const relatedSubjects of [['化學','物理'], ['未知'], ['物理','未知'], []]) {
    assert.equal(api.taskScheduleSlot(task({ title: '錯題回顧', relatedSubjects, relatedCourses: ['A'] }), slots), null);
  }
  assert.equal(api.taskScheduleSlot(task({ title: '生物與生化複習', relatedCourses: [] }), slots).start, '13:30');
});
test('無課程的 Anki 與生活任務維持原本時段', () => {
  const { api, slots } = harness();
  assert.equal(api.taskScheduleSlot(task({ title: 'Anki 到期卡', relatedCourses: [] }), slots).start, '07:00');
  assert.equal(api.taskScheduleSlot(task({ title: '晚餐＋蛋白粉', type: '生活', relatedCourses: [] }), slots).start, '17:30');
});
test('固定時段缺失時不默認挪至其他窗口，輸入內容不被修改', () => {
  const { api, slots } = harness(); const t = task({ title: '物理錯題', relatedCourses: [] });
  const before = JSON.stringify(t);
  assert.equal(api.taskScheduleSlot(t, slots.filter((s) => s.start !== '15:45')), null);
  assert.equal(JSON.stringify(t), before);
});
test('畫面提供零 XP、未指派、完整堂數／進度，失敗或跨日標未驗證', () => {
  const data = { today, tasks: [], lessons: [], courseStats: [{ course: '普化', subject: '化學', total: 4, done: 1 }] };
  const { api, nodes } = harness(data); api.renderLessons();
  assert.match(nodes.get('achievement-summary').textContent, /0 XP/);
  assert.match(nodes.get('achievement-summary').textContent, /1／4 堂/);
  assert.match(nodes.get('achievement-summary').textContent, /25%/);
  assert.match(nodes.get('lessons').textContent, /今日 0 XP/);
  assert.doesNotMatch(nodes.get('achievement-summary').textContent, /null|undefined/);
  api.setState(data, false); api.renderLessons();
  assert.match(nodes.get('achievement-summary').textContent, /未驗證/);
  assert.match(nodes.get('lessons').textContent, /今日 XP 未驗證/);
  api.setState({ ...data, today: '2026-10-16' }); api.renderLessons();
  assert.match(nodes.get('achievement-summary').textContent, /今日任務已得 XP未驗證/);
});
test('缺資料、待確認與未計分狀態可見', () => {
  const { api, nodes } = harness({ tasks: [task({ estimatedMinutes: null }), task({ id: 'old', date: null })] });
  api.setPending('t'); api.renderLessons(); const text = nodes.get('achievement-summary').textContent;
  assert.match(text, /完整課程統計缺失/); assert.match(text, /1 筆已完成學習任務缺估時/);
  assert.match(text, /1 筆已完成學習任務日期/); assert.match(text, /尚待儲存確認/);
});

test('科目窗口兩端都必須符合既有設定，不接受同起點但錯誤終點', () => {
  const { api, slots } = harness();
  const altered = slots.map((s) => s.start === '15:45' ? { ...s, end: '17:00' } : s);
  assert.equal(api.taskScheduleSlot(task({ title: '物理複習', relatedCourses: [] }), altered), null);
});
test('所有固定學習窗口採左閉右開；週日與睡前政策不因映射改變', () => {
  const ctx = {}; vm.runInNewContext(policy, ctx);
  const { api, slots } = harness();
  for (const [subject, start, end] of [['化學',510,720], ['生物',810,930], ['生化',810,930], ['物理',945,990], ['英文',1140,1200]]) {
    const t = task({ title: subject + '複習', done: false, relatedCourses: [], relatedSubjects: [subject] });
    for (const [nowMin, expected] of [[start - 1,false],[start,true],[end - 1,true],[end,false]]) {
      const activeSlot = slots.find((s) => ctx.TaskPolicy.toMinute(s.start) <= nowMin && nowMin < ctx.TaskPolicy.toMinute(s.end));
      const options = { activeSlot, weekday: 'Sat', nowMin, slots, bedMinute: 1320, isStudyTask: api.isStudyTask, getSlot: (value) => api.taskScheduleSlot(value, slots) };
      assert.equal(ctx.TaskPolicy.taskIsCurrent(t, options), expected, `${subject} ${nowMin}`);
      assert.equal(ctx.TaskPolicy.taskIsCurrent(t, { ...options, weekday: 'Sun' }), false);
    }
  }
});
test('完成取消／跳過會重算扣回，不把課程完成數當任務 XP', () => {
  const t = task(); const { api } = harness({ tasks: [t], courseStats: [{ course: '普化', total: 20, done: 20 }] });
  assert.equal(api.achievementData().points.total, 10);
  t.done = false; assert.equal(api.achievementData().points.total, 0);
  t.done = true; t.skipped = true; assert.equal(api.achievementData().points.total, 0);
});

test('混合完整及缺失統計時，摘要只列實際載入課次而非混加全課總數', () => {
  const { api } = harness({ tasks: [task({ relatedCourses: ['缺統計課程'] })], lessons: [{ course: '普化', done: true }], courseStats: [{ course: '普化', total: 20, done: 2 }] });
  const data = api.achievementData();
  assert.equal(data.complete, false); assert.equal(data.total, 1); assert.equal(data.done, 1);
  assert.equal(data.rows.find((g) => g.course === '普化').total, 20);
});
test('示範模式不把任務或各課程合成積分當成真實 XP', () => {
  const { api, nodes } = harness({ tasks: [task()], courseStats: [{ course: '普化', total: 2, done: 1 }] }, '?demo=1');
  api.renderLessons();
  assert.match(nodes.get('achievement-summary').textContent, /示範資料，不代表真實成就/);
  assert.match(nodes.get('achievement-summary').textContent, /示範不計分/);
  assert.doesNotMatch(nodes.get('achievement-summary').textContent, /10 XP/);
  assert.doesNotMatch(nodes.get('lessons').textContent, /10 XP/);
});
