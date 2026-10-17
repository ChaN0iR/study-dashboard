// Offline smoke test: mocks Notion and exercises every endpoint.
import worker from "./index.js";
import { DB } from "./config.js";
import assert from "node:assert/strict";

const calls = [];
const taskId = "11111111-1111-1111-1111-111111111111";
const englishLessonId = "22222222-2222-2222-2222-222222222222";
const lessonPage = (id, title, subject, course, status, weekStart, order) => ({
  id,
  properties: {
    "名稱": { title: [{ plain_text: title }] },
    "狀態": { select: { name: status } },
    "科目": { select: { name: subject } },
    "課程": { select: { name: course } },
    "長度(分鐘)": { number: 45 },
    "預計週次": { rich_text: [] },
    "預計週開始": { date: weekStart ? { start: weekStart } : null },
    "複習次數": { number: 0 },
    "排序": { number: order },
  },
});
const day = (offset) => {
  const d = new Date(Date.now() + 8 * 3600e3 + offset * 86400e3);
  return d.toISOString().slice(0, 10);
};
const task = {
  id: taskId,
  properties: {
    "任務": { title: [{ plain_text: "英文主課第02-1堂" }] },
    "　": { checkbox: true },
    "»": { checkbox: false },
    "來源": { select: { name: "今日" } },
    "順序": { number: 1 },
    "類型": { select: { name: "複習" } },
    "對應堂次": { relation: [{ id: englishLessonId }] },
  },
};
const lessons = [
  lessonPage(englishLessonId, "英文主課第02-1堂", "英文", "英文主課", "未開始", day(0), 1),
  lessonPage("33333333-3333-3333-3333-333333333333", "英文主課第01-1堂", "英文", "英文主課", "完成", day(-10), 2),
  lessonPage("44444444-4444-4444-4444-444444444444", "英文字彙第01-1堂", "英文", "英文字彙", "未開始", day(9), 3),
];
const page = (id = taskId, properties = {}) => ({ id, properties });

globalThis.fetch = async (url, init) => {
  const target = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: target, method: init.method, body });
  if (target.endsWith("/query")) {
    if (target.includes(`/databases/${DB.tasks}/query`)) return Response.json({ results: [task], has_more: false });
    if (target.includes(`/databases/${DB.records}/query`)) return Response.json({ results: [], has_more: false });
    if (target.includes(`/databases/${DB.lessons}/query`)) return Response.json({ results: lessons, has_more: false });
  }
  return Response.json(page());
};

const env = { NOTION_TOKEN: "t", APP_KEY: "k", ALLOWED_ORIGIN: "*" };
const call = (m, p, b, key = "k") => worker.fetch(new Request("https://x" + p, { method: m, headers: { "x-app-key": key, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }), env);
assert.equal((await call("GET", "/api/state", null, "bad")).status, 401);
const st = await (await call("GET", "/api/state")).json();
assert.equal(st.tasks[0].title, "英文主課第02-1堂");
assert.equal(st.tasks[0].done, true);
assert.equal(st.tasks[0].type, "複習");
assert.deepEqual(st.tasks[0].relatedSubjects, ["英文"]);
assert.deepEqual(st.tasks[0].relatedCourses, ["英文主課"]);
assert.equal(st.lessons.length, 1, "only current-window rows are displayed");
const english = st.courseStats.find((x) => x.course === "英文主課");
const vocabulary = st.courseStats.find((x) => x.course === "英文字彙");
assert.deepEqual([english.done, english.total], [1, 2]);
assert.deepEqual([vocabulary.done, vocabulary.total], [0, 1]);
assert.equal(vocabulary.nextUpcoming.weekStart, day(9));

const beforeTaskWrite = calls.length;
assert.equal((await call("POST", `/api/task/${taskId}`, { done: true })).status, 200);
const taskWrites = calls.slice(beforeTaskWrite).filter((c) => c.method === "PATCH");
assert.equal(taskWrites.length, 1);
assert.deepEqual(Object.keys(taskWrites[0].body.properties), ["　"]);
assert.equal(taskWrites.some((c) => c.url.includes(englishLessonId)), false, "task completion does not alter or award XP to a course");
assert.equal((await call("POST", `/api/task/${taskId}`, { skip: true })).status, 200);
assert.equal((await call("POST", `/api/task/${taskId}`, {})).status, 400);
assert.equal((await call("POST", `/api/task/zzz`, { done: true })).status, 400);
assert.equal((await call("POST", `/api/record`, { hours: 1, minutes: 40, "心得": "x", "心情": "普通" })).status, 200);
assert.equal((await call("POST", `/api/record`, { "心情": "bad" })).status, 400);
assert.equal((await call("POST", `/api/lesson/${englishLessonId}`, { done: true })).status, 200);
assert.equal((await call("POST", `/api/lesson/${englishLessonId}`, { review: true })).status, 200);
assert.equal((await call("POST", `/api/note`, { title: "n", subject: "化學" })).status, 200);
assert.equal((await call("POST", `/api/note`, {})).status, 400);
const patch = calls.find((c) => c.method === "PATCH" && c.body.properties["　"]);
assert.deepEqual(patch.body.properties["　"], { checkbox: true });
console.log("worker ok,", calls.length, "mock notion calls");
