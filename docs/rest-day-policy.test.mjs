import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const policySource = await readFile(new URL("./task-policy.js", import.meta.url), "utf8");
const appSource = await readFile(new URL("./app.js", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../scriptable-widget.js", import.meta.url), "utf8");
const context = {};
vm.runInNewContext(policySource, context);
for (const name of ["isLifeTask", "isStudyTask"]) {
  const start = appSource.indexOf(`  function ${name}(`);
  const end = appSource.indexOf("\n  }", start);
  vm.runInNewContext(appSource.slice(start, end + 4), context);
}
vm.runInNewContext(["STUDY_TASK_TYPES", "EXPLICIT_STUDY_TASK", "ADMIN_ONLY_TASK", "ADMIN_OPERATION"]
  .map(name => appSource.split("\n").find(line => line.startsWith(`  const ${name} =`))).join("\n"), context);
const start = widgetSource.indexOf("const WIDGET_STUDY_TASK_TYPES");
const end = widgetSource.indexOf("const today =", start);
vm.runInNewContext(widgetSource.slice(0, widgetSource.indexOf("const KEY_NAME")) + "\n" + widgetSource.slice(start, end), context);
const policy = context.TaskPolicy;
const today = "2026-10-18";
const routineSlot = { start: "07:00", end: "07:45", name: "Anki＋單字", keys: ["anki", "單字"] };
const options = { today, weekday: "Sun", nowMin: 7 * 60 + 15, slots: [routineSlot], bedMinute: 22 * 60,
  isStudyTask: context.isStudyTask, isLifeTask: context.isLifeTask, activeSlot: routineSlot, getSlot: () => routineSlot };
const row = (id, title, props = {}) => ({ id, title, type: "複習", date: today, done: false, skipped: false, ...props });
const ids = rows => Array.from(rows, task => task.id);

const dailyTitles = ["Anki：清完到期卡＋新卡 20 張", "Anki＋單字", "Anki 到期卡", "複習到期卡", "單字：背 20 個", "英文單字複習", "每日單字", "每天 Anki 到期卡", "背單字20個", "每日必做｜物理公式回想", "每天必背：英文片語"];
const ordinaryTitles = ["物理第02堂", "化學複習題", "英文單字課程第03堂", "觀看單字影片", "Anki 設定", "整理 Anki 牌組", "英文文章閱讀練習", "錯題回顧", "每日課程進度", "單字週複習", "Anki 使用教學", "Anki", "Anki 新卡 20 張", "新卡 20 張", "每日必做｜設定單字排程", "單字先修", "單字測驗"];

test("每日必做依任務內容判定，不依完成狀態或提醒卡片", () => {
  for (const title of dailyTitles) for (const done of [false, true]) {
    assert.equal(policy.isDailyRequired(row("daily", title, { done })), true, title);
  }
  for (const title of ordinaryTitles) assert.equal(policy.isDailyRequired(row("ordinary", title)), false, title);
  assert.equal(policy.isDailyRequired(row("lesson", "Anki 單字複習", { relatedLessonIds: ["lesson"] })), false);
  assert.equal(policy.isDailyRequired(row("course", "單字複習", { relatedCourses: ["course"] })), false);
});

test("週日保留生活、每日必做與最近補做課程，不修改輸入", () => {
  const rows = [row("anki", dailyTitles[0]), row("vocab", "英文單字複習"), row("required", "每日必做｜物理公式回想"),
    row("walk", "飯後散步"), row("ypt", "YPT・步數・心情・重點回顧"), row("meal", "午餐"),
    row("study", "物理第02堂"), row("carry", "化學複習題", { date: "2026-10-17", makeup: true }),
    row("done", "物理第03堂", { done: true })];
  const before = JSON.stringify(rows);
  assert.deepEqual(ids(policy.taskView(rows, options).tasks), ["anki", "vocab", "required", "walk", "ypt", "meal", "done", "carry"]);
  // A life classification must win even if another classifier also labels the row study.
  assert.deepEqual(ids(policy.taskView([rows[2], rows[3]], { ...options, isStudyTask: () => true }).tasks), ["required", "walk"]);
  assert.equal(JSON.stringify(rows), before);
});

test("休息日每日必做照常標為當下，完成或 blocked 不強制標示", () => {
  const task = row("anki", dailyTitles[0]);
  assert.equal(policy.taskIsCurrent(task, options), true);
  assert.equal(policy.taskIsCurrent(row("study", "物理第02堂"), options), false);
  for (const props of [{ done: true }, { blocked: true }]) assert.equal(policy.taskIsCurrent({ ...task, ...props }, options), false);
});

test("每日必做例外不改變平日睡前或既有跨日／跳過／去重政策", () => {
  const anki = row("anki", dailyTitles[0]);
  assert.deepEqual(ids(policy.taskView([anki], { ...options, weekday: "Mon", nowMin: 22 * 60 }).tasks), []);
  assert.deepEqual(ids(policy.taskView([anki], { ...options, weekday: "Mon" }).tasks), ["anki"]);
  const rows = [{ ...anki, date: "2026-10-17", done: true, makeup: true }, anki, row("skip", "單字複習", { skipped: true }),
    row("old", "Anki 到期卡", { date: "2026-10-17", makeup: false })];
  const result = policy.taskView(rows, options);
  assert.deepEqual(ids(result.tasks.filter(task => !task.skipped)), ["anki"]);
  assert.deepEqual(ids(result.skipped), ["skip"]);
  assert.equal(result.tasks[0].done, false);
});

test("Scriptable 維持原有休息日模型與三餐過濾，不跟隨 Dashboard 選課例外", () => {
  const rows = [row("anki", dailyTitles[0]), row("vocab", "英文單字複習"), row("walk", "飯後散步"), row("study", "物理第02堂")];
  for (const min of [7 * 60 + 15, 10 * 60, 20 * 60 + 50, 21 * 60 + 10]) {
    const result = context.widgetTaskModel({ today, tasks: rows }, { date: today, wd: "Sun", min });
    assert.deepEqual(new Set(ids(result.tasks)), new Set(["anki", "vocab", "walk"]));
    assert.deepEqual(new Set(ids(result.visibleOpen)), new Set(["anki", "vocab", "walk"]));
    assert.equal(result.total, 3);
    assert.equal(result.done, 0);
  }
  const lunch = context.widgetTaskModel({ today, tasks: rows }, { date: today, wd: "Sun", min: 12 * 60 + 15 });
  assert.deepEqual(ids(lunch.visibleOpen), ["walk"]);
  assert.equal(lunch.total, 3);
});


test("週日沒有補做時保留最近一項未完成課程，完成後接續下一項", () => {
  const first = row("first", "物理第01堂", { order: 1 });
  const next = row("next", "物理第02堂", { order: 2 });
  const rows = [next, first];
  assert.deepEqual(ids(policy.taskView(rows, options).tasks), ["first"]);
  first.done = true;
  assert.deepEqual(ids(policy.taskView(rows, options).tasks), ["next", "first"]);
  next.done = true;
  assert.equal(policy.taskView(rows, options).restCourse, null);
  assert.equal(policy.studyQueue(rows, options).length, 0);
});

test("週日補做依最早日期與課序，排除未來、已跳過與不可補做，不產生新 ID", () => {
  const rows = [row("current", "物理第04堂", { order: 1 }),
    row("recent", "物理第03堂", { date: "2026-10-17", makeup: true, order: 1 }),
    row("old2", "物理第02堂", { date: "2026-10-16", makeup: true, order: 2 }),
    row("old1", "物理第01堂", { date: "2026-10-16", makeup: true, order: 1 }),
    row("future", "物理第05堂", { date: "2026-10-19", order: 0 }),
    row("skip", "化學第01堂", { skipped: true, date: "2026-10-15", makeup: true }),
    row("not-makeup", "化學第02堂", { date: "2026-10-14", makeup: false })];
  const before = JSON.stringify(rows);
  assert.deepEqual(ids(policy.studyQueue(rows, options)), ["old1", "old2", "recent", "current"]);
  assert.equal(policy.taskView(rows, options).restCourse.id, "old1");
  assert.equal(JSON.stringify(rows), before);
});

test("補做前置未完成時先提供可做課程；只有 blocked 時仍保留真實任務且不解除 blocked", () => {
  const blocked = row("blocked", "化學第01堂", { date: "2026-10-17", makeup: true, blocked: true });
  const ready = row("ready", "物理第01堂", { order: 50 });
  assert.equal(policy.taskView([blocked, ready], options).restCourse.id, "ready");
  const result = policy.taskView([blocked], options);
  assert.equal(result.restCourse.id, "blocked");
  assert.equal(result.tasks[0].blocked, true);
  assert.equal(policy.taskIsCurrent(result.tasks[0], options), false);
  assert.equal(policy.taskView([blocked, ready], { ...options, isBlocked: task => task.id === "ready" }).restCourse.id, "blocked");
});

test("週日睡前邊界仍隱藏一般課程，生活與每日必做照舊", () => {
  const slots = [...options.slots, { start: "21:00", end: "22:00", name: "睡前收尾" }];
  const rows = [row("study", "物理第01堂"), row("walk", "飯後散步"), row("anki", dailyTitles[0])];
  assert.equal(policy.taskView(rows, { ...options, slots, nowMin: 20 * 60 + 59 }).restCourse.id, "study");
  for (const nowMin of [21 * 60, 22 * 60]) {
    const result = policy.taskView(rows, { ...options, slots, nowMin });
    assert.equal(result.restCourse, null);
    assert.deepEqual(ids(result.tasks), ["walk", "anki"]);
  }
});

test("週日同 ID 仍選今天原筆，不用過期副本的補做或前置狀態", () => {
  const current = row("same", "物理第02堂", { order: 2 });
  const duplicate = { ...current, title: "物理第01堂", date: "2026-10-17", carryover: true, makeup: true, blocked: true };
  for (const rows of [[current, duplicate], [duplicate, current]]) {
    const view = policy.taskView(rows, options);
    assert.equal(view.tasks.length, 1);
    assert.equal(view.restCourse.title, current.title);
    assert.equal(view.restCourse.carryover, false);
    assert.equal(view.tasks[0].date, today);
  }
});
