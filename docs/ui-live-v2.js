// Opt-in, read-only adapter over the *existing rendered* Study Dashboard.
// No second task store, focus timer, API client or persistent preference.
export function mountLiveV2() {
  if (document.querySelector("#sd-v2-live")) return;
  const originalNow = document.querySelector("#now");
  const tasks = document.querySelector("#tasks");
  const count = document.querySelector("#task-count");
  if (!originalNow || !tasks || !count) return;

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = new URL("./ui-live-v2.css?v=1", import.meta.url).href;
  document.head.append(style);
  document.body.classList.add("sd-v2-live");

  const hero = document.createElement("section");
  hero.id = "sd-v2-live";
  hero.className = "card sd-v2-hero";
  hero.dataset.tab = "today";
  hero.setAttribute("aria-label", "下一個學習目標");
  // All markup is static; task titles are written only via textContent.
  hero.innerHTML = [
    '<div class="sd-v2-head">',
    '<span class="sd-v2-eyebrow">STUDY · 下一個行動</span>',
    '<a class="sd-v2-switch" href="#" id="sd-v2-original">返回原版</a>',
    '</div>',
    '<div class="sd-v2-subject" id="sd-v2-subject">正在讀取任務</div>',
    '<h2 class="sd-v2-title" id="sd-v2-title" aria-live="polite">讀取中</h2>',
    '<p class="sd-v2-description" id="sd-v2-description">沿用目前的任務排序、驗證與同步機制</p>',
    '<div class="sd-v2-foot">',
    '<div class="sd-v2-progress">',
    '<span id="sd-v2-count" aria-live="off">等待資料</span>',
    '<span class="sd-v2-track" aria-hidden="true"><i id="sd-v2-progress-bar"></i></span>',
    '</div>',
    '<div class="sd-v2-actions">',
    '<button type="button" id="sd-v2-task" disabled>查看任務</button>',
    '<button type="button" id="sd-v2-focus">前往專注計時</button>',
    '</div></div>'
  ].join("");
  originalNow.before(hero);

  const $ = (selector) => hero.querySelector(selector);
  const title = $("#sd-v2-title");
  const subject = $("#sd-v2-subject");
  const description = $("#sd-v2-description");
  const progress = $("#sd-v2-count");
  const bar = $("#sd-v2-progress-bar");
  const taskButton = $("#sd-v2-task");

  const normalUrl = new URL(window.location.href);
  normalUrl.searchParams.delete("ui");
  $("#sd-v2-original").href = normalUrl.href;

  const getRows = () => Array.from(tasks.querySelectorAll(".task-item"));
  const isComplete = (row) => row.classList.contains("done") ||
    row.querySelector(".chk")?.getAttribute("aria-checked") === "true";
  const available = (row) => !isComplete(row) &&
    !row.classList.contains("blocked") &&
    row.querySelector(".chk:not([disabled])") !== null;

  const render = () => {
    const raw = count.textContent.trim();
    const match = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
    const rows = getRows();
    const taipeiDate = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    const renderedDate = document.querySelector("#date .dl")?.textContent.trim() || "";
    const dataUnavailable = !match || !document.querySelector("#banner")?.hidden ||
      !renderedDate.startsWith(taipeiDate);
    const done = match ? Number(match[1]) : 0;
    const total = match ? Number(match[2]) : 0;
    const pending = rows.some((row) => !row.classList.contains("blocked") &&
      row.querySelector(".chk:disabled") !== null);
    const next = dataUnavailable ? null : rows.find(available);

    hero.classList.toggle("sd-v2-unverified", dataUnavailable);
    hero.classList.toggle("sd-v2-complete", !next && !dataUnavailable && done === total);
    progress.textContent = dataUnavailable ? "尚未取得可靠任務資料" :
      (new URLSearchParams(window.location.search).get("demo") === "1" ? "示範資料 · " : "") +
      done + " / " + total + (pending ? " · 更新中（未確認）" : " 已完成");
    bar.style.width = match && total ? Math.min(100, Math.max(0, done / total * 100)) + "%" : "0%";
    taskButton.disabled = !next;

    if (dataUnavailable) {
      subject.textContent = "同步狀態 · 未驗證";
      title.textContent = "目前無法確認下一項任務";
      description.textContent = "請檢查原本的連線提示；不會用舊資料假裝已同步。";
    } else if (next) {
      const source = next.querySelector(".task-subject-suffix")?.dataset.subject || "今日任務";
      const text = next.querySelector(".task-activity")?.textContent.trim() || "未命名任務";
      subject.textContent = source + " · 依現有排序選出";
      title.textContent = text;
      description.textContent = pending ?
        "任務更新正在同步；完成與否以現有系統回覆為準。" :
        "點選「查看任務」操作原本的完成按鈕；此卡片不另寫資料。";
    } else {
      const note = document.querySelector("#task-policy-note");
      const blocked = rows.some((row) => !isComplete(row));
      subject.textContent = note && !note.hidden ? "依目前排程政策" : "今日任務";
      title.textContent = pending ? "任務更新仍在同步" :
        note && !note.hidden ? "目前以原有排程為準" :
        blocked ? "尚有待解鎖或同步中的任務" : "目前顯示的任務已完成";
      description.textContent = note && !note.hidden ? note.textContent :
        "需要查看其他任務或進度，請使用原本的任務清單。";
    }
  };

  let queued = false;
  const queueRender = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  };
  const observer = new MutationObserver(queueRender);
  observer.observe(tasks, { childList: true, subtree: true,
    attributes: true, attributeFilter: ["aria-checked", "disabled"] });
  observer.observe(count, { childList: true, characterData: true, subtree: true });
  const banner = document.querySelector("#banner");
  if (banner) observer.observe(banner, { attributes: true, attributeFilter: ["hidden"] });
  const note = document.querySelector("#task-policy-note");
  if (note) observer.observe(note, { attributes: true, attributeFilter: ["hidden"],
    childList: true, characterData: true, subtree: true });

  taskButton.addEventListener("click", () => {
    if (taskButton.disabled) return;
    document.querySelector('#tabs button[data-t="today"]')?.click();
    const target = tasks.querySelector(".task-item:not(.done):not(.blocked) .task-activity");
    (target || tasks).scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  });

  $("#sd-v2-focus").addEventListener("click", () => {
    document.querySelector('#tabs button[data-t="record"]')?.click();
    // Important: clicking #fc-main can STOP a running session.
    // We only navigate/focus; the user acts through the existing control.
    const timer = document.querySelector("#fc-main");
    timer?.scrollIntoView({ behavior: "smooth", block: "center" });
    timer?.focus({ preventScroll: true });
  });

  render();
}
