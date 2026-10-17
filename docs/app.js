(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const DEMO = qs.get("demo") === "1";
  if (qs.get("api")) localStorage.setItem("apiBase", qs.get("api"));
  const apiBase = () => (localStorage.getItem("apiBase") || C.API_BASE || "").replace(/\/+$/, "");

  let state = { tasks: [], lessons: [], record: null, today: "" };
  let mood = null;

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
    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "")) return;
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
    };
  }
  async function api(path, body) {
    if (DEMO) {
      if (!demoDb) demoInit();
      await new Promise((r) => setTimeout(r, 120));
      const [, , kind, id] = path.split("/");
      const db = demoDb;
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
  function taskItem(t, options = {}) {
    const title = el("span", { class: "task-title" }, options.activity || shortTitle(t.title), t.source !== "今日" ? el("span", { class: "tag" }, t.source) : null);
    const copy = el("div", { class: "t task-copy", title: t.title }, title);
    return el("li", { class: "item" + (t.done ? " done" : "") },
      el("button", { class: "chk", role: "checkbox", "aria-checked": String(t.done), "aria-label": t.done ? "取消完成" : "標記完成", onclick: () => toggleTask(t) }),
      copy,
      t.skipped ? el("button", { class: "ghost", onclick: () => skipTask(t, false) }, "恢復")
        : t.done ? null : el("button", { class: "ghost", onclick: () => skipTask(t, true) }, "跳過"));
  }

  function taskSubject(t) {
    const title = String(t.title || "");
    if (/生化/.test(title)) return "生化";
    if (/化學|普化|有機/.test(title)) return "化學";
    if (/生物/.test(title)) return "生物";
    if (/物理/.test(title)) return "物理";
    if (/英文|英語/.test(title)) return "英文";
    if (/anki/i.test(title)) return "Anki";
    return null;
  }
  function taskActivity(t) {
    const title = String(t.title || "");
    const lesson = title.match(/第\s*\d+(?:\s*[-－]\s*\d+)?\s*堂/);
    const lessonName = lesson ? lesson[0].replace(/\s+/g, "") : "";
    const actions = [];
    if (/anki/i.test(title)) {
      const detail = title.replace(/^.*?anki\s*[:：]?\s*/i, "").trim();
      actions.push(detail ? `做 Anki：${shortTitle(detail)}` : "做 Anki");
    }
    if (/錯題/.test(title)) actions.push(lessonName ? `回顧${lessonName}錯題` : "回顧錯題");
    else if (/複習/.test(title)) actions.push(lessonName ? `複習${lessonName}` : "複習");
    if (/講義/.test(title) && /(練習題|題目|做題|解題)/.test(title)) actions.push("做講義練習題");
    else if (/練習題/.test(title)) actions.push("做練習題");
    else if (/(題庫|題目|做題|解題)/.test(title)) actions.push("做題目");
    if (!/錯題|複習/.test(title) && (lessonName || /(看課|上課|課程|先修|主課)/.test(title))) actions.push(lessonName ? `看${lessonName}` : "看課");
    if (/閱讀|文章/.test(title)) actions.push(/文章/.test(title) ? "閱讀文章" : "閱讀");
    if (/單字|生字/.test(title)) actions.push("背單字");
    if (actions.length) return [...new Set(actions)].join("＋");

    const remainder = title
      .replace(/化學|普化|有機|生化|生物|物理|英文|英語|anki/gi, " ")
      .replace(/今日|推薦|備用/g, " ")
      .replace(/[：:＋+｜|]/g, " ").replace(/\s+/g, " ").trim();
    return remainder || "待補內容";
  }
  function renderTaskGroups(tasks) {
    const groups = new Map();
    tasks.forEach((t, index) => {
      const subject = taskSubject(t), key = subject || `task:${t.id || index}`;
      if (!groups.has(key)) groups.set(key, { subject, items: [] });
      groups.get(key).items.push(t);
    });
    return [...groups.values()].flatMap((group) => group.subject
      ? [el("li", { class: "task-pack" },
        el("div", { class: "task-pack-name" }, group.subject),
        el("ul", { class: "list task-pack-list" }, group.items.map((t) => taskItem(t, { activity: taskActivity(t) }))))]
      : group.items.map((t) => taskItem(t)));
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

  const RANKS = ["見習", "進階", "熟練", "精通"], PER = 10, BASE = (C.BASE_DONE || {});
  const TOP = {
    "化學": ["拉瓦節", "道耳吞", "門得列夫", "鮑林", "居禮夫人"],
    "生物": ["虎克", "孟德爾", "達爾文", "華生與克里克", "巴斯德"],
    "生化": ["克雷布斯", "桑格", "鮑林", "華生與克里克", "多德納"],
    "物理": ["伽利略", "牛頓", "馬克士威", "愛因斯坦", "費曼"],
    "英文": ["莎士比亞", "狄更斯", "喬治歐威爾", "海明威", "牛津大師"],
  };
  const titleFor = (name, subject, ri) => {
    if (ri < RANKS.length) return RANKS[ri];
    const key = Object.keys(TOP).find((k) => (name + (subject || "")).includes(k));
    const list = key ? TOP[key] : ["大師", "宗師", "傳奇", "泰斗", "殿堂"];
    return list[Math.min(ri - RANKS.length, list.length - 1)];
  };
  function renderLessons() {
    const ls = state.lessons;
    $("lesson-count").textContent = ls.length ? `${ls.filter((l) => l.done).length}/${ls.length}` : "";
    if (!ls.length) { $("lessons").replaceChildren(el("li", { class: "empty" }, "本週沒有課程")); return; }
    const seriesOf = (l) => (l.title || "").replace(/\s*第?\s*\d+[-－]\d+\s*堂?.*$/, "").trim() || l.subject || "課程";
    const groups = new Map();
    ls.forEach((l) => { const k = seriesOf(l); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); });
    const ord = (l) => (l.order == null ? 9999 : l.order);
    const list = [...groups.entries()].map(([name, items]) => {
      items.sort((x, y) => (x.done - y.done) || (ord(x) - ord(y)));
      const done = items.filter((x) => x.done).length, pct = Math.round((done / items.length) * 100);
      const next = items.find((x) => !x.done);
      return { name, items, done, pct, key: (next ? ord(next) : 99999) + (name.includes("先修") ? 0 : 50000) };
    }).sort((x, y) => x.key - y.key);
    const rows = [];
    list.forEach((g) => {
      const sk = "lvdone:" + g.name; let seen = [];
      try { seen = JSON.parse(localStorage.getItem(sk) || "[]"); } catch (e) { seen = []; }
      const set = new Set([...seen, ...((C.DONE_TITLES || {})[g.name] || [])]); g.items.forEach((l) => { if (l.done) set.add(l.title); });
      localStorage.setItem(sk, JSON.stringify([...set]));
      const n = (BASE[g.name] || 0) + set.size, lv = n + 1, ri = Math.floor((lv - 1) / PER), inRank = (lv - 1) % PER;
      rows.push(el("li", { class: "lv-head" },
        el("div", { class: "lv-top" }, el("span", { class: "lv-name" }, g.name), el("span", { class: "lv-tag" }, `${titleFor(g.name, g.items[0].subject, ri)}　Lv.${lv}`), el("span", { class: "muted" }, `${g.done}/${g.items.length}`)),
        el("div", { class: "lv-bar" }, el("i", { style: `width:${inRank * 10}%` }))));
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
  async function guarded(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); }
    catch (e) { showError(e); await load(true); }
  }
  function showError(e) {
    const m = e.message;
    if (m === "NO_API") return banner("尚未設定後端位址。請先部署 Worker，然後以 ?api=<Worker 網址> 開啟一次，或試用 ?demo=1。");
    if (m === "NO_KEY") return banner("需要 APP_KEY 才能連線。");
    toast(m.length > 60 ? "失敗，請重試" : m); banner(m);
  }
  function banner(msg) { const b = $("banner"); b.textContent = msg; b.hidden = !msg; }
  const toggleTask = (t) => guarded(async () => { t.done = !t.done; renderAll(); await api(`/api/task/${t.id}`, { done: t.done }); });
  const skipTask = (t, v) => guarded(async () => { t.skipped = v; renderAll(); await api(`/api/task/${t.id}`, { skip: v }); });
  const toggleLesson = (l) => guarded(async () => { l.done = !l.done; renderAll(); await api(`/api/lesson/${l.id}`, { done: l.done }); });
  const reviewLesson = (l) => guarded(async () => { l.reviews++; renderAll(); await api(`/api/lesson/${l.id}`, { review: true }); }, "已記錄複習");

  async function load(silent) {
    try {
      state = await api("/api/state");
      banner(""); renderAll();
    } catch (e) { if (!silent) showError(e); renderAll(); }
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
    nd.cur = nd.cur || []; nd.sel = -1;
    const ndSave = () => { try { localStorage.setItem("sd-note-draft", JSON.stringify({ title: $("n-title").value, subject: $("n-subject").value, pages: nd.pages, cur: nd.cur })); } catch (e) { toast("草稿太大，請減少照片"); } };
    const fit = (t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; };
    function ndRender() {
      const thumbs = (imgs, rm) => imgs.length ? el("div", { class: "n-th" }, ...imgs.map((d, k) => el("span", { class: "n-ti" }, el("img", { src: d, alt: "" }), el("button", { type: "button", class: "n-x2", "aria-label": "移除照片", onclick: (ev) => { ev.stopPropagation(); rm(k); } }, "×")))) : "";
      const lis = nd.pages.map((pg, i) => el("li", { class: "n-it" + (nd.sel === i ? " sel" : ""), onclick: () => { nd.sel = nd.sel === i ? -1 : i; ndRender(); } },
        el("div", { class: "n-pn" }, `第 ${i + 1} 頁`, nd.sel === i ? "　照片將加入此頁" : ""),
        el("textarea", { rows: "1", onclick: (ev) => ev.stopPropagation(), oninput: (ev) => { pg.v = ev.target.value; fit(ev.target); ndSave(); } }),
        thumbs(pg.imgs, (k) => { pg.imgs.splice(k, 1); ndSave(); ndRender(); }),
        el("button", { class: "n-x", type: "button", "aria-label": "移除此頁", onclick: (ev) => { ev.stopPropagation(); if (pg.v || pg.imgs.length) if (!confirm("移除此頁？")) return; nd.pages.splice(i, 1); nd.sel = -1; ndSave(); ndRender(); } }, "×")));
      if (nd.cur.length) lis.push(el("li", { class: "n-it cur" }, el("div", { class: "n-pn" }, `第 ${nd.pages.length + 1} 頁（輸入中）照片`), thumbs(nd.cur, (k) => { nd.cur.splice(k, 1); ndSave(); ndRender(); })));
      $("n-draft").replaceChildren(...lis);
      document.querySelectorAll("#n-draft textarea").forEach((t, k) => { t.value = nd.pages[k].v; fit(t); });
      $("n-photo").textContent = nd.sel >= 0 ? `照片→第${nd.sel + 1}頁` : "照片";
    }
    if (nd.title) $("n-title").value = nd.title; if (nd.subject) $("n-subject").value = nd.subject;
    ["n-title", "n-subject"].forEach((id) => $(id).addEventListener("input", ndSave));
    ndRender();
    const grow = () => { const t = $("n-points"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, Math.round(innerHeight * 0.6)) + "px"; };
    const ndAddText = () => { const v = $("n-points").value.trim(); if (!v && !nd.cur.length) return false; nd.pages.push({ v, imgs: nd.cur }); nd.cur = []; $("n-points").value = ""; grow(); ndSave(); ndRender(); return true; };
    $("n-points").addEventListener("input", grow);
    $("n-add").onclick = () => { ndAddText(); };
    $("n-points").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ndAddText(); } });
    $("n-photo").onclick = () => $("n-file").click();
    const shrink = (file) => new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); res(c.toDataURL("image/jpeg", 0.72)); };
      img.onerror = () => rej(new Error("無法讀取圖片")); img.src = u;
    });
    $("n-file").onchange = async (e) => {
      const target = nd.sel >= 0 && nd.pages[nd.sel] ? nd.pages[nd.sel].imgs : nd.cur;
      for (const f of [...e.target.files]) { try { target.push(await shrink(f)); } catch (er) { toast(er.message); } }
      e.target.value = ""; ndSave(); ndRender();
    };
    $("n-clear").onclick = () => { if (!nd.pages.length && !nd.cur.length && !$("n-title").value && !$("n-points").value) return; if (!confirm("清除目前草稿？")) return; nd.pages = []; nd.cur = []; nd.sel = -1; $("n-title").value = ""; $("n-points").value = ""; grow(); ndSave(); ndRender(); };
    $("save-note").onclick = () => guarded(async () => {
      ndAddText();
      if (!nd.pages.length) return toast("請先輸入內容或照片");
      const texts = nd.pages.map((x) => x.v).filter(Boolean);
      const pages = nd.pages.map((p, i) => ({ photos: p.imgs.map((d, k) => ({ name: `note-${Date.now()}-${i}-${k}.jpg`, type: "image/jpeg", data: d.split(",")[1] })) }));
      const total = pages.reduce((n, p) => n + p.photos.length, 0);
      if (total > 8) return toast("照片最多 8 張");
      const title = $("n-title").value.trim() || (texts[0] || "照片筆記").split("\n")[0].slice(0, 30);
      await api("/api/note", { title, subject: $("n-subject").value, points: texts.join("\n"), pages });
      nd.pages = []; nd.cur = []; nd.sel = -1; $("n-title").value = ""; ndSave(); ndRender();
    }, "筆記已送出");

    // ---------- focus timer ----------
    const fc = { st: null, off: 0, mode: "total", busy: false };
    const fmtHMS = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
    const fmtHM = (s) => `${Math.floor(s / 3600)}時${String(Math.floor(s / 60) % 60).padStart(2, "0")}分`;
    const fmtFull = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 86400)}天 ${Math.floor(s / 3600) % 24}時 ${Math.floor(s / 60) % 60}分 ${s % 60}秒`; };
    const segSec = () => { const a = fc.st?.active; if (!a) return 0; const st0 = fc.anchor && fc.anchor.id === a.id && a.acc < 5 ? fc.anchor.start : a.start; return Math.max(0, a.acc + (a.status === "進行中" && st0 ? (Date.now() + fc.off - st0) / 1000 : 0)); };
    const totalSec = () => (fc.st?.todayDoneSec || 0) + segSec();
    function fcRender() {
      const a = fc.st?.active, running = a?.status === "進行中";
      const selected = a?.subject;
      const collapsed = !!selected && C.SUBJECTS.includes(selected);
      $("fc-subj").dataset.collapsed = String(collapsed);
      $("fc-subj").setAttribute("aria-label", collapsed ? `${selected}；點選結束計時` : "選擇計時科目");
      const t = fc.mode === "total" ? totalSec() : segSec();
      $("focus").classList.toggle("is-running", !!running);
      $("fc-time").textContent = fmtHMS(t);
      $("fc-time").classList.toggle("run", !!running);
      const by = {};
      (fc.st?.sessions || []).forEach((x) => { const k = x.subject || "其他"; by[k] = (by[k] || 0) + x.acc; });
      if (a) { const k = a.subject || "其他"; by[k] = (by[k] || 0) + segSec(); }
      document.querySelectorAll("#fc-subj button").forEach((b) => {
        const k = b.dataset.s;
        b.hidden = collapsed && k !== selected;
        b.classList.toggle("on", !!a && (a.subject || "其他") === k);
        b.classList.toggle("run", !!running && (a.subject || "其他") === k);
        b.setAttribute("aria-pressed", String(!!a && (a.subject || "其他") === k));
        b.querySelector("i").textContent = by[k] ? fmtHM(by[k]) : "";
        b.title = collapsed ? "點選結束計時" : by[k] ? `${k} ${fmtHM(by[k])}` : k;
        b.setAttribute("aria-label", collapsed ? `${k}，點選結束計時` : `${k}，開始計時`);
      });
      $("fc-sub").textContent = a ? (running ? "進行中" : "已暫停") : "尚未開始";
      const assigned = (state.tasks || []).filter((x) => x.source === "今日" && !x.skipped).length;
      const goalH = Math.min(10, Math.max(3, 3 + assigned * 0.5)), pct = Math.round(totalSec() / (goalH * 3600) * 100);
      $("fc-prog-i").style.width = Math.min(100, pct) + "%"; $("fc-prog-i").parentNode.classList.toggle("over", pct > 100);
      $("fc-goal-t").textContent = `目標 ${goalH} 時　${pct}%`;
      document.title = running ? `${fmtHMS(t)} 專注 ${a.subject || "其他"}` : "清大後醫";
    }
    async function fcLoad() {
      if (fc.busy) return; try { const d = await api("/api/focus"); const pn = fc.pin; if (pn && Date.now() < pn.until && ((d.active ? d.active.id : null) !== pn.id || (d.active ? d.active.status : null) !== pn.status)) return; fc.st = d; fc.off = d.now - Date.now(); fcRender(); fcSyncYpt(); } catch (e) { /* offline or not deployed */ }
    }
    async function fcAct(body) {
      if (fc.busy) return; fc.busy = true;
      const clickAt = Date.now() + fc.off;
      if (body.action !== "switch" && body.action !== "start") fc.anchor = null;
      if ((body.action === "switch" || body.action === "start") && fc.st) { // optimistic: zero immediately, previous segment folded into today's total
        const p = fc.st.active, prev = p ? segSec() : 0;
        fc.st = { ...fc.st, todayDoneSec: (fc.st.todayDoneSec || 0) + prev, sessions: [...(fc.st.sessions || []), ...(p ? [{ ...p, acc: Math.round(prev), status: "完成" }] : [])], active: { id: "local", subject: body.subject, acc: 0, start: clickAt, status: "進行中" } };
        fc.anchor = { id: "local", start: clickAt }; fcRender();
      }
      try { const d = await api("/api/focus", body); if (body.action === "switch" || body.action === "start") fc.anchor = d.active ? { id: d.active.id, start: clickAt } : null; fc.st = d; fc.off = d.now - Date.now(); fc.pin = { id: d.active ? d.active.id : null, status: d.active ? d.active.status : null, until: Date.now() + 40000 }; fcRender(); }
      catch (e) { fc.anchor = null; setTimeout(fcLoad, 300); toast("無法連線：" + (e.message || "")); } finally { fc.busy = false; }
    }
    $("fc-subj").onclick = async (e) => {
      const b = e.target.closest("button"); if (!b) return; const s = b.dataset.s, a = fc.st?.active;
      if (!a) return fcAct({ action: "start", subject: s });
      if ((a.subject || "其他") === s) return fcAct({ action: "stop" }).then(() => { toast("已記錄這一段"); fcSyncYpt(); });
      fcAct({ action: "switch", subject: s });
    };
    async function fcSyncYpt(force) {
      const t = fc.st?.todayDoneSec || 0; if (fc.st?.active || (!t && !force)) return;
      const h = Math.floor(t / 3600), m = Math.round((t % 3600) / 60);
      if (state.record && state.record.hours === h && state.record.minutes === m) return;
      try { state.record = await api("/api/record", { hours: h, minutes: m }); renderRecord(); } catch (e) {}
    }
    const fcToggleMode = () => { fc.mode = fc.mode === "total" ? "seg" : "total"; fcRender(); };
    $("fc-mode").onclick = fcToggleMode;
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
