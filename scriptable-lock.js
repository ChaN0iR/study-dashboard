// 專注計時 鎖定畫面小工具 (Scriptable)，獨立腳本，不影響原本小工具
const API = "https://study-dashboard-api.tw-ching.workers.dev";
const key = Keychain.contains("study_app_key") ? Keychain.get("study_app_key") : "";
let f = null;
try { const r = new Request(API + "/api/focus"); r.headers = { "x-app-key": key }; f = await r.loadJSON(); } catch (e) {}
const w = new ListWidget(); w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
const fam = config.widgetFamily || "accessoryRectangular";
const a = f && f.active, running = a && a.status === "進行中";
const seg = a ? a.acc + (running ? (f.now - a.start) / 1000 : 0) : 0;
const total = f ? f.todayDoneSec + seg : 0;
const hm = x => Math.floor(x / 3600) + "h" + String(Math.floor(x / 60) % 60).padStart(2, "0");
function timer(parent, size) {
  if (running) { const t = parent.addDate(new Date(Date.now() - total * 1000)); t.applyTimerStyle(); t.font = Font.boldMonospacedSystemFont(size); return t; }
  const t = parent.addText(f ? hm(total) : "--"); t.font = Font.boldMonospacedSystemFont(size); return t;
}
if (fam === "accessoryInline") { const t = w.addText("專注 " + (f ? hm(total) : "--") + (running ? " ▶" : "")); }
else if (fam === "accessoryCircular") { w.addAccessoryWidgetBackground = true; const t = timer(w, 13); t.centerAlignText(); }
else { const s = w.addText(a ? (a.subject || "專注") + (running ? "　進行中" : "　暫停") : "今日專注"); s.font = Font.systemFont(11); timer(w, 26); const d = w.addText("今日 " + (f ? hm(total) : "--")); d.font = Font.systemFont(11); }
if (config.runsInWidget) Script.setWidget(w); else await w.presentAccessoryRectangular();
Script.complete();
