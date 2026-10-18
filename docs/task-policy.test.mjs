import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./task-policy.js", import.meta.url), "utf8");
const appSource = await readFile(new URL("./app.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox);
const policy = sandbox.TaskPolicy;
function extractFunction(sourceText, name) {
  const start = sourceText.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js must define ${name}`);
  const open = sourceText.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = open; i < sourceText.length; i++) {
    if (sourceText[i] === "{") depth++;
    if (sourceText[i] === "}" && --depth === 0) return sourceText.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}
const slots = [
  { start: "08:30", end: "12:00", name: "化學", keys: ["化學"] },
  { start: "15:45", end: "16:30", name: "物理", keys: ["物理"] },
  { start: "17:30", end: "19:00", name: "晚餐＋蛋白粉", keys: ["晚餐", "蛋白粉"] },
  { start: "21:00", end: "22:00", name: "收尾＋甘胺酸鎂", keys: ["睡前", "回顧"] },
];
const isLifeTask = (task) => String(task.type || "") === "生活" || /^(早餐|午餐|晚餐|用餐|步數|肌酸|蛋白粉|重量訓練|重訓|運動|洗澡|睡前|簡單清潔|清潔收尾|收尾|甘胺酸|YPT|填\s*YPT)/i.test(task.title || "");
const isStudyTask = (task) => !isLifeTask(task) && (/預習|初學|複習|週複習|練習/.test(task.type || "") || /第\s*\d+.*堂|練習|錯題|複習|看課|(?:看|觀看|上)影片|影片.*(?:課程|第\s*\d+|堂|單元|觀看)/i.test(task.title || ""));
const appSandbox = { TaskPolicy: policy, state: { tasks: [], today: "2026-10-17" }, pendingTaskWrites: new Set() };
const appFunctions = ["taskBlocked", "taskWriteTarget", "taskCanSetDone", "taskCheckboxDisabled", "taskDisplayIsCurrent", "compareTaskDisplay"];
vm.runInNewContext(appFunctions
  .map((name) => extractFunction(appSource, name)).join("\n"), appSandbox);
const getSlot = (task) => slots.find((slot) => (slot.keys || []).some((key) => String(task.title || "").includes(key))) || null;
const options = (overrides = {}) => ({
  today: "2026-10-17", weekday: "Sat", nowMin: 19 * 60 + 30, slots, bedMinute: 22 * 60,
  isStudyTask, isLifeTask, getSlot, ...overrides,
});
const study = (id, title, props = {}) => ({ id, title, type: "複習", done: false, skipped: false, order: 50, ...props });

test("前一天未完成且可補做的學習任務沿用同一個 ID，並在晚間固定生活事項前", () => {
  const view = policy.taskView([
    study("physics", "物理練習題", { date: "2026-10-16", makeup: true, carryover: true, order: 99 }),
    study("dinner", "晚餐＋蛋白粉", { date: "2026-10-16", makeup: true, carryover: true, order: 1 }),
    study("done-old", "已完成化學第01堂", { date: "2026-10-16", makeup: true, carryover: true, done: true }),
    study("skip-old", "已跳過化學第02堂", { date: "2026-10-16", makeup: true, carryover: true, skipped: true }),
    study("unmarked", "未標可補做化學第03堂", { date: "2026-10-16", makeup: false, carryover: true }),
    { id: "today-dinner", title: "晚餐＋蛋白粉", type: "生活", date: "2026-10-17", order: 1 },
  ], options());
  const sorted = view.tasks.sort((a, b) => policy.compareTasks(a, b, options()));
  assert.deepEqual(Array.from(sorted, (task) => task.id), ["physics", "today-dinner"]);
  assert.equal(sorted[0].carryover, true);
  assert.equal(sorted.filter((task) => task.id === "physics").length, 1);
});

test("同一天錯過的學習時段會排在晚間固定事項之前", () => {
  const lateStudy = study("late-study", "化學第05-1堂", { date: "2026-10-17", order: 99 });
  const life = { id: "night-clean", title: "簡單清潔收尾", type: "生活", date: "2026-10-17", order: 1 };
  const sorted = [life, lateStudy].sort((a, b) => policy.compareTasks(a, b, options()));
  assert.deepEqual(sorted.map((task) => task.id), ["late-study", "night-clean"]);
});

test("同 ID 跨日重複時保留今天的原筆資料", () => {
  const current = study("same", "今天的化學複習", { date: "2026-10-17", makeup: false, order: 4 });
  const priorCopy = study("same", "舊日期的化學複習", { date: "2026-10-16", makeup: true, carryover: true, order: 1 });
  const view = policy.taskView([current, priorCopy], options());
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].title, "今天的化學複習");
  assert.equal(view.tasks[0].carryover, false);
});

test("影片課程可補做，YPT／日常回顧等固定事項不滾動", () => {
  const video = study("video", "觀看影片：普化課程第06-1堂", { date: "2026-10-16", makeup: true, carryover: true });
  const ypt = study("ypt", "YPT・步數・心情・重點回顧", { date: "2026-10-16", makeup: true, carryover: true });
  const view = policy.taskView([video, ypt], options());
  assert.deepEqual(Array.from(view.tasks, (task) => task.id), ["video"]);
});

test("睡前不顯示未完成學習任務，也不把它標成當下提示", () => {
  const bedtimeOptions = options({ nowMin: 21 * 60 + 10 });
  const pending = study("pending", "物理複習題", { carryover: true, makeup: true, date: "2026-10-16" });
  const life = { id: "wind-down", title: "睡前整理", type: "生活", order: 1 };
  const view = policy.taskView([pending, life], bedtimeOptions);
  assert.equal(view.suppression, "quiet");
  assert.deepEqual(Array.from(view.tasks, (task) => task.id), ["wind-down"]);
  assert.equal(policy.taskIsCurrent(pending, { ...bedtimeOptions, activeSlot: slots[3] }), false);
});

test("週日休息保留一項最近補做，但不變成當下時段提示", () => {
  const sundayOptions = options({ weekday: "Sun", nowMin: 10 * 60 });
  const carry = study("carry", "化學複習題", { date: "2026-10-16", makeup: true, carryover: true });
  const planned = study("planned", "物理第02-1堂", { date: "2026-10-18" });
  const life = { id: "walk", title: "散步", type: "生活", order: 1 };
  const view = policy.taskView([carry, planned, life], sundayOptions);
  assert.equal(view.suppression, "rest");
  assert.deepEqual(Array.from(view.tasks, (task) => task.id), ["walk", "carry"]);
  assert.equal(view.restCourse.id, "carry");
  assert.equal(policy.taskIsCurrent(carry, { ...sundayOptions, activeSlot: slots[0] }), false);
});

test("前置任務未完成時，後段不會置頂或標成當下提示", () => {
  const blocked = study("blocked", "物理練習題", { carryover: true, makeup: true, date: "2026-10-16", blocked: true, order: 1 });
  const ready = study("ready", "一般複習", { date: "2026-10-17", order: 20 });
  const activeOptions = options({ nowMin: 16 * 60, weekday: "Sat" });
  const sorted = [blocked, ready].sort((a, b) => policy.compareTasks(a, b, activeOptions));
  assert.deepEqual(sorted.map((task) => task.id), ["ready", "blocked"]);
  assert.equal(policy.taskIsCurrent(blocked, { ...activeOptions, activeSlot: slots[1] }), false);
});

test("當下學習時段排在逾期補做之前，但逾期補做仍排在晚間固定生活事項之前", () => {
  const currentOptions = options({ nowMin: 16 * 60, activeSlot: slots[1] });
  const currentStudy = study("current-study", "物理先修第02-1堂", { date: "2026-10-17", order: 99 });
  const overdue = study("overdue-makeup", "化學複習題", { date: "2026-10-16", makeup: true, carryover: true, order: 1 });
  assert.deepEqual([overdue, currentStudy].sort((a, b) => appSandbox.compareTaskDisplay(a, b, currentOptions)).map((task) => task.id), ["current-study", "overdue-makeup"]);

  const lunchSlot = { start: "12:00", end: "13:00", name: "午餐", keys: ["午餐"] };
  const lunchOptions = options({
    nowMin: 12 * 60 + 15, activeSlot: lunchSlot, slots: [...slots, lunchSlot],
    getSlot: (task) => String(task.title || "").includes("午餐") ? lunchSlot : getSlot(task),
  });
  const lunch = { id: "lunch", title: "午餐", type: "生活", date: "2026-10-17", order: 2 };
  assert.deepEqual([overdue, lunch].sort((a, b) => appSandbox.compareTaskDisplay(a, b, lunchOptions)).map((task) => task.id), ["lunch", "overdue-makeup"]);

  const eveningOptions = options({ nowMin: 18 * 60, activeSlot: slots[2] });
  const dinner = { id: "dinner", title: "晚餐＋蛋白粉", type: "生活", date: "2026-10-17", order: 1 };
  assert.deepEqual([dinner, overdue].sort((a, b) => appSandbox.compareTaskDisplay(a, b, eveningOptions)).map((task) => task.id), ["dinner", "overdue-makeup"]);
});

test("前置已略過、未完成或缺失都不能完成；blocked 已完成任務仍可取消完成", () => {
  const pending = { id: "pending", done: false, skipped: false };
  const skipped = { id: "skipped", done: false, skipped: true };
  const complete = { id: "complete", done: true, skipped: false };
  const child = (id, blocked = false, done = false) => ({
    id: `child-${id}`, title: "物理練習題", type: "練習", done, skipped: false,
    blocked, prerequisiteTaskIds: [id], order: 1,
  });
  const visible = [pending, skipped, complete];
  appSandbox.state.tasks = visible;

  const unfinishedChild = child("pending");
  const skippedChild = child("skipped");
  const missingChild = child("missing", true);
  assert.equal(appSandbox.taskBlocked(unfinishedChild, visible), true);
  assert.equal(appSandbox.taskBlocked(skippedChild, visible), true);
  assert.equal(appSandbox.taskBlocked(missingChild, visible), true);
  assert.equal(appSandbox.taskCheckboxDisabled(unfinishedChild, false), true);
  assert.equal(appSandbox.taskCheckboxDisabled(skippedChild, false), true);
  appSandbox.pendingTaskWrites.add(unfinishedChild.id);
  assert.equal(appSandbox.taskCheckboxDisabled(unfinishedChild, true), true);
  appSandbox.pendingTaskWrites.delete(unfinishedChild.id);

  const completedButBlocked = child("skipped", true, true);
  assert.equal(appSandbox.taskBlocked(completedButBlocked, visible), true);
  assert.equal(appSandbox.taskCheckboxDisabled(completedButBlocked, false), false);
  assert.equal(appSandbox.taskCanSetDone(completedButBlocked, false), true);
  assert.equal(appSandbox.taskCanSetDone(completedButBlocked, true), false);

  const newlyUnblocked = child("complete", true);
  assert.equal(appSandbox.taskBlocked(newlyUnblocked, visible), false);
});

test("同科目逾期補做不可搶走白天當下學習排序與光效", () => {
  appSandbox.state.tasks = [];
  const current = study("current", "物理第02堂", { date: "2026-10-17", order: 99 });
  const old = study("old", "物理第01堂", { date: "2026-10-16", carryover: true, makeup: true, order: 1 });
  const unmarkedOld = { ...old, id: "unmarked-old", carryover: false };
  const activeOptions = options({ nowMin: 16 * 60, activeSlot: slots[1] });
  for (const overdue of [old, unmarkedOld]) {
    assert.deepEqual([overdue, current].sort((a, b) => appSandbox.compareTaskDisplay(a, b, activeOptions)).map((t) => t.id), ["current", overdue.id]);
    assert.equal(appSandbox.taskDisplayIsCurrent(overdue, activeOptions), false);
  }
  assert.equal(appSandbox.taskDisplayIsCurrent(current, activeOptions), true);
  assert.equal(appSandbox.taskDisplayIsCurrent({ ...current, skipped: true }, activeOptions), false);
  assert.equal(appSandbox.taskDisplayIsCurrent({ ...current, done: true }, activeOptions), false);
});

for (const [time, dinnerFirst] of [["17:29", false], ["17:30", true], ["18:59", true], ["19:00", false]]) {
  test(`晚餐邊界 ${time}：固定生活分類及完整排序`, () => {
    appSandbox.state.tasks = [];
    const nowMin = policy.toMinute(time);
    const activeSlot = slots.find((s) => nowMin >= policy.toMinute(s.start) && nowMin < policy.toMinute(s.end)) || null;
    const opts = options({ nowMin, activeSlot });
    const overdue = study("old", "物理第01堂", { date: "2026-10-16", carryover: true, makeup: true, order: 99 });
    const dinner = { id: "dinner", title: "晚餐＋蛋白粉", type: "生活", date: "2026-10-17", order: 1 };
    const bed = { id: "bed", title: "睡前整理", type: "生活", date: "2026-10-17", order: 2 };
    const expected = dinnerFirst ? ["dinner", "old", "bed"] : ["old", "dinner", "bed"];
    for (const input of [[bed, overdue, dinner], [dinner, bed, overdue], [overdue, dinner, bed]]) {
      assert.deepEqual(input.sort((a, b) => appSandbox.compareTaskDisplay(a, b, opts)).map((t) => t.id), expected);
    }
    assert.equal(isLifeTask(dinner), true);
    assert.equal(isStudyTask(dinner), false);
    assert.equal(appSandbox.taskDisplayIsCurrent(dinner, opts), dinnerFirst);
  });
}

test("缺失或無法解析的前置資料一律 fail-closed，無關聯則正常", () => {
  const complete = { id: "complete", done: true };
  appSandbox.state.tasks = [complete];
  for (const relation of [["missing"], ["complete", "missing"], [null], [""], ["  "], [123], [{}], "missing", { relation: [{ id: "complete" }] }]) {
    const task = study("child", "物理練習題", { blocked: false, prerequisiteTaskIds: relation });
    assert.equal(appSandbox.taskBlocked(task), true, JSON.stringify(relation));
    assert.equal(appSandbox.taskCanSetDone(task, true), false);
    assert.equal(appSandbox.taskCanSetDone({ ...task, done: true }, false), true);
  }
  for (const relation of [undefined, null, []]) {
    assert.equal(appSandbox.taskBlocked({ prerequisiteTaskIds: relation, blocked: false }), false);
  }
  assert.equal(appSandbox.taskBlocked({ blocked: true }), true);
  const child = study("child", "物理練習題", { blocked: true, prerequisiteTaskIds: ["complete"] });
  assert.equal(appSandbox.taskBlocked(child), false);
  const opts = options({ nowMin: 16 * 60, activeSlot: slots[1] });
  assert.equal(appSandbox.taskDisplayIsCurrent(child, opts), true);
  appSandbox.pendingTaskWrites.add(complete.id);
  assert.equal(appSandbox.taskBlocked(child), true);
  appSandbox.pendingTaskWrites.delete(complete.id);
});

test("disabled:false 不會產生停用屬性，ARIA false 仍保持字串", () => {
  const ctx = { document: { createElement: () => ({
    attributes: {}, append() {}, addEventListener() {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    set disabled(v) { if (v) this.attributes.disabled = ""; else delete this.attributes.disabled; },
    get disabled() { return Object.hasOwn(this.attributes, "disabled"); },
  }) } };
  vm.runInNewContext(extractFunction(appSource, "el"), ctx);
  const button = ctx.el("button", { disabled: false, "aria-checked": false });
  assert.equal(button.disabled, false);
  assert.equal(button.attributes["aria-checked"], "false");
  assert.equal(ctx.el("button", { disabled: true }).disabled, true);
});

function actionHarness(tasks) {
  const calls = [], errors = [], renders = [];
  let resolveWrite, rejectWrite;
  const ctx = {
    TaskPolicy: policy, state: { tasks, today: "2026-10-17" }, pendingTaskWrites: new Set(), toast() {},
    renderAll() { renders.push(policy.taskView(ctx.state.tasks, options()).tasks); },
    api(path, body) {
      calls.push({ path, body });
      return new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
    },
    async guarded(fn) { try { await fn(); } catch (e) { errors.push(e.message); } },
  };
  const start = appSource.indexOf("  const toggleTask = (t) =>");
  const end = appSource.indexOf("  const toggleLesson =", start);
  assert.ok(start !== -1 && end > start);
  vm.runInNewContext(appFunctions.map((name) => extractFunction(appSource, name)).join("\n") + "\n" +
    appSource.slice(start, end) + "\nglobalThis.actions = { toggleTask, skipTask };", ctx);
  return { ctx, calls, errors, renders, succeed: () => resolveWrite(), fail: () => rejectWrite(new Error("offline write failed")) };
}

test("任務畫面副本寫回原筆，跨重繪連點與跳過不會重複送出", async () => {
  const task = study("task", "物理練習題");
  const h = actionHarness([task]);
  const write = h.ctx.actions.toggleTask({ ...task });
  assert.equal(task.done, true);
  assert.equal(h.renders.at(-1)[0].done, true);
  assert.equal(h.ctx.pendingTaskWrites.has(task.id), true);
  h.ctx.actions.toggleTask({ ...task });
  h.ctx.actions.skipTask({ ...task }, true);
  assert.equal(h.calls.length, 1);
  h.succeed(); await write;
  assert.equal(task.done, true);
  assert.equal(h.ctx.pendingTaskWrites.has(task.id), false);
  const undo = h.ctx.actions.toggleTask({ ...task });
  assert.equal(task.done, false);
  h.fail(); await undo;
  assert.equal(task.done, true);
  assert.equal(h.renders.at(-1)[0].done, true);
  assert.equal(h.ctx.pendingTaskWrites.has(task.id), false);
});

test("前置寫入中與缺失前置無法直接完成，已完成 blocked 可撤銷", async () => {
  const parent = study("parent", "物理第01堂");
  const child = study("child", "物理練習題", { prerequisiteTaskIds: ["parent"] });
  const missing = study("missing-child", "物理練習題", { prerequisiteTaskIds: ["absent"], blocked: false });
  const completedBlocked = { ...missing, id: "completed", done: true };
  const h = actionHarness([parent, child, missing, completedBlocked]);
  h.ctx.actions.toggleTask({ ...child });
  h.ctx.actions.toggleTask({ ...missing });
  assert.equal(h.calls.length, 0);
  const first = h.ctx.actions.toggleTask({ ...parent });
  h.ctx.actions.toggleTask({ ...child });
  assert.equal(h.calls.length, 1);
  h.succeed(); await first;
  const next = h.ctx.actions.toggleTask({ ...child });
  assert.equal(h.calls.length, 2);
  h.succeed(); await next;
  const undo = h.ctx.actions.toggleTask({ ...completedBlocked });
  assert.equal(completedBlocked.done, false);
  h.succeed(); await undo;
  const skip = h.ctx.actions.skipTask({ ...parent }, true);
  assert.equal(parent.skipped, true);
  h.fail(); await skip;
  assert.equal(parent.skipped, false);
  assert.equal(h.ctx.pendingTaskWrites.has(parent.id), false);
});

// Regression coverage for the release blockers: no network, no real task data.
test("同 ID 不論輸入順序／carryover 標記，顯示、前置與寫入都選今天原物件", async () => {
  for (const oldCarryover of [true, false, undefined]) {
    for (const currentFirst of [true, false]) {
      const old = study("same", "舊日物理第01堂", { date: "2026-10-16", carryover: oldCarryover, done: true, skipped: true, makeup: true });
      const current = study("same", "今天物理第02堂", { date: "2026-10-17", carryover: true });
      const tasks = currentFirst ? [current, old] : [old, current];
      const view = policy.taskView(tasks, options({ nowMin: 16 * 60 }));
      assert.equal(view.tasks.length, 1);
      assert.equal(view.tasks[0].title, current.title);
      assert.equal(view.tasks[0].carryover, false);
      assert.equal(view.skipped.length, 0);
      assert.equal(policy.uniqueTasks(tasks, "2026-10-17")[0], current);
      const h = actionHarness(tasks);
      assert.equal(h.ctx.taskWriteTarget(old), current);
      assert.equal(h.ctx.taskBlocked({ prerequisiteTaskIds: ["same"] }), true);
      const write = h.ctx.actions.toggleTask(old);
      assert.equal(current.done, true);
      assert.equal(old.done, true);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].body.done, true);
      h.succeed(); await write;
      assert.equal(h.ctx.taskBlocked({ prerequisiteTaskIds: ["same"] }), false);
      const skip = h.ctx.actions.skipTask(old, true);
      assert.equal(current.skipped, true);
      h.fail(); await skip;
      assert.equal(current.skipped, false);
      assert.equal(old.skipped, true);
    }
  }
});

test("前一天已略過即使 carryover false／缺失，不出現在待補做或已跳過；今日已跳過只出現一次", () => {
  for (const carryover of [true, false, undefined]) {
    const old = study("old-skip", "舊物理複習", { date: "2026-10-16", makeup: true, skipped: true, carryover });
    const today = study("today-skip", "今日物理複習", { date: "2026-10-17", skipped: true });
    const duplicateOld = { ...old, id: today.id };
    for (const nowMin of [16 * 60, 21 * 60 + 10]) {
      const view = policy.taskView([old, duplicateOld, today, { ...today }], options({ nowMin }));
      assert.equal(view.tasks.some((t) => t.id === old.id), false);
      assert.deepEqual(Array.from(view.skipped, (t) => t.id), [today.id]);
      assert.equal(view.skipped[0].title, today.title);
    }
  }
});

for (const field of ["done", "skipped"]) {
  for (const succeeds of [false, true]) {
    test(`${field} pending 後 refresh 替換 state／array／object：鎖依 ID、${succeeds ? "成功同步" : "失敗回滾"}正確當前列`, async () => {
      const original = study("stable", "今日物理第02堂", { date: "2026-10-17" });
      const h = actionHarness([original]);
      const write = field === "done" ? h.ctx.actions.toggleTask(original) : h.ctx.actions.skipTask(original, true);
      assert.equal(original[field], true);
      const old = study("stable", "舊日物理第01堂", { date: "2026-10-16", makeup: true, carryover: false, done: true, skipped: true });
      // Deliberately give the refreshed row a different snapshot value; rollback must use the saved previous value.
      const refreshed = { ...original, [field]: succeeds ? false : true };
      const unrelated = study("unrelated", "化學第01堂", { done: true });
      h.ctx.state = { today: "2026-10-17", tasks: [old, unrelated, refreshed] };
      assert.equal(h.ctx.pendingTaskWrites.has(original.id), true);
      assert.equal(h.ctx.taskWriteTarget(original), refreshed);
      assert.equal(h.ctx.taskCheckboxDisabled(refreshed, h.ctx.pendingTaskWrites.has(refreshed.id)), true);
      assert.equal(h.ctx.taskBlocked({ prerequisiteTaskIds: [original.id] }), true);
      h.ctx.actions.toggleTask(refreshed);
      h.ctx.actions.skipTask({ ...original }, false);
      assert.equal(h.calls.length, 1);
      if (succeeds) h.succeed(); else h.fail();
      await write;
      assert.equal(refreshed[field], succeeds);
      assert.equal(old.done, true);
      assert.equal(old.skipped, true);
      assert.equal(unrelated.done, true);
      assert.equal(h.ctx.pendingTaskWrites.has(original.id), false);
      assert.equal(h.errors.length, succeeds ? 0 : 1);
      if (succeeds && field === "done") assert.equal(h.ctx.taskBlocked({ prerequisiteTaskIds: [original.id] }), false);
    });
  }
}

test("refresh 移除任務後，過期閉包不可寫回舊物件或再送出；失敗仍釋放 ID 鎖", async () => {
  const task = study("removed", "物理第02堂");
  const h = actionHarness([task]);
  const write = h.ctx.actions.toggleTask(task);
  h.ctx.state = { today: "2026-10-17", tasks: [] };
  h.ctx.actions.toggleTask(task);
  h.ctx.actions.skipTask(task, true);
  assert.equal(h.calls.length, 1);
  h.fail(); await write;
  assert.equal(h.ctx.pendingTaskWrites.has(task.id), false);
  assert.equal(h.ctx.taskWriteTarget(task), null);
  h.ctx.actions.toggleTask(task);
  assert.equal(h.calls.length, 1);
});

function renderHarness(tasks, time = "16:00") {
  function node(tag) {
    return {
      tag, className: "", children: [], attributes: {}, dataset: {}, style: {}, hidden: false,
      get textContent() { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); },
      set textContent(value) { this.children = [String(value)]; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener() {},
      setAttribute(key, value) {
        this.attributes[key] = String(value);
        if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      },
    };
  }
  const nodes = new Map();
  const ctx = {
    window: { CONFIG: { SCHEDULE: slots, BED: "22:00" } },
    document: { createElement: node, getElementById(id) { if (!nodes.has(id)) nodes.set(id, node("div")); return nodes.get(id); } },
    location: { search: "" }, URLSearchParams, TaskPolicy: policy,
  };
  const hook = `globalThis.renderTest = { renderTasks, setState(value) { state = value; }, setNow(value) { taipeiNow = () => value; }, pendingTaskWrites };`;
  assert.ok(appSource.endsWith("  init();\n})();\n"));
  vm.runInNewContext(appSource.replace("  init();\n})();", `${hook}\n})();`), ctx);
  ctx.renderTest.setState({ today: "2026-10-17", tasks });
  ctx.renderTest.setNow({ date: "2026-10-17", wd: "Sat", min: policy.toMinute(time) });
  ctx.renderTest.renderTasks();
  return { ctx, nodes, rerender: () => ctx.renderTest.renderTasks() };
}
const titleOf = (row) => row.children.find((child) => child?.className === "t task-copy")?.children[0]?.children[0]?.textContent;
const currentRows = (h) => h.nodes.get("tasks").children.filter((row) => row.className.includes("is-current"));

test("整欄 render：當前光效與第一列一致，主欄／跳過欄／計數共用同 ID 去重資料", () => {
  const oldDuplicate = study("current", "舊日同 ID", { date: "2026-10-16", makeup: true, skipped: true, carryover: false });
  const current = study("current", "物理第02堂", { date: "2026-10-17", order: 99 });
  const overdue = study("overdue", "物理第01堂", { date: "2026-10-16", makeup: true, carryover: false, order: 1 });
  const skipped = study("skipped", "今日已跳過", { date: "2026-10-17", skipped: true });
  const h = renderHarness([oldDuplicate, overdue, current, skipped, { ...skipped }]);
  assert.deepEqual(h.nodes.get("tasks").children.map(titleOf), ["02堂", "01堂"]);
  assert.equal(currentRows(h).length, 1);
  assert.equal(currentRows(h)[0], h.nodes.get("tasks").children[0]);
  assert.equal(h.nodes.get("skipped").children.length, 1);
  assert.equal(h.nodes.get("task-count").textContent, "0/2");
  assert.equal(h.nodes.get("completion").textContent, "0/2　0%");
  assert.equal(h.nodes.get("tasks").children[0].children[0].disabled, false);
  h.ctx.renderTest.pendingTaskWrites.add(current.id);
  h.rerender();
  assert.equal(h.nodes.get("tasks").children[0].children[0].disabled, true);
});

for (const [time, dinnerFirst] of [["17:29", false], ["17:30", true], ["18:59", true], ["19:00", false]]) {
  test(`整欄 render 晚餐 ${time}：第一列、光效與睡前事項順序`, () => {
    const old = study("old", "物理第01堂", { date: "2026-10-16", carryover: true, makeup: true, order: 99 });
    const dinner = { id: "dinner", title: "晚餐＋蛋白粉", type: "生活", date: "2026-10-17", done: false, order: 1 };
    const bed = { id: "bed", title: "睡前整理", type: "生活", date: "2026-10-17", done: false, order: 2 };
    const h = renderHarness([bed, old, dinner], time);
    const titles = h.nodes.get("tasks").children.map(titleOf);
    assert.deepEqual(titles, dinnerFirst ? ["晚餐＋蛋白粉", "01堂", "睡前整理"] : ["01堂", "晚餐＋蛋白粉", "睡前整理"]);
    assert.equal(currentRows(h).length, dinnerFirst ? 1 : 0);
    if (dinnerFirst) assert.equal(currentRows(h)[0], h.nodes.get("tasks").children[0]);
  });
}

test("整欄 render：未完成／已略過／缺失前置停用，已完成 blocked 可取消", () => {
  for (const parent of [null, { id: "parent", done: false }, { id: "parent", done: true, skipped: true }]) {
    const child = study("child", "物理第02堂", { date: "2026-10-17", prerequisiteTaskIds: ["parent"] });
    const completed = { ...child, id: "completed", done: true };
    const h = renderHarness([...(parent ? [parent] : []), child, completed]);
    const rows = h.nodes.get("tasks").children;
    const childRow = rows.find((row) => titleOf(row) === "02堂" && !row.className.includes(" done"));
    const completedRow = rows.find((row) => row.className.includes(" done"));
    assert.equal(childRow.children[0].disabled, true);
    assert.equal(completedRow.children[0].disabled, false);
    assert.equal(currentRows(h).length, 0);
  }
});


test("手機 checkbox 命中區僅增加透明範圍，無科目標籤時不拓寬攔截文字", async () => {
  const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
  const marker = "/* Expand only the checkbox hit target; preserve the visible box and row layout. */";
  const start = css.indexOf(marker);
  assert.notEqual(start, -1);
  const block = css.slice(start + marker.length, css.indexOf(".item .task-copy .tag", start));
  assert.match(block, /@media\(max-width:899px\)/);
  assert.match(block, /\.item\.task-item>\.chk::before\{content:"";position:absolute;width:calc\(100% \+ 4px\);height:44px;left:-2px;top:50%;transform:translateY\(-50%\)\}/);
  assert.match(block, /\.item\.task-item>\.chk:has\(\+\.task-subject-suffix\)::before\{width:44px\}/);
  assert.doesNotMatch(block, /margin|padding|display|flex|grid|\.rec|note-card|record|lessons/);
});
