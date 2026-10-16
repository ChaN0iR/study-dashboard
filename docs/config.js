// Frontend config. No secrets here.
window.CONFIG = {
  EXAM_DATE: "2027-03-20",
  // 追溯已上過的堂數（系列名稱: 堂數）
  BASE_DONE: {},
  // 2026-10-15 從 Notion 我的課程取得的已完成堂（等級累計起點）
  DONE_TITLES: {"普化先修": ["普化先修 第01-1堂", "普化先修 第01-2堂"], "物理先修": ["物理先修 第01-1堂"], "生化先修": ["生化先修 第01-1堂(06/10)"], "生物學": ["生物學 第01-1堂", "生物學 第01-2堂", "生物學 第02-1堂", "生物學 第02-2堂", "生物學 第03-1堂", "生物學 第03-2堂", "生物學 第04-1堂", "生物學 第04-2堂"], "英文主課": ["英文主課 第01-1堂", "英文主課 第01-2堂"]},
  // URL of the deployed Cloudflare Worker, e.g. "https://study-dashboard-api.<subdomain>.workers.dev"
  // PLACEHOLDER: fill in after `wrangler deploy` (or open the app once with ?api=<url> to store it).
  API_BASE: "https://study-dashboard-api.tw-ching.workers.dev",

  MOODS: ["很好", "普通", "低落"],
  SUBJECTS: ["化學", "物理", "生物", "生化", "英文"],

  // Fixed daily timetable (Asia/Taipei). start/end are "HH:MM". `keys` match task titles (case-insensitive).
  SCHEDULE: [
    { start: "07:00", end: "07:45", name: "Anki＋單字", keys: ["anki", "單字", "生字"] },
    { start: "07:45", end: "08:30", name: "早餐整理", keys: ["早餐"] },
    { start: "08:30", end: "12:00", name: "化學", keys: ["化學", "普化", "有機"] },
    { start: "12:00", end: "13:30", name: "午餐", keys: ["午餐"] },
    { start: "13:30", end: "15:30", name: "生物／生化", keys: ["生物", "生化"] },
    { start: "15:30", end: "15:45", name: "肌酸", keys: ["肌酸"] },
    { start: "15:45", end: "16:30", name: "物理", keys: ["物理"] },
    { start: "16:30", end: "17:30", name: "重量訓練＋洗澡", keys: ["重量訓練", "健身", "重訓", "洗澡"] },
    { start: "17:30", end: "19:00", name: "晚餐＋蛋白粉", keys: ["晚餐", "蛋白粉"] },
    { start: "19:00", end: "20:00", name: "英文文章＋錯題", keys: ["英文", "錯題"] },
    { start: "20:00", end: "20:30", name: "洗澡／簡單清潔", keys: ["洗澡"] },
    { start: "20:30", end: "20:45", name: "錯題", keys: ["錯題"] },
    { start: "20:45", end: "21:00", name: "YPT・步數・心情・重點回顧", keys: ["ypt", "心情", "重點", "步數"] },
    { start: "21:00", end: "22:00", name: "收尾＋甘胺酸鎂", keys: ["收尾", "甘胺酸", "睡前", "回顧"] },
  ],
  WAKE: "07:00",
  BED: "22:00",
};
