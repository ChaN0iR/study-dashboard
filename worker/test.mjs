import { readLimitedText, BodyTooLarge } from "./request-body.js";
// Offline smoke test: mocks Notion and exercises every endpoint.
import worker from "./index.js";
import { DB, P } from "./config.js";
import assert from "node:assert/strict";
import { makeNamespace } from "./test-fixtures.mjs";

const calls = [];
const taskId = "11111111-1111-1111-1111-111111111111";
const englishLessonId = "22222222-2222-2222-2222-222222222222";
const dependentTaskId = "33333333-3333-3333-3333-333333333334";
const blockedPrerequisiteId = "55555555-5555-5555-5555-555555555555";
const donePrerequisiteId = "66666666-6666-6666-6666-666666666666";
const skippedPrerequisiteId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const physicsBackId = "77777777-7777-7777-7777-777777777777";
const physicsReadyId = "88888888-8888-8888-8888-888888888888";
const oldDoneId = "99999999-9999-9999-9999-999999999999";
const oldSkippedId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const oldUnmarkedId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const oldLifeId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const day = (offset) => {
  const d = new Date(Date.now() + 8 * 3600e3 + offset * 86400e3);
  return d.toISOString().slice(0, 10);
};
const taskPage = (id, title, { date = day(0), done = false, skipped = false, makeup = false, order = 1, prerequisites = [], lessonIds = [], scheduledTime, recallRoom } = {}) => ({
  id,
  properties: {
    "任務": { title: [{ plain_text: title }] },
    "　": { checkbox: done },
    "»": { checkbox: skipped },
    "來源": { select: { name: "今日" } },
    "日期": { date: { start: date } },
    "順序": { number: order },
    "類型": { select: { name: "複習" } },
    "預估分鐘": { number: 25 },
    "難度": { select: { name: "標準" } },
    "對應堂次": { relation: lessonIds.map((id) => ({ id })) },
    "可補做": { checkbox: makeup },
    "前置任務": { relation: prerequisites.map((id) => ({ id })) },
    ...(scheduledTime !== undefined ? { "排定時段": { rich_text: scheduledTime === "" ? [] : [{ plain_text: scheduledTime }] } } : {}),
    ...(recallRoom !== undefined ? { "回想室": { checkbox: recallRoom } } : {}),
  },
});
const task = taskPage(taskId, "英文主課第02-1堂", {
  lessonIds: [englishLessonId], scheduledTime: " 08:00-09:30 / 跨段 raw ", recallRoom: true,
});
const carryoverRows = [
  taskPage(physicsBackId, "物理先修後段練習題", { date: day(-1), makeup: true, prerequisites: [blockedPrerequisiteId], order: 1 }),
  taskPage(physicsReadyId, "物理先修另一題練習", { date: day(-2), makeup: true, prerequisites: [donePrerequisiteId], order: 2, scheduledTime: "" }),
  taskPage(oldDoneId, "已完成舊課程第01堂", { date: day(-1), makeup: true, done: true, order: 3 }),
  taskPage(oldSkippedId, "已跳過舊課程第02堂", { date: day(-1), makeup: true, skipped: true, order: 4 }),
  taskPage(oldUnmarkedId, "未標可補做課程第03堂", { date: day(-1), makeup: false, order: 5 }),
  taskPage(oldLifeId, "重量訓練＋洗澡", { date: day(-1), makeup: true, order: 6, scheduledTime: "非法/跨段 raw", recallRoom: false }),
];
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
const lessons = [
  lessonPage(englishLessonId, "英文主課第02-1堂", "英文", "英文主課", "未開始", day(0), 1),
  lessonPage("33333333-3333-3333-3333-333333333333", "英文主課第01-1堂", "英文", "英文主課", "完成", day(-10), 2),
  lessonPage("44444444-4444-4444-4444-444444444444", "英文字彙第01-1堂", "英文", "英文字彙", "未開始", day(9), 3),
];
const prerequisitePage = (id, done) => taskPage(id, "物理前段任務", { date: day(-1), done });
const genericPage = (id = taskId, properties = {}) => ({ id, properties });
const mockPages = new Map([
  [taskId, task],
  [dependentTaskId, taskPage(dependentTaskId, "依賴任務", { prerequisites: [blockedPrerequisiteId, skippedPrerequisiteId] })],
  [blockedPrerequisiteId, prerequisitePage(blockedPrerequisiteId, false)],
  [skippedPrerequisiteId, taskPage(skippedPrerequisiteId, "已略過前置", { date: day(-1), skipped: true })],
]);

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: target, method: init.method || "GET", body });
  if (target.endsWith("/query")) {
    if (target.includes(`/databases/${DB.tasks}/query`)) {
      const isCarryoverQuery = Array.isArray(body?.filter?.and);
      return Response.json({ results: isCarryoverQuery ? carryoverRows : [task], has_more: false });
    }
    if (target.includes(`/databases/${DB.records}/query`)) return Response.json({ results: [], has_more: false });
    if (target.includes(`/databases/${DB.lessons}/query`)) return Response.json({ results: lessons, has_more: false });
  }
  const pageMatch = target.match(/\/pages\/([^/]+)$/);
  if (pageMatch) {
    const id = pageMatch[1];
    const page = mockPages.get(id) || (id === donePrerequisiteId ? prerequisitePage(id, true) : genericPage(id));
    if (init.method === "PATCH") {
      page.properties = { ...page.properties, ...body.properties };
      mockPages.set(id, page);
    }
    return Response.json(page);
  }
  return Response.json(genericPage());
};

const env = { NOTION_TOKEN: "t", APP_KEY: "k", ALLOWED_ORIGIN: "*" };
Object.assign(env, { LESSON_AUTOMATION: makeNamespace(env).binding });
const call = (m, p, b, key = "k") => worker.fetch(new Request("https://x" + p, {
  method: m, headers: { "x-app-key": key, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined,
}), env);
assert.equal((await call("GET", "/api/state", null, "bad")).status, 401);
const stateCallStart = calls.length;
const st = await (await call("GET", "/api/state")).json();
assert.equal(st.tasks[0].title, "英文主課第02-1堂");
assert.equal(st.tasks[0].done, false);
assert.equal(st.tasks[0].type, "複習");
assert.equal(st.tasks[0].estimatedMinutes, 25);
assert.equal(st.tasks[0].difficulty, "標準");
assert.equal(st.tasks[0].scheduledTime, " 08:00-09:30 / 跨段 raw ", "valid and cross-segment raw is preserved");
assert.equal(st.tasks[0].recallRoom, true);
assert.deepEqual(st.tasks[0].relatedSubjects, ["英文"]);
assert.deepEqual(st.tasks[0].relatedCourses, ["英文主課"]);
assert.equal(st.lessons.length, 1, "only current-window rows are displayed");
const carry = st.tasks.find((item) => item.id === physicsBackId);
assert.equal(carry.carryover, true);
assert.equal(carry.date, day(-1), "carryover keeps its original date");
assert.equal(carry.makeup, true);
assert.equal(carry.scheduledTime, "", "missing scheduled time defaults to empty string");
assert.equal(carry.recallRoom, false, "missing recall room defaults to false");
assert.equal(carry.blocked, true, "unfinished prerequisite blocks the downstream task");
assert.deepEqual(carry.prerequisiteTaskIds, [blockedPrerequisiteId]);
const ready = st.tasks.find((item) => item.id === physicsReadyId);
assert.equal(ready.blocked, false, "completed prerequisite does not block the task");
assert.equal(ready.scheduledTime, "", "blank scheduled time remains empty");
const life = st.tasks.find((item) => item.id === oldLifeId);
assert.equal(life.scheduledTime, "非法/跨段 raw", "invalid/cross-segment raw is not normalized");
assert.equal(life.recallRoom, false);
assert.equal(st.tasks.some((item) => [oldDoneId, oldSkippedId, oldUnmarkedId].includes(item.id)), false,
  "done, skipped, and unmarked historical tasks are not returned");
assert.equal(st.tasks.filter((item) => item.id === oldLifeId).length, 1,
  "life-task classification is left to the frontend policy");
const stateCalls = calls.slice(stateCallStart);
const oldTaskQuery = stateCalls.find((entry) => entry.url.includes(`/databases/${DB.tasks}/query`) && Array.isArray(entry.body?.filter?.and));
assert.ok(oldTaskQuery, "queries old tasks only through the makeup/date filter");
assert.deepEqual(oldTaskQuery.body.filter.and, [
  { property: "日期", date: { before: st.today } },
  { property: "可補做", checkbox: { equals: true } },
]);
assert.equal(stateCalls.some((entry) => entry.method === "PATCH" || entry.method === "POST" && !entry.url.endsWith("/query")), false,
  "loading task state must not write to Notion");
const english = st.courseStats.find((x) => x.course === "英文主課");
const vocabulary = st.courseStats.find((x) => x.course === "英文字彙");
assert.deepEqual([english.done, english.total], [1, 2]);
assert.deepEqual([vocabulary.done, vocabulary.total], [0, 1]);
assert.equal(vocabulary.nextUpcoming.weekStart, day(9));

// Completion today is independent of the original scheduled week.
const originalLessonCount = lessons.length;
const extraLessons = [
  ["old-week-today", "完成", day(-30), day(0)],
  ["unscheduled-today", "完成", null, day(0)],
  ["future-week-today", "完成", day(9), day(0)],
  ["historical", "完成", day(-30), day(-1)],
  ["missing-date", "完成", day(-30), null],
].map(([id, status, weekStart, doneDate], i) => {
  const page = lessonPage(id, id, "英文", "英文主課", status, weekStart, i + 10);
  page.properties[P.lesson.doneDate] = { date: doneDate ? { start: doneDate } : null };
  return page;
});
lessons.push(...extraLessons);
const beforeTodayCompletionRead = calls.length;
const todayCompletions = await (await call("GET", "/api/state")).json();
assert.deepEqual(todayCompletions.lessons.map((l) => l.id), [englishLessonId, "old-week-today", "unscheduled-today", "future-week-today"]);
assert.equal(todayCompletions.lessons.find((l) => l.id === "old-week-today").doneDate, day(0));
const fullEnglish = todayCompletions.courseStats.find((g) => g.course === "英文主課");
assert.deepEqual([fullEnglish.done, fullEnglish.total], [6, 7], "hidden historical completions still count toward full progress");
assert.equal(calls.slice(beforeTodayCompletionRead).some((c) => c.method === "PATCH" || c.method === "POST" && !c.url.endsWith("/query")), false,
  "showing today's completions performs no data writes");
lessons.splice(originalLessonCount);

const beforeTaskWrite = calls.length;
const updatedTaskResponse = await call("POST", `/api/task/${taskId}`, { done: true });
assert.equal(updatedTaskResponse.status, 200);
const updatedTask = await updatedTaskResponse.json();
assert.equal(updatedTask.scheduledTime, " 08:00-09:30 / 跨段 raw ", "update response includes raw scheduled time");
assert.equal(updatedTask.recallRoom, true, "update response includes recall room");
const taskWrites = calls.slice(beforeTaskWrite).filter((c) => c.method === "PATCH");
assert.equal(taskWrites.length, 1);
assert.deepEqual(Object.keys(taskWrites[0].body.properties), ["　"]);
assert.equal(taskWrites.some((c) => c.url.includes(englishLessonId)), false, "task completion does not alter or award XP to a course");
const skippedTaskResponse = await call("POST", `/api/task/${taskId}`, { skip: true });
assert.equal(skippedTaskResponse.status, 200);
const skippedTask = await skippedTaskResponse.json();
assert.equal(skippedTask.scheduledTime, " 08:00-09:30 / 跨段 raw ");
assert.equal(skippedTask.recallRoom, true, "recall room does not alter skip semantics");
assert.equal((await call("POST", `/api/task/${taskId}`, {})).status, 400);
assert.equal((await call("POST", `/api/task/zzz`, { done: true })).status, 400);
assert.equal((await call("POST", `/api/task/${dependentTaskId}`, { done: false })).status, 200,
  "cancelling completion is allowed while prerequisites are blocked");
let dependentWritesBefore = calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/pages/${dependentTaskId}`)).length;
let rejected = await call("POST", `/api/task/${dependentTaskId}`, { done: true });
assert.equal(rejected.status, 409, "unfinished and skipped prerequisites block completion");
assert.deepEqual(await rejected.json(), { error: "prerequisites incomplete" });
assert.equal(calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/pages/${dependentTaskId}`)).length, dependentWritesBefore,
  "rejected completion performs zero writes");
assert.equal((await call("POST", `/api/task/${blockedPrerequisiteId}`, { done: true })).status, 200);
dependentWritesBefore = calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/pages/${dependentTaskId}`)).length;
rejected = await call("POST", `/api/task/${dependentTaskId}`, { done: true });
assert.equal(rejected.status, 409, "a skipped prerequisite still blocks completion");
assert.equal(calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/pages/${dependentTaskId}`)).length, dependentWritesBefore,
  "skipped prerequisite rejection performs zero writes");
assert.equal((await call("POST", `/api/task/${skippedPrerequisiteId}`, { done: true, skip: false })).status, 200);
assert.equal((await call("POST", `/api/task/${dependentTaskId}`, { done: true })).status, 200,
  "completion is allowed after every prerequisite is done and unskipped");
assert.equal(calls.filter((c) => c.method === "PATCH" && c.url.endsWith(`/pages/${dependentTaskId}`)).length,
  dependentWritesBefore + 1, "allowed completion writes exactly once");
assert.equal((await call("POST", `/api/record`, { hours: 1, minutes: 40, "心得": "x", "心情": "普通" })).status, 200);
assert.equal((await call("POST", `/api/record`, { "心情": "bad" })).status, 400);
assert.equal((await call("POST", `/api/lesson/${englishLessonId}`, { done: true })).status, 200);
assert.equal((await call("POST", `/api/lesson/${englishLessonId}`, { review: true })).status, 200);
assert.equal((await call("POST", `/api/note`, { title: "n", subject: "化學" })).status, 200);
assert.equal((await call("POST", `/api/note`, {})).status, 400);
const patch = calls.find((c) => c.method === "PATCH" && c.body?.properties?.["　"]);
assert.deepEqual(patch.body.properties["　"], { checkbox: true });

// The same shaper must preserve new fields in today's rows, carryover rows and
// mutation responses, without admitting either field into the write whitelist.
const carryPage = carryoverRows.find((page) => page.id === physicsReadyId);
for (const scheduledTime of [undefined, "", " \t ", "15:45–16:30", "11:00–14:00", "not a time"]) {
  for (const recallRoom of [false, true]) {
    for (const page of [task, carryPage]) {
      delete page.properties[P.task.scheduledTime];
      if (scheduledTime !== undefined) page.properties[P.task.scheduledTime] = {
        rich_text: scheduledTime ? [{ plain_text: scheduledTime.slice(0, 5) }, { plain_text: scheduledTime.slice(5) }] : [],
      };
      page.properties[P.task.recallRoom] = { checkbox: recallRoom };
    }
    const state = await (await call("GET", "/api/state")).json();
    for (const id of [taskId, physicsReadyId]) {
      const shaped = state.tasks.find((row) => row.id === id);
      assert.ok(shaped, "new fields never remove a today/carryover task");
      assert.equal(shaped.scheduledTime, scheduledTime ?? "");
      assert.equal(shaped.recallRoom, recallRoom);
      assert.equal(shaped.type, "複習");
      assert.equal(shaped.blocked, false);
      assert.equal(shaped.carryover, id === physicsReadyId);
    }
    const writeStart = calls.length;
    const updated = await (await call("POST", `/api/task/${taskId}`, {
      done: false, skip: false, scheduledTime: "ignored", recallRoom: !recallRoom,
    })).json();
    assert.equal(updated.scheduledTime, scheduledTime ?? "");
    assert.equal(updated.recallRoom, recallRoom);
    assert.equal(updated.done, false);
    assert.equal(updated.skipped, false);
    assert.deepEqual(calls.slice(writeStart).filter((entry) => entry.method === "PATCH").map((entry) => entry.body.properties),
      [{ [P.task.done]: { checkbox: false }, [P.task.skip]: { checkbox: false } }]);
  }
}
const prerequisite = mockPages.get(blockedPrerequisiteId);
prerequisite.properties[P.task.done] = { checkbox: false };
for (const recallRoom of [false, true]) {
  mockPages.get(dependentTaskId).properties[P.task.recallRoom] = { checkbox: recallRoom };
  const before = calls.filter((entry) => entry.method === "PATCH").length;
  assert.equal((await call("POST", `/api/task/${dependentTaskId}`, { done: true })).status, 409,
    "recallRoom never bypasses prerequisites");
  assert.equal(calls.filter((entry) => entry.method === "PATCH").length, before);
}
// API boundary regression: rejected JSON must never reach Notion or Durable Objects.
const sendRawNote = (body, headers = {}) => worker.fetch(new Request("https://x/api/note", {
  method: "POST",
  headers: { "x-app-key": "k", "content-type": "application/json", ...headers },
  body,
  ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
}), env);
for (const raw of ["{", "null", "[]", "true", "3", '"string"']) {
  const before = calls.length;
  const response = await sendRawNote(raw);
  assert.equal(response.status, 400, "malformed/non-object JSON is rejected");
  assert.deepEqual(await response.json(), { error: "invalid JSON" });
  assert.equal(calls.length, before, "invalid JSON cannot write to Notion");
}
const beforeLimit = calls.length;
const announcedLarge = await sendRawNote("{}", { "content-length": "12000001" });
assert.equal(announcedLarge.status, 413, "over-limit Content-Length rejected");
assert.deepEqual(await announcedLarge.json(), { error: "request too large" });
assert.equal(calls.length, beforeLimit, "rejected declared size never reaches Notion");

let oversizedCanceled = false;
const oversizedStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array(6_000_000));
    controller.enqueue(new Uint8Array(6_000_001));
  },
  cancel() { oversizedCanceled = true; },
});
const streamedLarge = await sendRawNote(oversizedStream, { "content-length": "1" });
assert.equal(streamedLarge.status, 413, "actual stream size is authoritative");
assert.deepEqual(await streamedLarge.json(), { error: "request too large" });
assert.equal(oversizedCanceled, true, "oversized stream must be canceled");
assert.equal(calls.length, beforeLimit, "oversized body performs zero Notion calls");
assert.equal(await readLimitedText(new Request("https://x", { method: "POST", body: "中" }), 3), "中",
  "limit is UTF-8 bytes, not JS string length");
await assert.rejects(readLimitedText(new Request("https://x", { method: "POST", body: "中" }), 2), BodyTooLarge);
const utf8 = new TextEncoder().encode("中");
const splitUtf8 = new ReadableStream({
  start(controller) {
    controller.enqueue(utf8.slice(0, 1));
    controller.enqueue(utf8.slice(1));
    controller.close();
  },
});
assert.equal(await readLimitedText(new Request("https://x", { method: "POST", body: splitUtf8, duplex: "half" }), 3), "中",
  "incremental decoding must preserve split UTF-8 characters");

// Private upstream messages must never escape in 5xx responses.
const privateDiagnostic = "private-notion-token-and-account-marker";
const baselineMockFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => Response.json({ message: privateDiagnostic }, { status: 400 });
  const upstreamFailure = await call("GET", "/api/state");
  assert.equal(upstreamFailure.status, 502);
  assert.match(upstreamFailure.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await upstreamFailure.json(), { error: "internal server error" });

  globalThis.fetch = async () => { throw new Error(privateDiagnostic); };
  const networkFailure = await call("GET", "/api/state");
  assert.equal(networkFailure.status, 500);
  assert.deepEqual(await networkFailure.json(), { error: "internal server error" });

  const failedDurableEnv = { ...env, LESSON_AUTOMATION: {
    idFromName() { throw new Error(privateDiagnostic); },
  } };
  const durableFailure = await worker.fetch(new Request("https://x/api/reschedule", {
    headers: { "x-app-key": env.APP_KEY },
  }), failedDurableEnv);
  assert.equal(durableFailure.status, 500);
  assert.deepEqual(await durableFailure.json(), { error: "internal server error" });
} finally {
  globalThis.fetch = baselineMockFetch;
}
const expectedClientError = await call("GET", "/api/state", null, "wrong-key");
assert.equal(expectedClientError.status, 401);
assert.deepEqual(await expectedClientError.json(), { error: "bad app key" },
  "safe validation errors must remain actionable");

console.log("worker ok,", calls.length, "mock notion calls");

globalThis.fetch = nativeFetch;
