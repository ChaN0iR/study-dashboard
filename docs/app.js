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
    return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m`;
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
        if ("心得" in body) r.review = body["心得"]; if ("重點" in body) r.points = body["重點"]; if ("心情" in body) r.mood = body["心情"];
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
    if (slot) {
      const open = state.tasks.filter((t) => !t.done && !t.skipped);
      const fit = open.filter((t) => slot.keys.some((k) => t.title.toLowerCase().includes(k.toLowerCase())));
      box.append(el("div", { class: "sub" }, "可搭配任務"));
      if (fit.length) box.append(el("ul", { class: "list" }, fit.map((t) => taskItem(t))));
      else box.append(el("div", { class: "empty" }, "這個時段沒有對應任務"));
    }
  }

  const shortTitle = (s) => String(s || "").replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, "").replace(/[（(][^）)]*[）)]/g, "").replace(/｜.*$/, "").replace(/\s+/g, " ").trim();
  function taskItem(t) {
    return el("li", { class: "item" + (t.done ? " done" : "") },
      el("button", { class: "chk", role: "checkbox", "aria-checked": String(t.done), "aria-label": "完成", onclick: () => toggleTask(t) }),
      el("div", { class: "t", title: t.title }, shortTitle(t.title), t.source !== "今日" ? el("span", { class: "tag" }, t.source) : null),
      t.skipped ? el("button", { class: "ghost", onclick: () => skipTask(t, false) }, "恢復")
        : t.done ? null : el("button", { class: "ghost", onclick: () => skipTask(t, true) }, "跳過"));
  }

  function renderTasks() {
    const real = state.tasks.filter((t) => !t.skipped).sort((a, b) => a.done - b.done || a.order - b.order);
    const skipped = state.tasks.filter((t) => t.skipped);
    const assigned = state.tasks.filter((t) => t.source === "今日" && !t.skipped);
    $("task-count").textContent = assigned.length ? `${assigned.filter((t) => t.done).length}/${assigned.length}` : "";
    $("tasks").replaceChildren(...(real.length ? real.map(taskItem) : [el("li", { class: "empty" }, "今天沒有任務")]));
    $("skipped-wrap").hidden = !skipped.length;
    $("skipped").replaceChildren(...skipped.map(taskItem));
  }

  function renderRecord() {
    const r = state.record || {};
    if (document.activeElement?.closest?.("#f-hours,#f-minutes,#f-review,#f-workout,#f-points") == null) {
      $("f-hours").value = r.hours ?? ""; $("f-minutes").value = r.minutes ?? "";
      $("f-review").value = r.review || ""; $("f-workout").value = r.workout ?? localStorage.getItem("sd-workout-" + (r.date || "")) ?? ""; $("f-points").value = r.points || "";
    }
    mood = r.mood || null; renderMoods(); updateTotal();
    $("completion").textContent = r.completion || "";
  }
  function renderMoods() {
    $("moods").replaceChildren(...C.MOODS.map((m) => el("button", {
      role: "radio", "aria-checked": String(mood === m), type: "button",
      onclick: () => { mood = mood === m ? null : m; renderMoods(); },
    }, m)));
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
          el("button", { class: "chk", role: "checkbox", "aria-checked": String(l.done), "aria-label": "完成", onclick: () => toggleLesson(l) }),
          el("div", { class: "t" }, l.title,
            el("div", { class: "meta" }, [l.subject, l.minutes ? `${l.minutes} 分` : null, l.due ? "該複習" : null].filter(Boolean).join("　"))),
          null)));
    });
    $("lessons").replaceChildren(...rows);
  }

  function renderAll() {
    $("date").textContent = `${state.today || taipeiNow().date}　${taipeiNow().wd}`;
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
      el2.textContent = days > 0 ? `　倒數 ${days} 天` : days === 0 ? "　今天考試" : "";
    })();
    
    ankiBadge();
    $("ypt-link").addEventListener("click", (e) => {
      e.preventDefault();
      if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "")) { window.open("https://www.yeolpumta.com/", "_blank", "noopener"); return; }
      location.href = "https://link.yeolpumta.com/";
    });
    $("anki-link").addEventListener("click", (e) => {
      e.preventDefault();
      const ua = navigator.userAgent || "";
      const web = "https://ankiweb.net/decks";
      if (/iPhone|iPad|iPod/i.test(ua)) { location.href = "anki://x-callback-url/sync"; }
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
    $("reset-key").onclick = (e) => {
      e.preventDefault();
      const u = prompt("Worker 網址（留空保持不變）", apiBase()); if (u) localStorage.setItem("apiBase", u.trim());
      localStorage.removeItem("appKey"); Promise.resolve(load()).finally(() => toast("重置成功"));
    };
    $("save-record").onclick = () => guarded(async () => {
      const num = (id) => ($(id).value === "" ? null : Number($(id).value));
      state.record = await api("/api/record", {
        hours: num("f-hours"), minutes: num("f-minutes"),
        "心得": $("f-review").value, "運動": $("f-workout").value, "重點": $("f-points").value, "心情": mood || "",
      });
      renderRecord();
    }, "已儲存");
    $("save-note").onclick = () => guarded(async () => {
      const title = $("n-title").value.trim(); if (!title) return toast("請輸入標題");
      await api("/api/note", { title, subject: $("n-subject").value, points: $("n-points").value });
      $("n-title").value = ""; $("n-points").value = "";
    }, "筆記已新增");
    load();
    setInterval(() => { renderNow(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  init();
})();
