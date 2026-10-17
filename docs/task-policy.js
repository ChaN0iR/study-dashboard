(() => {
  "use strict";

  const toMinute = (value) => {
    const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const isCarryover = (task, today) => task.carryover === true || (!!task.date && !!today && task.date < today);
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

  function taskView(tasks, options = {}) {
    const {
      today = "", weekday = "", nowMin = 0, slots = [], bedMinute = 22 * 60,
      isStudyTask = () => false, isLifeTask = () => false,
    } = options;
    const input = Array.isArray(tasks) ? tasks : [];
    // Prefer today's canonical row if a server response ever contains the same ID twice.
    const ordered = input.map((task, index) => ({ task, index, carryover: isCarryover(task, today) }))
      .sort((a, b) => Number(a.carryover) - Number(b.carryover) || a.index - b.index);
    const seen = new Set();
    const unique = [];
    for (const item of ordered) {
      const task = item.task || {};
      if (task.id && seen.has(task.id)) continue;
      if (task.id) seen.add(task.id);
      const carryover = item.carryover;
      if (carryover && (task.makeup !== true || task.done === true || task.skipped === true || isLifeTask(task) || !isStudyTask(task))) continue;
      unique.push({ ...task, carryover });
    }

    const suppressed = suppressionReason({ weekday, nowMin, slots, bedMinute });
    const visible = unique.filter((task) => !(suppressed && task.done !== true && isStudyTask(task)));
    return { tasks: visible, suppression: suppressed };
  }

  function taskIsCurrent(task, options = {}) {
    const {
      activeSlot = null, weekday = "", nowMin = 0, slots = [], bedMinute = 22 * 60,
      isStudyTask = () => false,
    } = options;
    if (!activeSlot || task.done === true || task.blocked === true) return false;
    if (isStudyTask(task) && suppressionReason({ weekday, nowMin, slots, bedMinute })) return false;
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
      if (taskIsCurrent(task, { activeSlot, weekday, nowMin, slots, bedMinute, isStudyTask, getSlot })) return 1;
      if (task.blocked === true) return 3;
      return 2;
    };
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 0) return slotStartOf(a) - slotStartOf(b) || orderOf(a) - orderOf(b);
    return orderOf(a) - orderOf(b);
  }

  globalThis.TaskPolicy = { taskView, taskIsCurrent, compareTasks, quietStart, suppressionReason, toMinute };
})();
