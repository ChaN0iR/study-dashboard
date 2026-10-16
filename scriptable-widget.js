// 讀書儀表板 Widget (Scriptable)
const API = "https://study-dashboard-api.tw-ching.workers.dev";
const APP = "https://chan0ir.github.io/study-dashboard/";
const KEYS = {"Anki＋單字":["anki","單字","生字"],"早餐整理":["早餐"],"化學":["化學","普化","有機"],"午餐":["午餐"],"生物／生化":["生物","生化"],"肌酸":["肌酸"],"物理":["物理"],"重量訓練＋洗澡":["重量訓練","健身","重訓","洗澡","步數"],"晚餐＋蛋白粉":["晚餐","蛋白粉"],"英文文章＋錯題":["英文","錯題"],"洗澡／簡單清潔":["洗澡","清潔"],"錯題":["錯題"],"YPT・步數・心情・重點回顧":["ypt","心情","重點"],"收尾＋甘胺酸鎂":["收尾","甘胺酸","睡前","回顧"]};
const SCHEDULE = [
["07:00","07:45","Anki＋單字"],["07:45","08:30","早餐整理"],["08:30","12:00","化學"],["12:00","13:30","午餐"],
["13:30","15:30","生物／生化"],["15:30","15:45","肌酸"],["15:45","16:30","物理"],["16:30","17:30","重量訓練＋洗澡"],
["17:30","19:00","晚餐＋蛋白粉"],["19:00","20:00","英文文章＋錯題"],["20:00","20:30","洗澡／簡單清潔"],["20:30","20:45","錯題"],
["20:45","21:00","YPT・步數・心情・重點回顧"],["21:00","22:00","收尾＋甘胺酸鎂"]];

const KEY_NAME = "study_app_key";
if (!Keychain.contains(KEY_NAME)) {
  const a = new Alert(); a.title = "輸入 APP_KEY"; a.addSecureTextField("APP_KEY");
  a.addAction("儲存"); await a.present();
  Keychain.set(KEY_NAME, a.textFieldValue(0));
}
const key = Keychain.get(KEY_NAME);

const FAM = config.widgetFamily || "";
if (FAM.startsWith("accessory")) {
  let f = null;
  try { const r = new Request(API + "/api/focus"); r.headers = { "x-app-key": key }; r.timeoutInterval = 8; f = await r.loadJSON(); } catch (e) {}
  const lw = new ListWidget(); lw.url = APP; lw.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const la = f && f.active, lrun = !!la && la.status === "進行中";
  const sec = la ? Math.max(0, la.acc + (lrun ? (f.now - la.start) / 1000 : 0)) : 0;
  const hms = x => { x = Math.floor(x); const h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, s2 = x % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s2).padStart(2, "0"); };
  const put = (parent, size) => {
    if (lrun) { const t = parent.addDate(new Date(Date.now() - sec * 1000)); t.applyTimerStyle(); t.font = Font.boldMonospacedSystemFont(size); t.minimumScaleFactor = 0.5; t.lineLimit = 1; return t; }
    const t = parent.addText(la ? hms(sec) : "--:--"); t.font = Font.boldMonospacedSystemFont(size); t.minimumScaleFactor = 0.5; t.lineLimit = 1; return t;
  };
  if (FAM === "accessoryInline") { const t = put(lw, 14); }
  else if (FAM === "accessoryCircular") { const st2 = lw.addStack(); st2.layoutVertically(); st2.centerAlignContent(); const t = put(st2, 14); t.centerAlignText(); }
  else {
    if (la && la.subject) { const h = lw.addText(la.subject + (lrun ? "" : "　暫停")); h.font = Font.systemFont(12); }
    const t = put(lw, 30);
  }
  Script.setWidget(lw); Script.complete(); return;
}

let st = null, err = null;
try {
  const r = new Request(API + "/api/state");
  r.headers = { "x-app-key": key };
  st = await r.loadJSON();
  if (st.error) throw new Error(st.error);
  FileManager.local().writeString(FileManager.local().joinPath(FileManager.local().documentsDirectory(), "study_cache.json"), JSON.stringify(st));
} catch (e) {
  err = e.message;
  const fm = FileManager.local(), p = fm.joinPath(fm.documentsDirectory(), "study_cache.json");
  if (fm.fileExists(p)) st = JSON.parse(fm.readString(p));
}

const w = new ListWidget();
w.url = APP;
w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);

// 以台北時間計算現在時段
const tp = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
const nowMin = tp.getHours() * 60 + tp.getMinutes();
const tm = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

if (!st) {
  w.backgroundColor = new Color("#111111");
  const t = w.addText("無法讀取"); t.textColor = Color.white(); t.font = Font.boldSystemFont(14);
  const s = w.addText(err || ""); s.textColor = Color.gray(); s.font = Font.systemFont(10);
  if (config.runsInApp) await w.presentMedium(); Script.setWidget(w); Script.complete(); return;
}

const tasks = (st.tasks || []).filter(t => !t.skipped);
const done = tasks.filter(t => t.done).length, total = tasks.length;
const pct = total ? done / total : 0;
const open = tasks.filter(t => !t.done).sort((a, b) => (a.order || 0) - (b.order || 0));
const isRest = [0, 4].includes(tp.getDay());
if (isRest) { const k = SCHEDULE.find(x => x[2] === "重量訓練＋洗澡"); if (k) k[2] = "輕度運動"; KEYS["輕度運動"] = ["運動", "步數", "散步"]; }
const cur = SCHEDULE.find(s => nowMin >= tm(s[0]) && nowMin < tm(s[1]));
const nxt = SCHEDULE.find(s => tm(s[0]) > nowMin);

// 依進度改變型態
let mode, bg, fg, label;
if (total && pct >= 1) { mode = "done"; bg = "#F5F5F5"; fg = "#111111"; label = "今日完成"; }
else if (pct >= 0.7) { mode = "final"; bg = "#1C1C1E"; fg = "#FFFFFF"; label = "收尾"; }
else if (pct >= 0.3) { mode = "mid"; bg = "#111111"; fg = "#E5E5E5"; label = "進行中"; }
else { mode = "start"; bg = "#000000"; fg = "#BDBDBD"; label = "起步"; }
const hour = tp.getHours();
if (mode !== "done" && hour >= 21) label += "　接近就寢";
w.backgroundColor = new Color(bg);
const fc = new Color(fg), muted = new Color(fg, 0.55);

function ring(p, size) {
  const c = new DrawContext(); c.size = new Size(size, size); c.opaque = false; c.respectScreenScale = true;
  const lw = size * 0.11, r = size / 2 - lw;
  const cx = size / 2, cy = size / 2;
  c.setLineWidth(lw);
  c.setStrokeColor(new Color(fg, 0.18));
  const bgp = new Path(); bgp.addEllipse(new Rect(lw, lw, size - 2 * lw, size - 2 * lw)); c.addPath(bgp); c.strokePath();
  c.setStrokeColor(new Color(fg));
  const n = Math.max(0, Math.round(p * 120));
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / 120) * 2 * Math.PI;
    const dot = new Path();
    dot.addEllipse(new Rect(cx + r * Math.cos(a) - lw / 2, cy + r * Math.sin(a) - lw / 2, lw, lw));
    c.addPath(dot); c.setFillColor(new Color(fg)); c.fillPath();
  }
  c.setTextAlignedCenter(); c.setTextColor(new Color(fg)); c.setFont(Font.boldSystemFont(size * 0.24));
  c.drawTextInRect(Math.round(p * 100) + "%", new Rect(0, size * 0.36, size, size * 0.3));
  return c.getImage();
}
function bar(p, width) {
  const blocks = 12, f = Math.round(p * blocks);
  return "▪".repeat(f) + "◦".repeat(blocks - f);
}

const fam = config.widgetFamily || "medium";
w.setPadding(14, 14, 14, 14);
const keys = cur ? (KEYS[cur[2]] || []) : [];
const fit = cur ? open.filter(t => keys.some(k => t.title.toLowerCase().includes(k.toLowerCase()))) : [];
const rest = open.filter(t => !fit.includes(t));
const left = cur ? tm(cur[1]) - nowMin : 0;
const mainTitle = cur ? cur[2] : (nxt ? "下一段　" + nxt[2] : (nowMin < 420 ? "尚未開始" : "今天結束"));
const sub = cur ? `${cur[0]}–${cur[1]}　剩 ${left} 分` : (nxt ? `${nxt[0]} 開始` : "");
const doNow = fit.length ? fit : (mode === "done" ? [] : rest.slice(0, 2));
const GAP = fam === "small" ? 4 : (fam === "medium" ? 6 : 9);
let T = w, R = null;
if (fam !== "small") { const H = w.addStack(); H.layoutHorizontally(); T = H.addStack(); T.layoutVertically(); H.addSpacer(); R = H.addStack(); R.layoutVertically(); }
let leftEst = 0;
const vlen = (t) => [...t].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.55), 0);
function line(txt, size, color, bold) { leftEst = Math.max(leftEst, vlen(txt) * size); const x = T.addText(txt); x.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size); x.textColor = color; x.lineLimit = 1; x.minimumScaleFactor = 0.7; T.addSpacer(GAP); return x; }

if (fam === "small") {
  line(sub, 10, muted);
  const m = line(mainTitle, 17, fc, true); m.minimumScaleFactor = 0.6;
  T.addSpacer(6);
  doNow.slice(0, 3).forEach(t => { const x = line("○ " + t.title, 11, fc); x.lineLimit = 2;  });
  T.addSpacer();
  line(`${Math.round(pct * 100)}%　${done}/${total}`, 10, muted);
} else if (fam === "large") {
  line(sub, 12, muted);
  const m = line(mainTitle, 26, fc, true); m.minimumScaleFactor = 0.6;
  T.addSpacer(8);
  line("現在做", 11, muted);
  doNow.slice(0, 5).forEach(t => { const x = line("○ " + t.title, 15, fc); x.lineLimit = 2;  });
  if (!doNow.length) line(mode === "done" ? "今天的任務都完成了" : "這個時段沒有指定任務", 14, fc);
  T.addSpacer(8);
  if (nxt && cur) line(`接著　${nxt[0]}　${nxt[2]}`, 12, muted);
  T.addSpacer(6);
  line("其他未完成", 11, muted);
  rest.slice(0, 5).forEach(t => line("○ " + t.title, 12, muted));
  T.addSpacer();
  line(`${label}　${bar(pct)}　${done}/${total}`, 11, muted);
} else {
  line(sub, 11, muted);
  const m = line(mainTitle, 22, fc, true); m.minimumScaleFactor = 0.6;
  T.addSpacer(4);
  doNow.slice(0, 2).forEach(t => line("○ " + t.title, 13, fc));
  if (!doNow.length) line(mode === "done" ? "今天的任務都完成了" : "這個時段沒有指定任務", 12, fc);
  T.addSpacer();
  line(`${nxt && cur ? "接著 " + nxt[0] + " " + nxt[2] + "　" : ""}${Math.round(pct * 100)}%　${done}/${total}`, 10, muted);
}
try {
  const fr = new Request(API + "/api/focus"); fr.headers = { "x-app-key": key };
  const f = await fr.loadJSON();
  const a = f.active, running = a && a.status === "進行中";
  const hms = x => { x = Math.floor(x); const h = Math.floor(x / 3600), m = Math.floor(x / 60) % 60, s2 = x % 60; if (!h && !m) return s2 + "秒"; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s2).padStart(2, "0"); };
  const segS = a ? Math.max(0, a.acc + (running ? (f.now - a.start) / 1000 : 0)) : 0;
  const todayS = f.todayDoneSec + segS;
  // 有科目在計時：大字顯示該科目本段；沒有則顯示今日總計
  const bigSec = a ? segS : todayS, label = a ? (a.subject || "專注") + (running ? "" : "　暫停") : "今日";
  const big = fam === "small" ? 20 : 26;
  let box = w;
  if (R) { box = R; { const CW = 300, lw2 = Math.min(leftEst, CW * 0.62), rw = Math.max(84, Math.min(150, CW - lw2 - 8)); R.size = new Size(rw, fam === "large" ? 280 : 125); } R.addSpacer(); }
  else { box = w.addStack(); box.layoutVertically(); }
  const al = x => { if (R) x.rightAlignText(); };
  const lb = box.addText(label); lb.font = Font.boldSystemFont(13); lb.textColor = muted; lb.lineLimit = 1; al(lb);
  if (R) R.addSpacer();
  if (running) { const t = box.addDate(new Date(Date.now() - bigSec * 1000)); t.applyTimerStyle(); t.font = Font.boldMonospacedSystemFont(big); t.textColor = fc; t.minimumScaleFactor = 0.4; t.lineLimit = 1; al(t); }
  else { const t = box.addText(hms(bigSec)); t.font = Font.boldMonospacedSystemFont(big); t.textColor = a ? muted : fc; t.minimumScaleFactor = 0.4; t.lineLimit = 1; al(t); }
  if (R) R.addSpacer();
  if (a) { const d = box.addText("今日 " + hms(todayS)); d.font = Font.systemFont(12); d.textColor = muted; al(d); }
  else { const d = box.addText("尚未計時"); d.font = Font.systemFont(12); d.textColor = muted; al(d); }
  if (R) R.addSpacer();
} catch (e) {}
if (err) { const e = w.addText("離線資料"); e.font = Font.systemFont(9); e.textColor = muted; }

if (config.runsInApp) await w.presentMedium();
Script.setWidget(w);
Script.complete();
