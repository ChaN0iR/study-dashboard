(() => {
  "use strict";

  const toMinute = (value) => {
    const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const isCarryover = (task, today) => task.date && task.date === today ? false
    : task.carryover === true || (!!task.date && !!today && task.date < today);
  const bedtimePattern = /睡前|睡覺|入睡|甘胺酸|wind.?down/i;
  const quietStart = (slots, bedMinute) => {
    const slot = (slots || []).find((item) => bedtimePattern.test(`${item.name || ""} ${(item.keys || []).join(" ")}`));
    return slot ? (toMinute(slot.start) ?? bedMinute) : bedMinute;
  };
  const suppressionReason = ({ weekday, nowMin, slots, bedMinute }) => {
    if (String(weekday || "").slice(0, 3) === "Sun") return "rest";
    if (Number(nowMin) >= quietStart(slots, bedMinute)) return "quiet";
    return null;
  };

  // No dedicated daily-required field exists: infer routines, not completion or reminder cards.
  function isDailyRequired(task) {
    const title = String(task.title || "").trim();
    if (/設定|安裝|同步|匯入|匯出|登入|帳號|密碼|整理|管理|排程|安排|教學/.test(title)) return false;
    if (/(?:每日|每天|天天)\s*必(?:做|讀|背|練)/.test(title)) return true;
    // Course/lesson work and one-off administration are not the daily Anki/vocabulary routine.
    if ((task.relatedCourses || []).length || (task.relatedLessonIds || []).length
      || /週複習|周複習|每週|每周|課程|先修|主課|微課|影片|看課|上課|講義|章節|第\s*\d+.*堂/.test(title)) return false;
    const routineTitle = title.replace(/^(?:每日|每天|天天)\s*/, "");
    return (/^Anki(?:\b|[＋+：:｜|・])/i.test(routineTitle) && /到期卡|單字|生字|字彙/.test(routineTitle))
      || /^(?:清完|清空|複習)?到期卡/.test(routineTitle)
      || /^(?:(?:英文|英語)\s*)?(?:(?:背誦|背|複習)\s*)?(?:單字|生字|字彙)(?:[｜|：:\s＋+・\d]|$|複習|背誦)/.test(routineTitle);
  }
  function studyIsSuppressed(task, options, reason) {
    if (!reason || options.isLifeTask?.(task) || !options.isStudyTask?.(task)) return false;
    return reason !== "rest" || !isDailyRequired(task);
  }

  // Return original rows: display, prerequisites and writes must choose the same ID owner.
  function uniqueTasks(tasks, today = "") {
    const rank = (task) => task.date && task.date === today ? 0 : !isCarryover(task, today) ? 1 : 2;
    const ordered = (Array.isArray(tasks) ? tasks : []).filter((task) => task && typeof task === "object")
      .map((task, index) => ({ task, index }))
      .sort((a, b) => rank(a.task) - rank(b.task)
        || String(b.task.date || "").localeCompare(String(a.task.date || "")) || a.index - b.index);
    const seen = new Set();
    return ordered.filter(({ task }) => {
      if (!task.id) return true;
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    }).map(({ task }) => task);
  }

  function taskView(tasks, options = {}) {
    const {
      today = "", weekday = "", nowMin = 0, slots = [], bedMinute = 22 * 60,
      isStudyTask = () => false, isLifeTask = () => false,
    } = options;
    const unique = [];
    for (const task of uniqueTasks(tasks, today)) {
      const carryover = isCarryover(task, today);
      if (carryover && (task.makeup !== true || task.done === true || task.skipped === true || isLifeTask(task) || !isStudyTask(task))) continue;
      unique.push({ ...task, carryover });
    }

    const suppressed = suppressionReason({ weekday, nowMin, slots, bedMinute });
    const visible = unique.filter((task) => !(task.done !== true && studyIsSuppressed(task, options, suppressed)));
    return { tasks: visible, skipped: unique.filter((task) => task.skipped === true), suppression: suppressed };
  }

  function taskIsCurrent(task, options = {}) {
    const {
      activeSlot = null, weekday = "", nowMin = 0, slots = [], bedMinute = 22 * 60,
      isStudyTask = () => false,
    } = options;
    if (!activeSlot || task.done === true || task.blocked === true) return false;
    if (studyIsSuppressed(task, options, suppressionReason({ weekday, nowMin, slots, bedMinute }))) return false;
    return options.getSlot ? options.getSlot(task) === activeSlot : false;
  }

  function compareTasks(a, b, options = {}) {
    const {
      nowMin = 0, weekday = "", slots = [], bedMinute = 22 * 60, activeSlot = null,
      isStudyTask = () => false, isLifeTask = () => false, getSlot = () => null,
    } = options;
    const suppressed = suppressionReason({ weekday, nowMin, slots, bedMinute });
    const orderOf = (task) => Number(task.order) || 999;
    const slotStartOf = (task) => toMinute(getSlot(task)?.start) ?? 1440;
    const isOpen = (task) => task.done !== true && task.skipped !== true;
    const isOverdueStudy = (task) => {
      if (!isOpen(task) || task.blocked === true || suppressed || isLifeTask(task) || !isStudyTask(task)) return false;
      if (task.carryover === true) return true;
      const slot = getSlot(task);
      const end = toMinute(slot?.end);
      return end !== null && Number(nowMin) >= end;
    };
    const bucket = (task) => {
      if (task.done === true || task.skipped === true) return 4;
      if (isOverdueStudy(task)) return 0;
      if (taskIsCurrent(task, { activeSlot, weekday, nowMin, slots, bedMinute, isStudyTask, isLifeTask, getSlot })) return 1;
      if (task.blocked === true) return 3;
      return 2;
    };
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 0) return slotStartOf(a) - slotStartOf(b) || orderOf(a) - orderOf(b);
    return orderOf(a) - orderOf(b);
  }

  globalThis.TaskPolicy = { uniqueTasks, taskView, taskIsCurrent, compareTasks, quietStart, suppressionReason, toMinute, isDailyRequired };
})();
