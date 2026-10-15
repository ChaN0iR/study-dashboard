// 讀書儀表板 Widget (Scriptable)
const API = "https://study-dashboard-api.tw-ching.workers.dev";
const APP = "https://chan0ir.github.io/study-dashboard/";
const SCHEDULE = [
["07:00","07:45","Anki＋單字"],["07:45","08:30","早餐整理"],["08:30","12:00","化學"],["12:00","13:30","午餐"],
["13:30","15:30","生物／生化"],["15:30","15:45","練前餐＋肌酸"],["15:45","16:30","物理"],["16:30","17:30","健身＋沖涼"],
["17:30","19:00","晚餐"],["19:00","20:00","英文文章＋錯題"],["20:00","20:30","洗澡"],["20:30","20:45","錯題"],
["20:45","21:00","填 YPT／心得／重點"],["21:00","22:45","收尾＋甘胺酸鎂"]];

const KEY_NAME = "study_app_key";
if (!Keychain.contains(KEY_NAME)) {
  const a = new Alert(); a.title = "輸入 APP_KEY"; a.addSecureTextField("APP_KEY");
  a.addAction("儲存"); await a.present();
  Keychain.set(KEY_NAME, a.textFieldValue(0));
}
const key = Keychain.get(KEY_NAME);

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
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

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

if (fam === "small") {
  const img = w.addImage(ring(pct, 90)); img.imageSize = new Size(90, 90); img.centerAlignImage();
  w.addSpacer(6);
  const t = w.addText(`${done}/${total}　${label}`); t.font = Font.semiboldSystemFont(12); t.textColor = fc; t.centerAlignText();
} else if (fam === "large") {
  const h = w.addStack(); h.centerAlignContent();
  const img = h.addImage(ring(pct, 70)); img.imageSize = new Size(70, 70);
  h.addSpacer(12);
  const v = h.addStack(); v.layoutVertically();
  const a = v.addText(label); a.font = Font.boldSystemFont(18); a.textColor = fc;
  const b = v.addText(`${done}/${total} 項　${bar(pct)}`); b.font = Font.systemFont(11); b.textColor = muted;
  const c = v.addText(cur ? `${cur[0]}　${cur[2]}` : (nxt ? `下一段 ${nxt[0]} ${nxt[2]}` : "今天結束")); c.font = Font.systemFont(12); c.textColor = muted;
  w.addSpacer(10);
  if (mode === "done") { const d = w.addText("今天的任務都完成了"); d.font = Font.systemFont(14); d.textColor = fc; }
  open.slice(0, 10).forEach(t => { const x = w.addText("○ " + t.title); x.font = Font.systemFont(13); x.textColor = fc; x.lineLimit = 1; w.addSpacer(3); });
  if (open.length > 10) { const m = w.addText(`… 還有 ${open.length - 10} 項`); m.font = Font.systemFont(11); m.textColor = muted; }
  w.addSpacer();
} else {
  const row = w.addStack(); row.centerAlignContent();
  const img = row.addImage(ring(pct, 84)); img.imageSize = new Size(84, 84);
  row.addSpacer(14);
  const v = row.addStack(); v.layoutVertically();
  const a = v.addText(`${label}　${done}/${total}`); a.font = Font.boldSystemFont(16); a.textColor = fc;
  const b = v.addText(cur ? `${cur[0]}–${cur[1]}　${cur[2]}` : (nxt ? `下一段 ${nxt[0]} ${nxt[2]}` : "今天結束")); b.font = Font.systemFont(11); b.textColor = muted; b.lineLimit = 1;
  v.addSpacer(6);
  if (mode === "done") { const d = v.addText("全部完成"); d.font = Font.systemFont(13); d.textColor = fc; }
  else open.slice(0, 3).forEach(t => { const x = v.addText("○ " + t.title); x.font = Font.systemFont(12); x.textColor = fc; x.lineLimit = 1; });
}
if (err) { const e = w.addText("離線資料"); e.font = Font.systemFont(9); e.textColor = muted; }

if (config.runsInApp) await w.presentMedium();
Script.setWidget(w);
Script.complete();
