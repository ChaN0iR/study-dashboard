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

test("週日保留生活與每日必做；一般學習與補課仍隱藏，不修改輸入", () => {
  const rows = [row("anki", dailyTitles[0]), row("vocab", "英文單字複習"), row("required", "每日必做｜物理公式回想"),
    row("walk", "飯後散步"), row("ypt", "YPT・步數・心情・重點回顧"), row("meal", "午餐"),
    row("study", "物理第02堂"), row("carry", "化學複習題", { date: "2026-10-17", makeup: true }),
    row("done", "物理第03堂", { done: true })];
  const before = JSON.stringify(rows);
  assert.deepEqual(ids(policy.taskView(rows, options).tasks), ["anki", "vocab", "required", "walk", "ypt", "meal", "done"]);
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

test("Scriptable 休息日整體模型與 dashboard 例外一致，保留既有三餐過濾", () => {
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
