// Notion database config.
// IMPORTANT: with Notion-Version 2022-06-28 the API wants *database* IDs (the id in the
// database page URL), not the collection:// data-source IDs. The IDs below were read from the
// Notion pages' URLs via the Notion connector (page URL id == database id). If any request
// returns "Could not find database", open the DB as a full page in Notion, copy the 32-char id
// from its URL (before "?v="), and replace the value here. Remember to share every DB with the
// integration (… menu > Connections).
export const DB = {
  tasks:   "ada3d6c03da94f65874e7a46d14e81d5",      // 今日任務   (collection e19d5ebd-f986-46e0-b46d-4200224b2c2c)
  records: "32f59a83237642d39afd5442c17dda44",      // 每日紀錄   (collection 0a848c84-e67b-4fe8-a012-183d85c8bf42)
  lessons: "928e62e9a1554995b85e14175a14da44",      // 課程進度 / 我的課程 (collection 382f9f1d-15ef-4f12-ac1f-5198db795613)
  notes:   "b3abf87b39c249a2b0758bc90ebbbee0",      // 筆記       (collection 7f9e2bff-5448-4311-b87b-1f44d09d4854)
  focus:   "5a64541f431649f0b8fa53f6c2b1818c",      // 專注紀錄 (collection b8024dd5-87e0-4215-9f20-dc8cb3fe067a)
  recs:    "81992a3c24d544a0af4dddddc23780d1",      // 推薦任務   (collection fc989b2a-97f9-4a4d-900e-8365b9a10e12) - not used by the API yet
};

// Exact property names (copied from the Notion schemas).
export const P = {
  task: {
    title: "任務",
    done: "　",          // full-width space checkbox
    skip: "»",
    date: "日期",
    order: "順序",
    type: "類型",
    source: "來源",       // 今日 / 推薦 / 備用
    lesson: "對應堂次",
    estimatedMinutes: "預估分鐘",
    difficulty: "難度",
    reward: "獎勵文字",
    record: "每日紀錄",
  },
  record: {
    title: "紀錄",
    date: "日期",
    hours: "小時",
    minutes: "分鐘",
    ypt: "YPT",           // formula, read-only
    review: "心得",
    points: "各科重點",
    workout: "運動紀錄",
    mood: "心情/狀態",
    completion: "今日完成度", // formula, read-only
  },
  lesson: {
    title: "名稱",
    status: "狀態",       // 未開始 / 進行中 / 完成
    doneDate: "完成日",
    order: "排序",
    subject: "科目",
    course: "課程",
    length: "長度(分鐘)",
    weekLabel: "預計週次",
    weekStart: "預計週開始",
    reviews: "複習次數",
    lastReview: "上次複習",
    nextReview: "下次複習", // formula
    due: "該複習",          // formula
  },
  note: {
    title: "標題",
    date: "日期",
    subject: "科目",
    chapter: "章節",
    points: "重點",
    status: "複習狀態",
    lesson: "對應堂次",
  },
};

export const MOODS = ["很好", "不錯", "普通", "疲累", "低落"];
export const SUBJECTS = ["化學", "物理", "生物", "生化", "英文"];
export const STATUS_DONE = "完成";
export const STATUS_TODO = "未開始";
