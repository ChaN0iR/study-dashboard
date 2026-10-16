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
  try { const r = new Request(API + "/api/focus"); r.headers = { "x-app-key": key }; f = await r.loadJSON(); } catch (e) {}
  const lw = new ListWidget(); lw.url = APP; lw.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  const la = f && f.active, lrun = la && la.status === "進行中";
  const ltotal = f ? f.todayDoneSec + (la ? la.acc + (lrun ? (f.now - la.start) / 1000 : 0) : 0) : 0;
  const lhm = x => Math.floor(x / 3600) + "h" + String(Math.floor(x / 60) % 60).padStart(2, "0");
  const ltimer = (p, size) => { if (lrun) { const t = p.addDate(new Date(Date.now() - ltotal * 1000)); t.applyTimerStyle(); t.font = Font.boldMonospacedSystemFont(size); return t; } const t = p.addText(f ? lhm(ltotal) : "--"); t.font = Font.boldMonospacedSystemFont(size); return t; };
  if (FAM === "accessoryInline") lw.addText("專注 " + (f ? lhm(ltotal) : "--") + (lrun ? " ▶" : ""));
  else if (FAM === "accessoryCircular") { const t = ltimer(lw, 13); t.centerAlignText(); }
  else { const h = lw.addText(la ? (la.subject || "專注") + (lrun ? "　進行中" : "　暫停") : "今日專注"); h.font = Font.systemFont(11); ltimer(lw, 26); const d = lw.addText("今日 " + (f ? lhm(ltotal) : "--")); d.font = Font.systemFont(11); }
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
function line(txt, size, color, bold) { const x = w.addText(txt); x.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size); x.textColor = color; x.lineLimit = 1; w.addSpacer(GAP); return x; }

if (fam === "small") {
  line(sub, 10, muted);
  const m = line(mainTitle, 17, fc, true); m.minimumScaleFactor = 0.6;
  w.addSpacer(6);
  doNow.slice(0, 3).forEach(t => { const x = line("○ " + t.title, 11, fc); x.lineLimit = 2;  });
  w.addSpacer();
  line(`${Math.round(pct * 100)}%　${done}/${total}`, 10, muted);
} else if (fam === "large") {
  line(sub, 12, muted);
  const m = line(mainTitle, 26, fc, true); m.minimumScaleFactor = 0.6;
  w.addSpacer(8);
  line("現在做", 11, muted);
  doNow.slice(0, 5).forEach(t => { const x = line("○ " + t.title, 15, fc); x.lineLimit = 2;  });
  if (!doNow.length) line(mode === "done" ? "今天的任務都完成了" : "這個時段沒有指定任務", 14, fc);
  w.addSpacer(8);
  if (nxt && cur) line(`接著　${nxt[0]}　${nxt[2]}`, 12, muted);
  w.addSpacer(6);
  line("其他未完成", 11, muted);
  rest.slice(0, 5).forEach(t => line("○ " + t.title, 12, muted));
  w.addSpacer();
  line(`${label}　${bar(pct)}　${done}/${total}`, 11, muted);
} else {
  line(sub, 11, muted);
  const m = line(mainTitle, 22, fc, true); m.minimumScaleFactor = 0.6;
  w.addSpacer(4);
  doNow.slice(0, 2).forEach(t => line("○ " + t.title, 13, fc));
  if (!doNow.length) line(mode === "done" ? "今天的任務都完成了" : "這個時段沒有指定任務", 12, fc);
  w.addSpacer();
  line(`${nxt && cur ? "接著 " + nxt[0] + " " + nxt[2] + "　" : ""}${Math.round(pct * 100)}%　${done}/${total}`, 10, muted);
}
try {
  const fr = new Request(API + "/api/focus"); fr.headers = { "x-app-key": key };
  const f = await fr.loadJSON();
  const a = f.active, hms = x => { x = Math.floor(x); return Math.floor(x / 3600) + ":" + String(Math.floor(x / 60) % 60).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
  const running = a && a.status === "進行中";
  const seg = a ? a.acc + (running ? (f.now - a.start) / 1000 : 0) : 0;
  const total = f.todayDoneSec + seg;
  const big = fam === "small" ? 18 : 24;
  const row = w.addStack(); row.layoutHorizontally(); row.centerAlignContent();
  const lb = row.addText((a ? (a.subject || "專注") : "今日專注") + "　"); lb.font = Font.systemFont(11); lb.textColor = muted;
  if (running) { const t = row.addDate(new Date(Date.now() - total * 1000)); t.applyTimerStyle(); t.font = Font.boldMonospacedSystemFont(big); t.textColor = fc; }
  else { const t = row.addText(hms(total)); t.font = Font.boldMonospacedSystemFont(big); t.textColor = a ? muted : fc; }
  if (a && !running) { const p = row.addText("　暫停"); p.font = Font.systemFont(10); p.textColor = muted; }
} catch (e) {}
if (err) { const e = w.addText("離線資料"); e.font = Font.systemFont(9); e.textColor = muted; }

if (config.runsInApp) await w.presentMedium();
Script.setWidget(w);
Script.complete();
