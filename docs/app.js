(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const DEMO = qs.get("demo") === "1";
  if (DEMO) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return Promise.reject(new Error("DEMO_NETWORK_BLOCKED"));
      return nativeFetch(input, init);
    };
  }
  if (qs.get("api")) localStorage.setItem("apiBase", qs.get("api"));
  const apiBase = () => (localStorage.getItem("apiBase") || C.API_BASE || "").replace(/\/+$/, "");

  let state = { tasks: [], lessons: [], record: null, today: "" };
  let mood = null;
  let xpVerified = false;

  // ---------- helpers ----------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k);
    return n;
  }
  const ankiCall = (action, params) => fetch("http://127.0.0.1:8765", { method: "POST", body: JSON.stringify({ action, version: 6, params: params || {} }) })
    .then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error); return j.result; });
  function ankiBadge() {
    if (DEMO || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "")) return;
    ankiCall("findCards", { query: "is:due" }).then((ids) => {
      const a = $("anki-link"); let b = a.querySelector(".badge");
      if (!b) { b = document.createElement("span"); b.className = "badge"; a.append(b); }
      b.textContent = ids.length > 99 ? "99+" : ids.length; b.hidden = !ids.length;
    }).catch(() => {});
  }
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400);
  }
  const fmtYpt = (h, m) => {
    const total = Math.round((Number(h) || 0) * 60 + (Number(m) || 0));
    return `${Math.floor(total / 60)}時${String(total % 60).padStart(2, "0")}分`;
  };
  function taipeiNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Taipei", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const h = Number(p.hour) % 24;
    return { date: `${p.year}-${p.month}-${p.day}`, min: h * 60 + Number(p.minute), wd: p.weekday };
  }
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  // ---------- API (real or demo) ----------
  let demoDb = null;
  function demoInit() {
    const d = taipeiNow().date;
    const now = Date.now();
    demoDb = {
      today: d,
      tasks: [
        { id: "t1", title: "Anki：清完到期卡＋新卡 20 張", done: true, skipped: false, source: "今日", order: 1 },
        { id: "t2", title: "普化先修 第02-1堂＋講義練習題", done: false, skipped: false, source: "今日", order: 2 },
        { id: "t3", title: "生化先修 第01-2堂", done: false, skipped: false, source: "今日", order: 3 },
        { id: "t4", title: "複習物理先修 第01-1堂（約 45 分）", done: false, skipped: false, source: "今日", order: 4 },
        { id: "t5", title: "重量訓練＋洗澡", done: false, skipped: false, source: "今日", order: 5 },
        { id: "t6", title: "英文主課 第02-1堂 前半", done: false, skipped: false, source: "推薦", order: 6 },
        { id: "t7", title: "錯題回顧：普化先修 第01堂", done: false, skipped: false, source: "今日", order: 7 },
        { id: "t8", title: "填 YPT 小時／分鐘＋心得＋重點", done: false, skipped: false, source: "今日", order: 8 },
        { id: "t9", title: "生物學 第05-1堂", done: false, skipped: true, source: "備用", order: 9 },
      ],
      record: { id: "r1", hours: 1, minutes: 40, ypt: "1h40m", review: "示範資料：早上順，下午亂。", points: "化學：週期表", mood: "普通", completion: null },
      lessons: [
        { id: "l1", title: "普化先修 第01-1堂", done: true, status: "完成", subject: "化學", minutes: 80, week: "W01 10/14–10/18", reviews: 1, order: 1 },
        { id: "l2", title: "普化先修 第02-1堂", done: false, status: "未開始", subject: "化學", minutes: 82, week: "W01 10/14–10/18", reviews: 0, order: 2 },
        { id: "l3", title: "生化先修 第01-2堂", done: false, status: "未開始", subject: "生化", minutes: 82, week: "W01 10/14–10/18", reviews: 0, order: 3 },
        { id: "l4", title: "物理先修 第01-1堂", done: true, status: "完成", subject: "物理", minutes: 45, week: "W01 10/14–10/18", reviews: 0, order: 4 },
      ],
      focus: {
        now, today: d, active: null, todayDoneSec: 6000,
        sessions: [
          { id: "demo-focus-chem", status: "完成", start: now - 7200000, end: now - 3600000, acc: 3600, subject: "化學", date: d },
          { id: "demo-focus-eng", status: "完成", start: now - 3000000, end: now - 600000, acc: 2400, subject: "英文", date: d },
        ],
        history: [], days: [{ date: d, sec: 6000, count: 2 }],
      },
    };
  }
  async function api(path, body) {
    if (DEMO) {
      if (!demoDb) demoInit();
      await new Promise((r) => setTimeout(r, 120));
      const [, , kind, id] = path.split("/");
      const db = demoDb;
      if (kind === "focus") {
        const f = db.focus, at = Date.now();
        const complete = () => {
          const a = f.active;
          if (!a) return;
          const acc = Math.max(0, a.acc + (a.status === "進行中" && a.start ? Math.round((at - a.start) / 1000) : 0));
          const done = { ...a, acc, end: at, status: "完成" };
          f.sessions.push(done); f.history.unshift(done); f.todayDoneSec += acc; f.active = null; f.now = at;
          const day = f.days.find((x) => x.date === f.today);
          if (day) { day.sec += acc; day.count++; }
        };
        if (!body) { f.now = at; return structuredClone(f); }
        if (body.action === "start" || body.action === "switch") {
          if (body.action === "switch") complete();
          if (!f.active) f.active = { id: `demo-focus-${at}`, status: "進行中", start: at, acc: 0, subject: body.subject || null, date: f.today };
        } else if (body.action === "stop") complete();
        else if (body.action === "pause" && f.active?.status === "進行中") {
          f.active = { ...f.active, acc: f.active.acc + Math.max(0, Math.round((at - f.active.start) / 1000)), start: null, status: "暫停" };
        } else if (body.action === "resume" && f.active?.status === "暫停") {
          f.active = { ...f.active, start: at, status: "進行中" };
        } else if (body.action !== "start" && body.action !== "switch") {
          throw new Error(`DEMO_API_UNSUPPORTED:${path}:${body.action}`);
        }
        f.now = at;
        return structuredClone(f);
      }
      if (kind === "state") return structuredClone(db);
      if (kind === "task") { const t = db.tasks.find((x) => x.id === id); if ("done" in body) t.done = body.done; if ("skip" in body) t.skipped = body.skip; return t; }
      if (kind === "lesson") { const l = db.lessons.find((x) => x.id === id); if ("done" in body) { l.done = body.done; l.status = body.done ? "完成" : "未開始"; } if (body.review) l.reviews++; return l; }
      if (kind === "record") {
        const r = db.record || (db.record = { id: "r1" });
        if ("hours" in body) r.hours = body.hours; if ("minutes" in body) r.minutes = body.minutes;
        if ("心得" in body) r.review = body["心得"]; if ("運動" in body) r.workout = body["運動"]; if ("重點" in body) r.points = body["重點"]; if ("心情" in body) r.mood = body["心情"];
        r.ypt = fmtYpt(r.hours, r.minutes); return r;
      }
      if (kind === "note") return { id: "n1", title: body.title };
      throw new Error(`DEMO_API_UNSUPPORTED:${path}`);
    }
    const base = apiBase();
    if (!base) throw new Error("NO_API");
    let key = localStorage.getItem("appKey");
    if (!key) { key = prompt("請輸入 APP_KEY（只需輸入一次）"); if (!key) throw new Error("NO_KEY"); localStorage.setItem("appKey", key); }
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { "x-app-key": key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { localStorage.removeItem("appKey"); throw new Error("APP_KEY 錯誤，請重新輸入"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- render ----------
  function renderNow() {
    const now = taipeiNow();
    const box = $("now"); box.replaceChildren();
    const rest = ["日", "四"].some((d) => String(now.wd || "").includes(d)) || [0, 4].includes(now.dow);
    const slots = rest ? C.SCHEDULE.map((x) => x.name === "重量訓練＋洗澡" ? { ...x, name: "輕度運動", keys: ["運動", "步數", "散步"] } : x) : C.SCHEDULE;
    const idx = slots.findIndex((s) => now.min >= toMin(s.start) && now.min < toMin(s.end));
    box.append(el("h2", {}, "現在"));
    let slot = null, title, meta;
    if (idx >= 0) {
      slot = slots[idx];
      const left = toMin(slot.end) - now.min;
      title = slot.name;
      meta = `${slot.start}–${slot.end}　剩 ${left} 分鐘`;
      const pct = ((now.min - toMin(slot.start)) / (toMin(slot.end) - toMin(slot.start))) * 100;
      box.append(el("div", { class: "now-name" }, title), el("div", { class: "now-meta" }, meta),
        el("div", { class: "bar" }, el("i", { style: `width:${pct.toFixed(0)}%` })));
      const nx = slots[idx + 1];
      box.append(el("div", { class: "now-meta" }, nx ? `下一段　${nx.start} ${nx.name}` : `${C.BED} 上床`));
    } else {
      const next = slots.find((s) => toMin(s.start) > now.min);
      const late = now.min >= toMin(C.BED) || now.min < toMin(C.WAKE);
      box.append(el("div", { class: "now-name" }, late ? "休息／睡覺" : "空檔"),
        el("div", { class: "now-meta" }, next ? `下一段　${next.start} ${next.name}` : `${C.WAKE} 起床`));
    }
    if (slot?.tips?.length) box.append(el("ul", { class: "list" }, slot.tips.map((x) => el("li", { class: "item" }, el("div", { class: "t" }, x)))));
  }

  const shortTitle = (s) => String(s || "").replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, "").replace(/[（(][^）)]*[）)]/g, "").replace(/｜.*$/, "").replace(/\s+/g, " ").trim();
  const TASK_TAG_STYLES = { "預習": "tag-prestudy", "初學": "tag-learn", "複習": "tag-review", "週複習": "tag-review", "練習": "tag-practice", "推薦": "tag-recommended", "備用": "tag-backup", "生活": "tag-neutral" };
  const SUBJECT_MARKS = { "化學": "🧪", "生化": "🧬", "生物": "🦠", "物理": "⚛️", "英文": "🔤" };
  const SUBJECT_PATTERNS = { "化學": /化學|普化|有機/, "生化": /生化/, "生物": /生物/, "物理": /物理/, "英文": /英文|英語/ };
  function taskSubject(t) {
    const title = String(t.title || "");
    const direct = Object.entries(SUBJECT_PATTERNS).filter(([, pattern]) => pattern.test(title)).map(([subject]) => subject);
    if (direct.length === 1) return direct[0];
    const linked = [...new Set((Array.isArray(t.relatedSubjects) ? t.relatedSubjects : []).filter((s) => SUBJECT_MARKS[s]))];
    if (linked.length === 1) return linked[0];
    if (direct.length > 1 || linked.length > 1) return null;
    if (/anki/i.test(title)) return "Anki";
    return null;
  }
  function isLifeTask(t) {
    return /^(早餐|午餐|晚餐|用餐|飯後散步|散步|步數|肌酸|蛋白粉|重量訓練|重訓|運動|洗澡|晚間簡單整理|簡單清潔|清潔收尾|睡前)(?:[｜|：:\s＋+]|$)/.test(String(t.title || ""));
  }
  const STUDY_TASK_TYPES = new Set(["預習", "初學", "複習", "週複習", "練習"]);
  const DIFFICULTY_FACTORS = { "簡單": 0.75, "標準": 1, "困難": 1.5 };
  const EXPLICIT_STUDY_TASK = /看課|上課|練習|錯題|訂正|精讀|單字|字彙|閱讀|測驗|預習|到期卡|自測|背誦|解題|做題|新卡|複習|回顧|第\s*\d+(?:\s*[-－]\s*\d+)?\s*堂|(?:看|上)微課|微課.*(?:觀看|看課|上課|第\s*\d+|堂|單元|練習|複習)/i;
  const ADMIN_ONLY_TASK = /^(設定|整理牌組|整理資料|整理檔案|同步|匯入|匯出|登入|排程|安排|管理)(?:[｜|：:\s＋+]|$)/;
  const ADMIN_OPERATION = /登入|帳號|密碼|安裝|設定|同步|匯入|匯出|排程|安排|管理/;
  function isStudyTask(t) {
    const title = String(t.title || "").trim();
    if (!title || isLifeTask(t) || ADMIN_ONLY_TASK.test(title)) return false;
    const explicitStudy = EXPLICIT_STUDY_TASK.test(title);
    if (ADMIN_OPERATION.test(title) && !explicitStudy) return false;
    if (STUDY_TASK_TYPES.has(String(t.type || ""))) return true;
    return explicitStudy;
  }
  function coursePointAllocation(tasks) {
    const byCourse = new Map();
    let totalRaw = 0, unassignedRaw = 0, eligibleTasks = 0, unscoredTasks = 0;
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (t.done !== true || t.skipped === true || !isStudyTask(t)) continue;
      const minutes = Number(t.estimatedMinutes);
      const factor = DIFFICULTY_FACTORS[t.difficulty];
      if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(factor)) { unscoredTasks++; continue; }
      const points = 10 * minutes * factor / 30;
      totalRaw += points;
      eligibleTasks++;
      const courses = [...new Set((Array.isArray(t.relatedCourses) ? t.relatedCourses : [])
        .filter((course) => typeof course === "string" && course.trim())
        .map((course) => course.trim()))];
      if (!courses.length) { unassignedRaw += points; continue; }
      const share = points / courses.length;
      for (const course of courses) byCourse.set(course, (byCourse.get(course) || 0) + share);
    }
    return { byCourse, eligibleTasks, unscoredTasks, totalRaw, total: Math.round(totalRaw), unassignedRaw };
  }
  const formatPoints = (points) => Number((Number(points) || 0).toFixed(1));
  function taskStages(t) {
    const title = String(t.title || "");
    const stages = [];
    const type = ["預習", "初學", "複習", "週複習"].includes(t.type) ? t.type : "";
    const prep = type ? type === "預習" : /預習|課前/.test(title);
    const explicitReview = /複習|回顧|錯題|到期卡/.test(title);
    const newCardsOnly = /新卡|新單字/.test(title);
    const review = type ? type === "複習" || type === "週複習" : explicitReview || (/anki/i.test(title) && !newCardsOnly);
    const explicitLearning = type ? type === "初學" : /初學|入門|新卡|新單字|首次/.test(title);
    const lessonCue = /看課|上課|課程|先修|主課|第\s*\d+(?:\s*[-－]\s*\d+)?\s*堂/.test(title);
    if (prep) stages.push("預習");
    if (explicitLearning || (!prep && !review && lessonCue)) stages.push("初學");
    if (review) stages.push("複習");
    if (/練習題|練習|題目|做題|解題/.test(title)) stages.push("練習");
    return stages;
  }
  function reviewSuggestion(t) {
    const ideas = {
      "化學": "回想週期表第 1–30 號元素（名稱與符號）",
      "生化": "背 20 種胺基酸（名稱與三字／單字縮寫）",
      "生物": "默寫 10 個核心名詞，並各用一句話解釋",
      "物理": "默寫 5 個常用公式，再各做 1 題",
      "英文": "回想 20 個單字，並用其中 5 個造句",
      "Anki": "完成 20 張到期卡，標記仍不熟的卡片",
    };
    return ideas[taskSubject(t)] || "默寫 10 個本週重點，再訂正 3 個易錯處";
  }
  function taskItem(t, options = {}) {
    const activity = options.activity || taskActivity(t);
    const labels = [];
    labels.push(...taskStages(t));
    const source = String(t.source || "");
    if (source && source !== "今日") labels.push(source);
    else if (/推薦/.test(String(t.title || "")) && !labels.includes("推薦")) labels.push("推薦");
    if (isLifeTask(t)) labels.push("生活");
    const badges = labels.map((label) => el("span", { class: `tag ${TASK_TAG_STYLES[label] || "tag-neutral"}` }, label));
    const subject = isLifeTask(t) ? null : taskSubject(t);
    const suffix = SUBJECT_MARKS[subject] ? el("span", { class: "task-subject-suffix", "data-subject": subject, title: `科目：${subject}` }, `${subject} ${SUBJECT_MARKS[subject]}`) : null;
    const taskText = String(activity);
    const title = el("span", { class: "task-title" }, el("span", { class: "task-activity", tabindex: "0", title: taskText, "aria-label": taskText }, taskText), badges);
    const copy = el("div", { class: "t task-copy" }, title);
    return el("li", { class: "item task-item" + (t.done ? " done" : "") },
      el("button", { class: "chk", role: "checkbox", "aria-checked": String(t.done), "aria-label": t.done ? "取消完成" : "標記完成", onclick: () => toggleTask(t) }),
      suffix,
      copy,
      t.skipped ? el("button", { class: "ghost", onclick: () => skipTask(t, false) }, "恢復")
        : t.done ? null : el("button", { class: "ghost", onclick: () => skipTask(t, true) }, "跳過"));
  }
  function taskActivity(t) {
    const title = String(t.title || "");
    const lesson = title.match(/第\s*\d+(?:\s*[-－]\s*\d+)?\s*堂/);
    const lessonName = lesson ? lesson[0].replace(/\s+/g, "") : "";
    const actions = [];
    const cleanStageWords = (s) => String(s || "").replace(/預習|初學|複習|推薦|備用/g, " ").replace(/\s+/g, " ").trim();
    if (/anki/i.test(title)) {
      const detail = cleanStageWords(title.replace(/^.*?anki(?:\s*[｜|：:]\s*|\s+)?/i, "")).replace(/^(?:(?:製作|新增|建立)\s*)?(?:新卡|新單字)\s*[：:|]?\s*/, "");
      const making = /新卡|新單字|製作|新增|建立/.test(title), reviewing = /到期卡|複習|回顧|重測|錯卡/.test(title);
      const verb = making && reviewing ? "複習到期卡＋製作 Anki 新卡" : making ? "製作 Anki 新卡" : reviewing ? "複習 Anki 到期卡" : "先複習到期卡；若沒有，依本任務明示的備援方式處理";
      actions.push(detail ? `${verb}：${shortTitle(detail)}` : verb);
    }
    if (/錯題/.test(title)) {
      const detail = title.replace(/^錯題\s*[｜|：:]\s*/, "").trim();
      actions.push(detail ? shortTitle(detail) : "從今日已有教材或錯題本挑 1 題尚未練過的題目，記下錯因與正確第一步，再遮住解答重測");
    }
    else if (/複習|回顧/.test(title)) actions.push(lessonName ? `默寫${lessonName}重點` : reviewSuggestion(t));
    if (/講義/.test(title) && /(練習題|題目|做題|解題)/.test(title)) actions.push("做講義練習題");
    else if (/練習題/.test(title)) actions.push("做練習題");
    else if (/(題庫|題目|做題|解題)/.test(title)) actions.push("做題目");
    const reviewType = t.type === "複習" || t.type === "週複習";
    const explicitWatch = /看課|上課|看完|看前|看後|看影片|觀看|觀看片段|影片/.test(title);
    const learningCourse = t.type === "初學" && (lessonName || /(課程|先修|主課)/.test(title));
    if (!reviewType && !/錯題|複習|回顧/.test(title) && (explicitWatch || learningCourse)) {
      const detail = title.replace(/^(化學|普化|有機|生化|生物|物理|英文|英語)\s*[｜|：:]?\s*/, "").trim();
      actions.push(detail ? `推進課程進度：${shortTitle(detail)}` : "推進課程進度");
    }
    if (/閱讀|文章/.test(title)) actions.push(/文章/.test(title) ? "閱讀文章" : "閱讀");
    if (!/anki/i.test(title) && /單字|生字/.test(title)) actions.push(/自測|測驗|回想/.test(title) ? "自測單字" : "背單字");
    if (!actions.length && /預習/.test(title)) actions.push("先讀本節綱要，列出 3 個問題");
    if (!actions.length && /初學/.test(title)) actions.push("看 1 小節，寫下 3 個重點");
    if (!actions.length && /練習/.test(title)) actions.push("做 5 題同主題題目，整理錯因");
    if (actions.length) return [...new Set(actions)].join("＋");
    const remainder = title
      .replace(/化學|普化|有機|生化|生物|物理|英文|英語|anki/gi, " ")
      .replace(/今日|推薦|備用|預習|初學|複習|練習/g, " ")
      .replace(/[：:＋+｜|]/g, " ").replace(/\s+/g, " ").trim();
    return remainder || "待補內容";
  }
  function renderTaskGroups(tasks) {
    return tasks.map((t) => taskItem(t, { activity: taskActivity(t) }));
  }

  function renderTasks() {
    const real = state.tasks.filter((t) => !t.skipped).sort((a, b) => a.done - b.done || a.order - b.order);
    const skipped = state.tasks.filter((t) => t.skipped);
    const done = real.filter((t) => t.done).length, pct = real.length ? Math.round(done / real.length * 100) : 0;
    $("task-count").textContent = real.length ? `${done}/${real.length}` : "";
    $("task-prog-i").style.width = pct + "%";
    $("tasks").replaceChildren(...(real.length ? renderTaskGroups(real) : [el("li", { class: "empty" }, "今天沒有任務")]));
    $("skipped-wrap").hidden = !skipped.length;
    updateProg();
    $("skipped").replaceChildren(...skipped.map(taskItem));
  }

  const diaryOf = (r) => { const w = r.workout ?? localStorage.getItem("sd-workout-" + (r.date || "")) ?? ""; return (r.review || "") + (w ? ((r.review ? "\n" : "") + "運動：" + w) : ""); };
  const moodUi = (m) => (m ? ({ "不錯": "很好", "疲累": "低落" }[m] || m) : null);
  function renderRecord() {
    const r = state.record || {};
    if (document.activeElement?.closest?.("#f-hours,#f-minutes,#f-review,#f-workout,#f-points") == null) {
      $("f-hours").value = r.hours ?? ""; $("f-minutes").value = r.minutes ?? "";
      $("f-review").value = diaryOf(r); $("f-workout").value = ""; $("f-points").value = r.points || "";
    }
    mood = moodUi(r.mood); renderMoods(); updateTotal();
    updateProg(); recBtn();
  }
  function updateProg() {
    const t = (state.tasks || []).filter((x) => !x.skipped), d = t.filter((x) => x.done).length, p = t.length ? Math.round(d / t.length * 100) : 0;
    $("completion").textContent = t.length ? `${d}/${t.length}　${p}%` : "";
    $("prog-i").style.width = p + "%";
  }
  function renderMoods() {
    $("moods").replaceChildren(...C.MOODS.map((m) => el("button", {
      role: "radio", "aria-checked": String(mood === m), type: "button",
      onclick: () => { mood = mood === m ? null : m; renderMoods(); recBtn(); },
    }, m)));
  }
  function recBtn() {
    const r = state.record || {}, b = $("save-record");
    const cur = [$("f-review").value, $("f-points").value, mood || ""];
    const sav = [diaryOf(r), r.points || "", moodUi(r.mood) || ""];
    b.disabled = cur.every((v, i) => v === sav[i]);
  }
  function updateTotal() { $("ypt").textContent = fmtYpt($("f-hours").value, $("f-minutes").value); }

  function renderLessons() {
    const ls = state.lessons || [];
    const hasCourseStats = Array.isArray(state.courseStats) && state.courseStats.length > 0;
    const seriesOf = (l) => (l.title || "").replace(/\s*第?\s*\d+[-－]\d+\s*堂?.*$/, "").trim() || l.subject || "課程";
    const keyOf = (l) => l.course || (hasCourseStats ? `${l.subject || "未分類"}（未設定課程）` : seriesOf(l));
    const visible = new Map();
    ls.forEach((l) => { const k = keyOf(l); if (!visible.has(k)) visible.set(k, []); visible.get(k).push(l); });
    const stats = hasCourseStats ? state.courseStats : [...visible.entries()].map(([name, items]) => ({
      course: name, name, subject: items[0]?.subject || null, total: items.length,
      done: items.filter((l) => l.done).length, unscheduled: 0,
      order: Math.min(...items.map((l) => l.order ?? 9999)), nextUpcoming: null,
    }));
    const total = stats.reduce((n, g) => n + (Number(g.total) || 0), 0);
    const doneTotal = stats.reduce((n, g) => n + (Number(g.done) || 0), 0);
    const pointAllocation = coursePointAllocation(state.tasks);
    const xpNotes = [];
    if (pointAllocation.unassignedRaw > 0) xpNotes.push(`未指派 ${formatPoints(pointAllocation.unassignedRaw)}`);
    if (pointAllocation.unscoredTasks) xpNotes.push(`${pointAllocation.unscoredTasks} 筆缺估時／難度`);
    $("lesson-count").textContent = total ? `${doneTotal}/${total} 堂` : "";
    $("xp-total").textContent = DEMO ? "示範資料不計分" : !xpVerified ? "今日 XP 未驗證" : `今日學習 ${pointAllocation.total} 點${xpNotes.length ? `（${xpNotes.join("；")}）` : ""}`;
    if (!stats.length) { $("lessons").replaceChildren(el("li", { class: "empty" }, "目前沒有課程進度資料")); return; }
    const list = stats.map((g) => {
      const name = g.name || g.course || "未設定課程";
      const items = visible.get(g.course || name) || [];
      items.sort((x, y) => (x.done - y.done) || ((x.order ?? 9999) - (y.order ?? 9999)));
      const courseTotal = Number(g.total) || items.length;
      const courseDone = Number(g.done) || 0;
      const pct = courseTotal ? Math.round(courseDone / courseTotal * 100) : 0;
      const coursePoints = xpVerified ? pointAllocation.byCourse.get(g.course || name) || 0 : null;
      return { ...g, name, items, courseTotal, courseDone, pct, coursePoints };
    }).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || a.name.localeCompare(b.name));
    const rows = [];
    list.forEach((g) => {
      rows.push(el("li", { class: "lv-head" },
        el("div", { class: "lv-top" }, el("span", { class: "lv-name" }, g.name), el("span", { class: "lv-tag" }, g.subject || "課程"), el("span", { class: "muted lv-stat" }, `${g.courseDone}/${g.courseTotal} 堂 · ${g.pct}%${g.coursePoints > 0 ? ` · +${formatPoints(g.coursePoints)} 點` : ""}`)),
        el("div", { class: "lv-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(g.pct), "aria-label": `${g.name}課程完成度` }, el("i", { style: `width:${g.pct}%` }))));
      if (!g.items.length) {
        const upcoming = g.nextUpcoming;
        const note = upcoming ? `下一堂：${upcoming.weekStart} · ${upcoming.title}` : g.unscheduled ? `${g.unscheduled} 堂尚未排週次` : "目前沒有待完成課次";
        rows.push(el("li", { class: "lv-upcoming muted" }, note));
      }
      g.items.forEach((l) => rows.push(
        el("li", { class: "item lesson" + (l.done ? " done" : "") },
          el("button", { class: "chk", role: "checkbox", "aria-checked": String(l.done), "aria-label": l.done ? "取消完成" : "標記完成", onclick: () => toggleLesson(l) }),
          el("div", { class: "t" }, l.title,
            el("div", { class: "meta" }, [l.subject, l.minutes ? `${l.minutes} 分` : null, l.due ? "該複習" : null].filter(Boolean).join("　"))),
          null)));
    });
    $("lessons").replaceChildren(...rows);
  }

  function renderAll() {
    { const dt = state.today || taipeiNow().date, wd = String(taipeiNow().wd || ""), w1 = ({Mon:"一",Tue:"二",Wed:"三",Thu:"四",Fri:"五",Sat:"六",Sun:"日"})[wd.slice(0, 3)] || wd.replace("星期", "").replace("週", "").slice(0, 1); $("date").replaceChildren(Object.assign(document.createElement("span"), { className: "dl", textContent: `${dt}　${wd}` }), Object.assign(document.createElement("span"), { className: "ds", textContent: `${dt.slice(5).replace("-", "/")} 週${w1}` })); }
    renderNow(); renderTasks(); renderRecord(); renderLessons();
  }

  // ---------- actions (optimistic) ----------
  async function guarded(fn, okMsg, reloadOnError = true) {
    try { await fn(); if (okMsg) toast(okMsg); }
    catch (e) { showError(e); if (reloadOnError) await load(true); }
  }
  function showError(e) {
    const m = e.message;
    if (m === "NO_API") return banner("尚未設定後端位址。請先部署 Worker，然後以 ?api=<Worker 網址> 開啟一次，或試用 ?demo=1。");
    if (m === "NO_KEY") return banner("需要 APP_KEY 才能連線。");
    toast(m.length > 60 ? "失敗，請重試" : m); banner(m);
  }
  function banner(msg) { const b = $("banner"); b.textContent = msg; b.hidden = !msg; }
  const toggleTask = (t) => guarded(async () => {
    const previous = t.done === true;
    t.done = !previous;
    try { renderAll(); await api(`/api/task/${t.id}`, { done: t.done }); }
    catch (e) { t.done = previous; renderAll(); throw e; }
  }, null, false);
  const skipTask = (t, v) => guarded(async () => {
    const previous = t.skipped === true;
    t.skipped = v;
    try { renderAll(); await api(`/api/task/${t.id}`, { skip: v }); }
    catch (e) { t.skipped = previous; renderAll(); throw e; }
  }, null, false);
  const toggleLesson = (l) => guarded(async () => {
    l.done = !l.done;
    const groupName = l.course || `${l.subject || "未分類"}（未設定課程）`;
    const group = (state.courseStats || []).find((g) => g.course === l.course && (l.course || g.name === groupName));
    if (group) group.done = Math.max(0, Math.min(group.total, group.done + (l.done ? 1 : -1)));
    renderAll();
    await api(`/api/lesson/${l.id}`, { done: l.done });
  });
  const reviewLesson = (l) => guarded(async () => { l.reviews++; renderAll(); await api(`/api/lesson/${l.id}`, { review: true }); }, "已記錄複習");

  async function load(silent) {
    try {
      const incoming = await api("/api/state");
      if (!incoming || !Array.isArray(incoming.tasks) || typeof incoming.today !== "string" || !incoming.today)
        throw new Error("儀表板狀態資料不完整");
      state = incoming;
      xpVerified = !DEMO;
      banner(""); renderAll();
    } catch (e) { xpVerified = false; if (!silent) showError(e); renderAll(); }
  }

  // ---------- init ----------
  function init() {
    $("n-subject").append(...C.SUBJECTS.map((s) => el("option", { value: s }, s)));
    $("mode").textContent = DEMO ? "示範模式" : "";
    ["f-hours", "f-minutes"].forEach((id) => $(id).addEventListener("input", updateTotal));
    (function () {
      const el2 = $("countdown"); if (!el2 || !C.EXAM_DATE) return;
      const d = new Date(C.EXAM_DATE + "T00:00:00"), n = new Date(); n.setHours(0, 0, 0, 0);
      const days = Math.round((d - n) / 86400000);
      el2.replaceChildren(...(days > 0 ? [Object.assign(document.createElement("span"), { className: "dl", textContent: `　倒數 ${days} 天` }), Object.assign(document.createElement("span"), { className: "ds", textContent: `${days} 天` })] : days === 0 ? [document.createTextNode("今天考試")] : []));
    })();
    
    ankiBadge();
    $("anki-link").addEventListener("click", (e) => {
      e.preventDefault();
      const ua = navigator.userAgent || "";
      const web = "https://ankiweb.net/decks";
      if (/iPhone|iPad|iPod/i.test(ua)) { location.href = "anki://"; }
      else if (/Android/i.test(ua)) { location.href = "intent://#Intent;package=com.ichi2.anki;S.browser_fallback_url=" + encodeURIComponent(web) + ";end"; }
      else {
        ankiCall("guiDeckBrowser").catch(() => {
          let left = false; const onHide = () => { left = true; };
          window.addEventListener("blur", onHide, { once: true });
          location.href = "anki://";
          setTimeout(() => { window.removeEventListener("blur", onHide); if (!left && !document.hidden) window.open(web, "_blank", "noopener"); }, 2500);
        });
      }
    });
    $("hevy-link").addEventListener("click", (e) => {
      const ua = navigator.userAgent || "", web = "https://hevy.com/";
      if (/iPhone|iPad|iPod/i.test(ua)) {
        e.currentTarget.href = "https://hevy.go.link/home?adj_t=20au7x2d&adj_deep_link=com.hevy%3A%2F%2Fhome&adj_redirect_macos=https%3A%2F%2Fapps.apple.com%2Fapp%2Fid1458862350";
        e.currentTarget.target = "_self";
      } else if (/Android/i.test(ua)) { e.preventDefault(); location.href = "intent://#Intent;scheme=hevy;package=com.hevy;S.browser_fallback_url=" + encodeURIComponent(web) + ";end"; }
    });
    $("reset-key").onclick = (e) => {
      e.preventDefault();
      const u = prompt("Worker 網址（留空保持不變）", apiBase()); if (u) localStorage.setItem("apiBase", u.trim());
      localStorage.removeItem("appKey"); Promise.resolve(load()).finally(() => toast("重置成功"));
    };
    ["f-review", "f-workout", "f-points"].forEach((id) => $(id).addEventListener("input", recBtn));
    $("save-record").onclick = () => guarded(async () => {
      const num = (id) => ($(id).value === "" ? null : Number($(id).value));
      state.record = await api("/api/record", {
        hours: num("f-hours"), minutes: num("f-minutes"),
        "心得": $("f-review").value, "運動": "", "重點": $("f-points").value, "心情": mood || "",
      });
      renderRecord();
    }, "已儲存");
    // keep fixed layout from drifting when focus scrolls hidden containers
    ["main", ".col", ".card"].forEach((sel) => document.querySelectorAll(sel).forEach((n) => n.addEventListener("scroll", () => { if (n.scrollTop) n.scrollTop = 0; }, { passive: true })));
    // ---------- note draft ----------
    const nd = (() => { try { return JSON.parse(localStorage.getItem("sd-note-draft") || "null") || {}; } catch (e) { return {}; } })();
    // pages: [{v, imgs:[dataurl]}]; cur = photos for the page currently in the input; sel = chosen page index or -1
    (() => { // migrate old flat items
      if (nd.pages) return; nd.pages = []; nd.cur = [];
      (nd.items || []).forEach((it) => { if (it.t === "text") nd.pages.push({ v: it.v, imgs: [] }); else if (nd.pages.length) nd.pages[nd.pages.length - 1].imgs.push(it.d); else nd.cur.push(it.d); });
      delete nd.items;
    })();
    nd.cur = nd.cur || [];
    const ndSave = () => { try { localStorage.setItem("sd-note-draft", JSON.stringify({ title: $("n-title").value, subject: $("n-subject").value, pages: nd.pages, cur: nd.cur })); } catch (e) { toast("草稿太大，請減少照片"); } };
    const fit = (t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; };
    function ndRender() {
      const thumbs = (imgs) => imgs.length ? el("div", { class: "n-th" }, ...imgs.map((d) => el("span", { class: "n-ti" }, el("img", { src: d, alt: "" })))) : "";
      const lis = nd.pages.map((pg, i) => el("li", { class: "n-it" },
        el("div", { class: "n-pn" }, `第 ${i + 1} 頁`),
        el("textarea", { rows: "1", onclick: (ev) => ev.stopPropagation(), oninput: (ev) => { pg.v = ev.target.value; fit(ev.target); ndSave(); } }),
        thumbs(pg.imgs)));
      if (nd.cur.length) lis.push(el("li", { class: "n-it cur" }, el("div", { class: "n-pn" }, `目前草稿照片`), thumbs(nd.cur)));
      $("n-draft").replaceChildren(...lis);
      document.querySelectorAll("#n-draft textarea").forEach((t, k) => { t.value = nd.pages[k].v; fit(t); });
      $("n-photo").textContent = "照片";
    }
    if (nd.title) $("n-title").value = nd.title; if (nd.subject) $("n-subject").value = nd.subject;
    ["n-title", "n-subject"].forEach((id) => $(id).addEventListener("input", ndSave));
    ndRender();
    const grow = () => { const t = $("n-points"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, Math.round(innerHeight * 0.6)) + "px"; };
    const ndCommitCurrentPage = () => { const v = $("n-points").value.trim(); if (!v && !nd.cur.length) return false; nd.pages.push({ v, imgs: nd.cur }); nd.cur = []; $("n-points").value = ""; grow(); ndSave(); ndRender(); return true; };
    $("n-points").addEventListener("input", grow);
    $("n-photo").onclick = () => $("n-file").click();
    const shrink = (file) => new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c.toDataURL("image/jpeg", 0.72)); };
      img.onerror = () => rej(new Error("無法讀取圖片")); img.src = u;
    });
    $("n-file").onchange = async (e) => {
      const target = nd.cur;
      for (const f of [...e.target.files]) { try { target.push(await shrink(f)); } catch (er) { toast(er.message); } }
      e.target.value = ""; ndSave(); ndRender();
    };
    $("n-clear").onclick = () => { if (!nd.pages.length && !nd.cur.length && !$("n-title").value && !$("n-points").value) return; if (!confirm("確定清除目前尚未送出的筆記草稿？已送出的筆記不會受影響。")) return; nd.pages = []; nd.cur = []; $("n-title").value = ""; $("n-points").value = ""; grow(); ndSave(); ndRender(); };
    $("save-note").onclick = () => guarded(async () => {
      ndCommitCurrentPage();
      if (!nd.pages.length) return toast("請先輸入內容或照片");
      const texts = nd.pages.map((x) => x.v).filter(Boolean);
      const pages = nd.pages.map((p, i) => ({ photos: p.imgs.map((d, k) => ({ name: `note-${Date.now()}-${i}-${k}.jpg`, type: "image/jpeg", data: d.split(",")[1] })) }));
      const total = pages.reduce((n, p) => n + p.photos.length, 0);
      if (total > 8) return toast("照片最多 8 張");
      const title = $("n-title").value.trim() || (texts[0] || "照片筆記").split("\n")[0].slice(0, 30);
      await api("/api/note", { title, subject: $("n-subject").value, points: texts.join("\n"), pages });
      nd.pages = []; nd.cur = []; $("n-title").value = ""; ndSave(); ndRender();
    }, "筆記已送出");

    // ---------- focus timer ----------
    const fc = { st: null, off: 0, busy: false, pickerOpen: false, anchor: null };
    const fmtHMS = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
    const fmtHM = (s) => `${Math.floor(s / 3600)}時${String(Math.floor(s / 60) % 60).padStart(2, "0")}分`;
    const fmtFull = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 86400)}天 ${Math.floor(s / 3600) % 24}時 ${Math.floor(s / 60) % 60}分 ${s % 60}秒`; };

    const FC_ICON_ART = {
      idle: `<g>
        <path d="M3.5 5.5a2 2 0 0 1 2-2h10.6v17H5.5a2 2 0 0 1-2-2v-13Z"/>
        <path d="M7.2 3.5v17M10 8h3.5M10 11.2h3.5"/>
        <path d="M19 5.2 22.2 5.5 21.3 17l-1.7 2-1.2-2.2L19 5.2Z"/>
        <path d="m18.8 7.5 3.2.3M19.6 16.2l1.8.2"/>
        <rect x="19.8" y="21" width="5" height="2.6" rx=".8"/>
        <path class="fc-glint" d="M20.6 21.8h3.4"/>
      </g>`,
      "英文": `<g>
        <path d="M4.2 4.5h15.6a2 2 0 0 1 2 2v9.3a2 2 0 0 1-2 2h-8l-5.2 3v-3H4.2a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"/>
        <path d="m8.1 14 2.6-7 2.6 7M9 11.8h3.3"/>
        <path class="fc-glint" d="M17.2 7.5h1.4"/>
      </g>`,
      "化學": `<g>
        <path d="M9 3.5h6M10.5 3.5v6.2l-5.1 8.2A2.1 2.1 0 0 0 7.2 21h9.6a2.1 2.1 0 0 0 1.8-3.1l-5.1-8.2V3.5"/>
        <path d="M7.2 16.2h9.6"/>
        <circle cx="10" cy="14.2" r=".7"/><circle cx="14.4" cy="12.7" r=".55"/>
        <path class="fc-glint" d="M16.4 15.2h.8"/>
      </g>`,
      "生物": `<g>
        <path d="M21 4.2C12.8 4.2 6 7.5 6 13.1c0 3.1 2.2 5.2 5.2 5.2C16.8 18.3 20.6 11.7 21 4.2Z"/>
        <path d="M4 21c4.1-5.7 8.3-9.1 15.2-13.5M9.1 15.2l-.4-3.1M13.3 11.7l.2-3M14.7 13.6l3 .4"/>
        <path class="fc-glint" d="M18.4 6.4 19.6 5.8"/>
      </g>`,
      "物理": `<g>
        <ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(-30 12 12)"/>
        <ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(30 12 12)"/>
        <ellipse cx="12" cy="12" rx="9.2" ry="3.6" transform="rotate(90 12 12)"/>
        <circle cx="12" cy="12" r="1.55" fill="currentColor"/>
        <circle class="fc-glint" cx="19.1" cy="8.1" r=".8"/>
      </g>`,
      "生化": `<g>
        <path d="M7 3.5c7 4.3 7 12.7 0 17M17 3.5c-7 4.3-7 12.7 0 17"/>
        <path d="M8.2 5.1h7.6M6.9 8.2h10.2M6.5 12h11M6.9 15.8h10.2M8.2 18.9h7.6"/>
        <path class="fc-glint" d="M16.8 5.4 18 4.7"/>
      </g>`,
      "Anki": `<g>
        <rect x="4" y="5.5" width="12" height="16" rx="2"/><rect x="8" y="3" width="12" height="16" rx="2"/>
        <path d="M11 8h5M11 11h5M7 10v7M7 19h5"/>
        <path class="fc-glint" d="M16.5 5h1.4"/>
      </g>`,
      "其他": `<g>
        <circle cx="12" cy="12" r="8.6"/><path d="M12 7v5l3.2 2"/>
        <path class="fc-glint" d="M6.5 6.5 7.5 5.7"/>
      </g>`
    };
    let fcVisualSubject = null;
    function fcUpdateVisual(subject) {
      const label = subject || "";
      if (label === fcVisualSubject) return;
      fcVisualSubject = label;
      const known = Object.prototype.hasOwnProperty.call(FC_ICON_ART, label);
      const iconKey = known ? label : (label ? "其他" : "idle");
      $("fc-subject-icon").innerHTML = FC_ICON_ART[iconKey];
      $("fc-heading").textContent = label || "열품타";
      $("fc-heading").setAttribute("lang", label ? "zh-Hant" : "ko");
      const heading = $("fc-heading-wrap");
      if (label) heading.dataset.subject = iconKey;
      else delete heading.dataset.subject;
    }
    const segSec = () => { const a = fc.st?.active; if (!a) return 0; const st0 = fc.anchor && fc.anchor.id === a.id && a.acc < 5 ? fc.anchor.start : a.start; return Math.max(0, a.acc + (a.status === "進行中" && st0 ? (Date.now() + fc.off - st0) / 1000 : 0)); };
    const totalSec = () => (fc.st?.todayDoneSec || 0) + segSec();
    function fcRender() {
      const a = fc.st?.active, running = a?.status === "進行中";
      const selected = a?.subject;
      fcUpdateVisual(selected);
      const choosing = !!fc.pickerOpen && !a;
      const main = $("fc-main"), picker = $("fc-subj");
      picker.hidden = !choosing;
      main.dataset.state = a ? "active" : choosing ? "choosing" : "idle";
      main.setAttribute("aria-expanded", String(choosing));
      main.setAttribute("aria-busy", String(fc.busy));
      $("focus").classList.toggle("is-choosing", choosing);
      const t = a ? segSec() : totalSec();
      $("focus").classList.toggle("is-running", !!running);
      $("fc-time").textContent = fmtHMS(t);
      $("fc-time").classList.toggle("run", !!running);
      document.querySelectorAll("#fc-subj button").forEach((b) => {
        const k = b.dataset.s;
        b.hidden = !choosing;
        b.classList.toggle("on", false);
        b.classList.toggle("run", false);
        b.setAttribute("aria-pressed", "false");
        b.title = `${k}，開始新的計時段`;
        b.setAttribute("aria-label", `${k}，開始新的計時段`);
      });
      const assigned = (state.tasks || []).filter((x) => x.source === "今日" && !x.skipped).length;
      const goalH = Math.min(10, Math.max(3, 3 + assigned * 0.5)), pct = Math.round(totalSec() / (goalH * 3600) * 100);
      $("fc-prog-i").style.width = Math.min(100, pct) + "%"; $("fc-prog-i").parentNode.classList.toggle("over", pct > 100);
      $("fc-goal-t").textContent = `目標 ${goalH} 時　${pct}%`;
      $("fc-goal").hidden = !!a;
      main.setAttribute("aria-label", a ? `${selected || "專注"}；本段時間 ${fmtHMS(t)}；點擊結束計時` : choosing ? `今日總時間 ${fmtHMS(t)}；請選擇科目開始計時` : `열품타；今日總時間 ${fmtHMS(t)}；點擊選擇科目`);
      document.title = running ? `${fmtHMS(t)} 專注 ${a.subject || "其他"}` : "清大後醫";
    }
    async function fcLoad() {
      if (fc.busy) return;
      try {
        const d = await api("/api/focus");
        const pn = fc.pin;
        if (pn && Date.now() < pn.until && ((d.active ? d.active.id : null) !== pn.id || (d.active ? d.active.status : null) !== pn.status)) return;
        fc.st = d; fc.off = d.now - Date.now(); fcRender(); fcSyncYpt();
      } catch (e) { /* offline or not deployed */ }
    }
    async function fcAct(body) {
      if (fc.busy) return;
      fc.busy = true;
      const clickAt = Date.now() + fc.off;
      const previousState = fc.st, previousAnchor = fc.anchor, previousPicker = fc.pickerOpen;
      const previousActive = fc.st?.active, previousSec = previousActive ? Math.round(segSec()) : 0;
      const base = fc.st || { todayDoneSec: 0, sessions: [], history: [], days: [], active: null };
      if (body.action === "start" || body.action === "switch") {
        const closed = previousActive ? [{ ...previousActive, acc: previousSec, end: clickAt, status: "完成" }] : [];
        fc.st = { ...base, todayDoneSec: (base.todayDoneSec || 0) + previousSec, sessions: [...(base.sessions || []), ...closed], active: { id: "local", subject: body.subject, acc: 0, start: clickAt, status: "進行中", date: base.today || taipeiNow().date }, now: clickAt };
        fc.anchor = { id: "local", start: clickAt };
        fc.pickerOpen = false;
      } else if (body.action === "stop") {
        const closed = previousActive ? [{ ...previousActive, acc: previousSec, end: clickAt, status: "完成" }] : [];
        fc.st = { ...base, todayDoneSec: (base.todayDoneSec || 0) + previousSec, sessions: [...(base.sessions || []), ...closed], active: null, now: clickAt };
        fc.anchor = null;
        fc.pickerOpen = false;
      }
      fcRender();
      try {
        const d = await api("/api/focus", body);
        if (body.action === "switch" || body.action === "start") fc.anchor = d.active ? { id: d.active.id, start: clickAt } : null;
        else if (body.action === "stop") fc.anchor = null;
        fc.st = d; fc.off = d.now - Date.now(); fc.pin = { id: d.active ? d.active.id : null, status: d.active ? d.active.status : null, until: Date.now() + 40000 };
        fcRender();
        if (body.action === "stop") { toast("已記錄這一段"); fcSyncYpt(); }
        return d;
      } catch (e) {
        fc.st = previousState; fc.anchor = previousAnchor; fc.pickerOpen = body.action === "start" ? true : previousPicker;
        fcRender(); setTimeout(fcLoad, 300); toast("無法連線：" + (e.message || ""));
      } finally { fc.busy = false; fcRender(); }
    }
    $("fc-main").onclick = () => {
      if (fc.busy) return;
      if (fc.st?.active) { fcAct({ action: "stop" }); return; }
      fc.pickerOpen = !fc.pickerOpen; fcRender();
      if (fc.pickerOpen) requestAnimationFrame(() => $("fc-subj").querySelector("button:not([hidden])")?.focus({ preventScroll: true }));
    };
    $("fc-subj").onclick = (e) => {
      const b = e.target.closest("button[data-s]");
      if (!b || fc.busy || fc.st?.active) return;
      fc.pickerOpen = false; $("fc-main").focus({ preventScroll: true });
      fcAct({ action: "start", subject: b.dataset.s });
    };
    $("fc-subj").addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      fc.pickerOpen = false; fcRender(); $("fc-main").focus({ preventScroll: true });
    });
    async function fcSyncYpt(force) {
      const t = fc.st?.todayDoneSec || 0; if (fc.st?.active || (!t && !force)) return;
      const h = Math.floor(t / 3600), m = Math.round((t % 3600) / 60);
      if (state.record && state.record.hours === h && state.record.minutes === m) return;
      try { state.record = await api("/api/record", { hours: h, minutes: m }); renderRecord(); } catch (e) {}
    }
    function fcHistory() {
      const st = fc.st || { days: [], history: [] };
      const hm = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
      const body = $("fc-body"); body.replaceChildren();
      const subs = ["英文", "化學", "生物", "物理", "生化"];
      const nowT = hm(Date.now());
      const tI = el("input", { type: "time", value: nowT });
      const mI = el("input", { type: "number", inputmode: "numeric", min: "1", max: "1440", placeholder: "分鐘" });
      const sI = el("select", {}, ...subs.map((x) => el("option", { value: x }, x)));
      const per = (v) => { if (!v) return "今日"; const [h, m] = v.split(":").map(Number); const p = h < 5 ? "凌晨" : h < 12 ? "上午" : h < 13 ? "中午" : h < 18 ? "下午" : "晚上"; return `今日 ${p} ${h % 12 === 0 ? 12 : h % 12}點${String(m).padStart(2, "0")}分`; };
      const pl = el("span", { class: "fc-per" }, per(nowT));
      const addB = el("button", { class: "primary", type: "button", disabled: true, onclick: async () => {
        const m = Number(mI.value); if (!(m >= 1) || !tI.value) return;
        addB.disabled = true;
        try { fc.st = await api("/api/focus", { action: "add", date: st.today || new Date().toISOString().slice(0, 10), time: tI.value, minutes: m, subject: sI.value }); fc.off = fc.st.now - Date.now(); fcRender(); fcSyncYpt(true); fcHistory(); toast("已新增"); }
        catch (e) { addB.disabled = false; toast("新增失敗：" + (e.message || "")); }
      } }, "新增");
      const chk = () => { addB.disabled = !(Number(mI.value) >= 1 && tI.value); pl.textContent = per(tI.value); };
      mI.addEventListener("input", chk); tI.addEventListener("input", chk);
      body.append(el("div", { class: "fc-add" },
        el("div", { class: "sub" }, "新增紀錄（僅限今日）"),
        el("div", { class: "fc-add-row fc-per-row" }, pl, tI),
        el("div", { class: "fc-add-row" }, sI, mI, addB)));
      const stBox = el("div", { class: "fc-stats" }, el("div", { class: "empty" }, "統計讀取中"));
      body.append(stBox);
      api("/api/focus", { action: "stats" }).then((s) => {
        const days = s.days || [], wk = {}, mo = {};
        const mon = (d) => { const t = new Date(d + "T00:00:00Z"); const k = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - k); return t.toISOString().slice(0, 10); };
        days.forEach((x) => { wk[mon(x.date)] = (wk[mon(x.date)] || 0) + x.sec; mo[x.date.slice(0, 7)] = (mo[x.date.slice(0, 7)] || 0) + x.sec; });
        const todayD = st.today || new Date().toISOString().slice(0, 10);
        const row = (k, v) => el("div", { class: "fc-st-r" }, el("span", {}, k), el("b", {}, v));
        const wkKeys = Object.keys(wk).sort().reverse().slice(0, 8), moKeys = Object.keys(mo).sort().reverse().slice(0, 12);
        stBox.replaceChildren(
          el("div", { class: "fc-st-top" },
            el("div", {}, el("i", {}, "歷史總計"), el("b", {}, fmtFull(s.total || 0))),
            el("div", {}, el("i", {}, "本週"), el("b", {}, fmtFull(wk[mon(todayD)] || 0))),
            el("div", {}, el("i", {}, "本月"), el("b", {}, fmtFull(mo[todayD.slice(0, 7)] || 0)))),
          el("div", { class: "sub" }, "每週"), ...wkKeys.map((k) => row(k.slice(5).replace("-", "/") + " 起", fmtHM(wk[k]))),
          el("div", { class: "sub" }, "每月"), ...moKeys.map((k) => row(k.replace("-", "/"), fmtHM(mo[k]))),
          el("div", { class: "sub" }, "每日明細"));
      }).catch(() => stBox.replaceChildren(el("div", { class: "empty" }, "統計暫時無法讀取")));
      const groups = {};
      (st.history || []).forEach((x) => (groups[x.date] ||= []).push(x));
      const dates = Object.keys(groups).sort().reverse();
      if (!dates.length) body.append(el("div", { class: "empty" }, "還沒有紀錄"));
      dates.forEach((d) => {
        const tot = groups[d].reduce((s, x) => s + x.acc, 0);
        body.append(el("div", { class: "sub fc-dgh" }, el("span", {}, d.slice(5).replace("-", "/") + (d === st.today ? "　今天" : "")), el("b", {}, fmtHM(tot))));
        const ul = el("ul", { class: "list" });
        groups[d].forEach((x) => ul.append(el("li", { class: "item" },
          el("div", { class: "t" }, `${hm(x.start)}–${x.end ? hm(x.end) : ""}　${x.subject || "其他"}`),
          el("b", {}, fmtHM(x.acc)),
          el("button", { class: "ghost fc-del", onclick: async (ev) => {
            const li = ev.target.closest("li"), ul = li.parentNode, hd = ul.previousSibling; li.remove();
            if (!ul.children.length) { ul.remove(); if (hd) hd.remove(); }
            try { const r = await api("/api/focus", { action: "delete", id: x.id }); fc.st = r; fc.off = r.now - Date.now(); fcRender(); fcSyncYpt(true); }
            catch (e) { toast("刪除失敗：" + (e.message || "")); fcHistory(); }
          } }, "刪除"))));
        body.append(ul);
      });
    }
    $("fc-hist").onclick = () => { fcHistory(); $("fc-dialog").showModal(); };
    $("fc-close").onclick = () => $("fc-dialog").close();
    $("fc-dialog").addEventListener("click", (e) => { if (e.target === $("fc-dialog")) $("fc-dialog").close(); });
    // mobile: lock scrolling when a tab's content fits; otherwise let it scroll and bounce back
    const lockFit = () => document.querySelectorAll("main .rec,main [data-tab=notes]").forEach((n) => { if (!n.offsetHeight) return; n.style.overflowY = n.scrollHeight > n.clientHeight + 1 ? "auto" : "hidden"; });
    new ResizeObserver(lockFit).observe(document.querySelector("main"));
    new MutationObserver(lockFit).observe(document.body, { attributes: true, attributeFilter: ["data-tab"] });
    addEventListener("resize", lockFit); setInterval(lockFit, 1500);
    const fcMq = matchMedia("(min-width:900px) and (min-height:560px)");
    const fcPlace = () => { const f = $("focus"); if (fcMq.matches) document.querySelector(".top > div").after(f); else { const r = document.querySelector(".rec"); r.querySelector(".prog").after(f); } };
    fcPlace(); fcMq.addEventListener("change", fcPlace);
    fcLoad(); setInterval(fcRender, 1000); setInterval(fcLoad, 8000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) fcLoad(); });
    load();
    setInterval(() => { renderNow(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  init();
})();
