import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./task-policy.js", import.meta.url), "utf8");
const sandbox = {};
vm.runInNewContext(source, sandbox);
const policy = sandbox.TaskPolicy;
const slots = [
  { start: "08:30", end: "12:00", name: "化學", keys: ["化學"] },
  { start: "15:45", end: "16:30", name: "物理", keys: ["物理"] },
  { start: "17:30", end: "19:00", name: "晚餐＋蛋白粉", keys: ["晚餐", "蛋白粉"] },
  { start: "21:00", end: "22:00", name: "收尾＋甘胺酸鎂", keys: ["睡前", "回顧"] },
];
const isLifeTask = (task) => String(task.type || "") === "生活" || /^(早餐|午餐|晚餐|用餐|步數|肌酸|蛋白粉|重量訓練|重訓|運動|洗澡|睡前|簡單清潔|清潔收尾|收尾|甘胺酸|YPT|填\s*YPT)/i.test(task.title || "");
const isStudyTask = (task) => !isLifeTask(task) && (/預習|初學|複習|週複習|練習/.test(task.type || "") || /第\s*\d+.*堂|練習|錯題|複習|看課|(?:看|觀看|上)影片|影片.*(?:課程|第\s*\d+|堂|單元|觀看)/i.test(task.title || ""));
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

test("週日休息時不滾入補做任務，也不提示當日未完成學習", () => {
  const sundayOptions = options({ weekday: "Sun", nowMin: 10 * 60 });
  const carry = study("carry", "化學複習題", { date: "2026-10-16", makeup: true, carryover: true });
  const planned = study("planned", "物理第02-1堂", { date: "2026-10-18" });
  const life = { id: "walk", title: "散步", type: "生活", order: 1 };
  const view = policy.taskView([carry, planned, life], sundayOptions);
  assert.equal(view.suppression, "rest");
  assert.deepEqual(Array.from(view.tasks, (task) => task.id), ["walk"]);
});

test("前置任務未完成時，後段不會置頂或標成當下提示", () => {
  const blocked = study("blocked", "物理練習題", { carryover: true, makeup: true, date: "2026-10-16", blocked: true, order: 1 });
  const ready = study("ready", "一般複習", { date: "2026-10-17", order: 20 });
  const activeOptions = options({ nowMin: 16 * 60, weekday: "Sat" });
  const sorted = [blocked, ready].sort((a, b) => policy.compareTasks(a, b, activeOptions));
  assert.deepEqual(sorted.map((task) => task.id), ["ready", "blocked"]);
  assert.equal(policy.taskIsCurrent(blocked, { ...activeOptions, activeSlot: slots[1] }), false);
});
