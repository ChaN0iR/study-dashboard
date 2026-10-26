(() => {
  "use strict";
  // This preview never reads or writes real user data, browser storage or APIs.
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const rows = $$(".task-list .task");
  let toastTimeout;
  let timer = null;
  let seconds = 0;
  let selectedDuration = 25 * 60;
  let hasStarted = false;

  const toast = (message) => {
    const node = $("#toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { node.hidden = true; }, 2800);
  };

  const switchView = (view) => {
    $$("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
    $$("[data-view]").forEach((button) => {
      const selected = button.dataset.view === view;
      button.classList.toggle("is-active", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  $$("[data-view]").forEach((button) =>
    button.addEventListener("click", () => switchView(button.dataset.view)));

  const getTask = (row) => {
    const subtitle = row.querySelector(".task-text small").textContent.trim();
    const minutes = Number((subtitle.match(/(\d+)\s*分鐘/) || [])[1]) || 25;
    return {
      name: row.querySelector(".task-text strong").textContent.trim(),
      subject: subtitle.split("·")[0].trim(),
      minutes,
    };
  };

  const clock = () => {
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    $("#timer-display").textContent = mm + ":" + ss;
  };

  const updateTimerLabels = () => {
    const running = timer !== null;
    $("#timer-toggle").textContent = running ? "暫停計時" : hasStarted ? "繼續計時" : "開始計時";
    const node = $("#timer-state");
    node.replaceChildren();
    node.append(document.createElement("i"), running ? " 進行中" : hasStarted ? " 已暫停" : " 待開始");
    node.classList.toggle("active", running);
  };
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    updateTimerLabels();
  };
  const nextRow = () => rows.find((row) => !row.querySelector("input").checked);

  const syncTasks = () => {
    const finished = rows.filter((row) => row.querySelector("input").checked).length;
    const next = nextRow();
    const total = rows.length;
    $("#stat-tasks").innerHTML = finished + " <small>/ " + total + "</small>";
    $("#tasks-count").textContent = finished + " / " + total;
    $("#task-meter").style.width = (total ? finished / total * 100 : 0) + "%";

    rows.forEach((row) => {
      const checked = row.querySelector("input").checked;
      const isNext = row === next;
      row.querySelector(".task-text").classList.toggle("is-done", checked);
      row.closest("li").classList.toggle("is-next", isNext);
      const tag = row.querySelector(".task-tag");
      if (tag) {
        tag.textContent = checked ? "完成" : isNext ? "接下來" : "";
        tag.classList.toggle("accent-tag", isNext);
        tag.hidden = !checked && !isNext;
      }
    });

    $("#start-focus").disabled = !next;
    $("#next-title").textContent = next ? getTask(next).name : "今天的任務已完成";
    $(".subject-label").textContent = next ? getTask(next).subject + " · 下一個任務" : "今日目標 · 已完成";
    $(".hero-main p").textContent = next
      ? "建議先讀 " + getTask(next).minutes + " 分鐘，再整理這段的關鍵觀念。"
      : "做得好，可以整理重點，或去成就頁看看今日成果。";
    $(".hero-index").textContent =
      String(Math.min(finished + 1, total)).padStart(2, "0") + " / " + String(total).padStart(2, "0");
    $(".hero-duration strong").textContent = next ? String(getTask(next).minutes) : "✓";
    $(".hero-duration span").textContent = next ? "MIN" : "DONE";
    $(".hero").classList.toggle("is-complete", !next);

    // Switching a task never discards a running or paused focus session.
    if (timer === null && !hasStarted) {
      const task = next ? getTask(next) : null;
      selectedDuration = (task?.minutes || 25) * 60;
      seconds = selectedDuration;
      clock();
      $(".timer-caption").textContent = task ? task.subject + " · 示範計時" : "今天的示範任務已完成";
    }
  };
  rows.forEach((row) => row.querySelector("input").addEventListener("change", syncTasks));

  const toggleTimer = () => {
    if (timer !== null) { stopTimer(); return; }
    if (!nextRow()) { toast("今日示範任務都已完成"); return; }
    if (seconds <= 0) seconds = selectedDuration;
    hasStarted = true;
    timer = setInterval(() => {
      seconds = Math.max(0, seconds - 1);
      clock();
      if (seconds === 0) {
        stopTimer();
        hasStarted = false;
        updateTimerLabels();
        toast("這段專注完成，記得整理一個重點");
      }
    }, 1000);
    updateTimerLabels();
  };

  $("#timer-toggle").addEventListener("click", toggleTimer);
  $("#timer-reset").addEventListener("click", () => {
    stopTimer();
    hasStarted = false;
    syncTasks();
    updateTimerLabels();
  });
  $("#start-focus").addEventListener("click", () => {
    if (!nextRow()) return;
    if (timer === null) toggleTimer();
    $(".timer-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#scroll-tasks").addEventListener("click", () =>
    $("#tasks-panel").scrollIntoView({ behavior: "smooth", block: "start" }));
  $("#recall-preview").addEventListener("click", () =>
    toast("此為示範畫面，不會連線或存取真實學習紀錄。"));
  syncTasks();
  updateTimerLabels();
})();