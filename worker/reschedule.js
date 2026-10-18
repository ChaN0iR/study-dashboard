import { DB, P, STATUS_DONE, STATUS_TODO } from "./config.js";
import { APPROVED_LESSONS } from "./reschedule-allowlist.js";
import { normalizeId } from "./journal.js";

const DAY = 86400e3;
const ROOT = "reschedule:v1:";
const DEADLINE = "2027-03-15";
// Existing local read-only audit identifies this exact predecessor. It is
// read-only context, deliberately NOT added to the 52-page write allowlist.
const PHYSICS_ANCHOR = "3f879ed2087381f4a355d8ef8155000e";
const identity = new Map(APPROVED_LESSONS.map((x) => [x.id, x]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dateOnly = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const monday = (date) => shift(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const validWeek = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(Date.parse(date)) && monday(date) === date;
const weekLabel = (date) => `W${String(1 + Math.round((Date.parse(date) - Date.parse("2026-10-12")) / (7 * DAY))).padStart(2, "0")}`;
const failure = (message) => Object.assign(new Error(message), { status: 409 });

// One existing named DO serializes every operation. No timers, new schema,
// migrations, or new remote service. Generation has no Notion write capability.
export function createRescheduler({ notion, rd, wr, storage, now = () => Date.now() }) {
  const key = (s) => ROOT + s;
  const save = (row) => storage.put(key(`proposal:${row.id}`), structuredClone(row));
  const current = async () => {
    const id = await storage.get(key("current"));
    return id ? await storage.get(key(`proposal:${id}`)) : null;
  };
  const read = async (env) => {
    const rows = [];
    // Always re-read all 52, not CSV before values, cached dashboard state, or a
    // database-wide classification. Missing/failed pages fail closed.
    for (let i = 0; i < APPROVED_LESSONS.length; i += 4) {
      rows.push(...await Promise.all(APPROVED_LESSONS.slice(i, i + 4).map(async (approved) => {
        try {
          const page = await notion(env, `/pages/${approved.id}`);
          return snapshot(page, approved.id);
        } catch { return { id: approved.id, missing: true }; }
      })));
    }
    return rows;
  };
  function snapshot(page, expectedId) {
    const p = page.properties || {}, L = P.lesson;
    return {
      id: normalizeId(page.id), expectedId, parent: normalizeId(page.parent?.database_id),
      archived: !!page.archived, trashed: !!page.in_trash,
      title: rd.title(p[L.title]), course: rd.select(p[L.course]), order: rd.number(p[L.order]),
      status: rd.select(p[L.status]), type: rd.select(p[L.type]),
      minutes: rd.number(p[L.length]), doneDate: p[L.doneDate]?.date ?? null,
      week: rd.text(p[L.weekLabel]), weekStart: rd.date(p[L.weekStart]),
      weekDate: p[L.weekStart]?.date ?? null,
      edited: page.last_edited_time ?? null,
    };
  }
  function eligible(row) {
    const approved = identity.get(row?.id);
    return !!approved && row.expectedId === row.id && !row.missing && row.parent === normalizeId(DB.lessons) &&
      !row.archived && !row.trashed && row.title === approved.title && row.course === approved.course &&
      row.order === approved.order && row.status === STATUS_TODO && row.type === "影片" &&
      !row.doneDate && !/微課/.test(`${row.title} ${row.course}`) && validWeek(row.weekStart) &&
      row.weekDate?.end == null && row.weekDate?.time_zone == null && row.weekStart <= DEADLINE;
  }
  const stableIdentity = (s) => {
    const { week, weekStart, weekDate, edited, ...rest } = s;
    return rest;
  };
  const targetNoop = (item, fresh) => eligible(fresh) && fresh.week === item.after.week &&
    fresh.weekStart === item.after.weekStart && fresh.weekDate?.end == null && fresh.weekDate?.time_zone == null &&
    same(stableIdentity(fresh), stableIdentity(item.snapshot));
  async function readPage(env, id) {
    try { return snapshot(await notion(env, `/pages/${id}`), id); }
    catch { return { id, missing: true }; }
  }
  const sourceValid = (source, event) => source && !source.missing && source.id === event.lessonId &&
    source.expectedId === source.id && !!source.course && Number.isInteger(source.order) &&
    source.parent === normalizeId(DB.lessons) && !source.archived && !source.trashed &&
    source.type === "影片" && !/微課/.test(`${source.title} ${source.course}`) &&
    source.status === STATUS_DONE && (source.doneDate?.start || null) === event.doneDate &&
    validWeek(source.weekStart) && source.weekStart <= DEADLINE && !!event.doneDate && event.doneDate < source.weekStart;
  const anchorAllows = (anchor, date) => anchor && !anchor.missing && anchor.id === PHYSICS_ANCHOR &&
    anchor.expectedId === PHYSICS_ANCHOR && anchor.parent === normalizeId(DB.lessons) && !anchor.archived && !anchor.trashed &&
    anchor.title === "物理 第10-1堂" && anchor.course === "物理" && anchor.order === 306 && anchor.type === "影片" &&
    (anchor.status === STATUS_DONE || ([STATUS_TODO, "進行中"].includes(anchor.status) && !anchor.doneDate && validWeek(anchor.weekStart) && anchor.weekStart <= date));
  function changes(rows, anchor, source) {
    const selected = [], effective = new Map(rows.map((row) => [row.id, row.weekStart]));
    const floor = monday(dateOnly(now()));
    for (const row of [...rows].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))) {
      if (selected.length === 2) break;
      if (!eligible(row) || !source || row.course !== source.course || row.order <= source.order) continue;
      const afterStart = shift(row.weekStart, -7);
      if (afterStart < floor || afterStart < "2026-10-12" || afterStart > DEADLINE) continue;
      if (row.course === "物理" && !anchorAllows(anchor, afterStart)) continue;
      const predecessors = APPROVED_LESSONS.filter((x) => x.course === row.course && x.order < row.order);
      if (predecessors.some((x) => {
        const prev = rows.find((r) => r.id === x.id);
        if (!prev || prev.missing || prev.expectedId !== x.id || prev.title !== x.title || prev.course !== x.course || prev.order !== x.order ||
            prev.parent !== normalizeId(DB.lessons) || prev.archived || prev.trashed || prev.type !== "影片") return true;
        if (prev.status === STATUS_DONE) return false;
        return ![STATUS_TODO, "進行中"].includes(prev.status) || !!prev.doneDate || !validWeek(effective.get(x.id)) || effective.get(x.id) > afterStart;
      })) continue;
      selected.push({ id: row.id, title: row.title,
        before: { week: row.week, weekStart: row.weekStart },
        after: { week: weekLabel(afterStart), weekStart: afterStart }, snapshot: row,
        estimatedMinutes: row.minutes,
        reason: "此堂在目標週開始前完成；只提前同課程後續課次一週並保留順序。分鐘僅估算，不代表容量已驗證。" });
      effective.set(row.id, afterStart);
    }
    return selected;
  }
  async function recordCompletion(lesson) {
    if (!lesson || lesson.done !== true || !lesson.id) return;
    // Completion date is stable across duplicate requests / unrelated edits.
    // Undated confirmations use a stable marker, never edited time or today's date.
    const event = `completion:${normalizeId(lesson.id)}:${lesson.doneDate || "undated"}`;
    if (await storage.get(key(event))) return;
    await storage.put(key(event), { id: event, lessonId: normalizeId(lesson.id), doneDate: lesson.doneDate || null, state: "queued", at: now() });
  }
  async function refresh(env) {
    const rows = await read(env);
    const previous = await storage.get(key("observed"));
    // Initial observation is a baseline, not 52 fabricated completion events.
    if (previous) for (const row of rows) {
      if (!row.missing && row.status === STATUS_DONE && previous[row.id] && previous[row.id].status !== STATUS_DONE)
        await recordCompletion({ id: row.id, done: true, doneDate: row.doneDate?.start });
    }
    await storage.put(key("observed"), { ...(previous || {}), ...Object.fromEntries(rows.filter((r) => !r.missing).map((r) => [r.id, { status: r.status }])) });
    const pending = await current();
    if (pending?.state === "applying") return { proposal: pending }; // ambiguous writes need manual reconciliation
    if (pending?.state === "pending") {
      const event = await storage.get(key(pending.eventId));
      const source = event && (rows.find((r) => r.id === event.lessonId) || await readPage(env, event.lessonId));
      const anchor = pending.anchor ? await readPage(env, PHYSICS_ANCHOR) : null;
      if (now() >= pending.expiresAt || !event || !sourceValid(source, event) || !same(source, pending.source) ||
          (pending.anchor && !same(anchor, pending.anchor)) ||
          (pending.constraints || []).some((r) => !same(r, rows.find((fresh) => fresh.id === r.id))) ||
          pending.items.some((item) => {
            const fresh = rows.find((r) => r.id === item.id);
            return !same(item.snapshot, fresh) && !targetNoop(item, fresh);
          })) {
        pending.state = "conflict"; pending.reason = "提案已過期或頁面遭修改，未覆蓋；須重新審核。";
        for (const item of pending.items) {
          item.state = "conflict"; item.conflictReason = pending.reason;
        }
        await save(pending);
      }
      // A pending card is immutable. Later events stay queued, never silently
      // replace the exact payload the user is reading.
      return { proposal: pending };
    }
    const listed = await storage.list({ prefix: key("completion:") });
    const events = [...listed.values()].filter((e) => e.state === "queued").sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const event = events[0];
    if (!event) return { proposal: pending };
    const source = rows.find((r) => r.id === event.lessonId) || await readPage(env, event.lessonId);
    if (!sourceValid(source, event)) {
      await storage.put(key(event.id), { ...event, state: "invalidated" });
      return { proposal: pending };
    }
    const anchor = await readPage(env, PHYSICS_ANCHOR);
    const items = changes(rows, anchor, source);
    const selectedIds = new Set(items.map((i) => i.id));
    const constraints = rows.filter((r) => !selectedIds.has(r.id) && items.some((i) => r.course === i.snapshot.course && r.order < i.snapshot.order));
    // Event consumption and card identity survive restarts. No Notion writes.
    await storage.transaction(async (tx) => {
      const seq = (await tx.get(key("sequence")) || 0) + 1;
      if (items.length) {
        const proposal = { id: `r${seq}`, eventId: event.id, source, constraints, anchor: items.some((i) => i.snapshot.course === "物理") ? anchor : null,
          state: "pending", createdAt: now(), expiresAt: now() + DAY, items };
        await tx.put(key(`proposal:${proposal.id}`), proposal);
        await tx.put(key("current"), proposal.id);
      }
      await tx.put(key("sequence"), seq);
      await tx.put(key(event.id), { ...event, state: "consumed" });
    });
    return { proposal: await current() };
  }
  async function approve(env, id, explicit) {
    if (explicit !== true) throw failure("explicit approval required");
    const row = await storage.get(key(`proposal:${id}`));
    if (!row || (await current())?.id !== id) throw failure("proposal is no longer current");
    if (row.state === "applied") return { proposal: row }; // duplicate approval: zero reads/writes to Notion
    if (row.state !== "pending") throw failure("proposal is conflicted or write outcome needs review");
    const rows = await read(env); // re-read the current 52 pages even for an expired card
    const bad = (message, item) => {
      row.state = "conflict"; row.reason = message;
      for (const target of item ? [item] : row.items) {
        target.state = "conflict"; target.conflictReason = message;
      }
    };
    const event = await storage.get(key(row.eventId));
    const source = event && (rows.find((r) => r.id === event.lessonId) || await readPage(env, event.lessonId));
    if (!event || !sourceValid(source, event) || !same(source, row.source)) bad("觸發提案的完成紀錄已變更或撤銷。");
    const anchor = row.anchor ? await readPage(env, PHYSICS_ANCHOR) : null;
    if (row.anchor && !same(anchor, row.anchor)) bad("物理前堂錨點已變更。");
    if ((row.constraints || []).some((r) => !same(r, rows.find((fresh) => fresh.id === r.id)))) bad("同課程前序已變更，須重新審核。");
    if (now() >= row.expiresAt) bad("提案已過期，未寫入。");
    if (!row.items.length || row.items.length > 2 || new Set(row.items.map((i) => i.id)).size !== row.items.length) bad("提案範圍不符。");
    const actions = [];
    for (const item of row.items) {
      const fresh = rows.find((r) => r.id === item.id);
      if (!eligible(fresh) || !identity.has(item.id)) { bad("白名單、身份或未開始影片資格已變更。", item); continue; }
      const noop = targetNoop(item, fresh);
      if (!noop && !same(fresh, item.snapshot)) { bad("頁面與卡片快照不符，未覆蓋人工修改。", item); continue; }
      if (shift(item.before.weekStart, -7) !== item.after.weekStart || !validWeek(item.after.weekStart) ||
          item.after.week !== weekLabel(item.after.weekStart) || item.after.weekStart > DEADLINE ||
          item.after.weekStart < monday(dateOnly(now()))) { bad("週次調整超出核准邊界。", item); continue; }
      actions.push({ item, noop });
    }
    // Revalidate series ordering against all freshly read whitelist rows,
    // including predecessors not being moved by this card.
    const effective = new Map(rows.map((r) => [r.id, r.weekStart]));
    for (const { item } of actions) effective.set(item.id, item.after.weekStart);
    for (const { item } of actions) {
      const candidate = { ...rows.find((r) => r.id === item.id), weekStart: item.after.weekStart };
      if (candidate.course === "物理" && !anchorAllows(anchor, candidate.weekStart)) bad("物理 10-1 前置錨點未驗證。");
      for (const prev of APPROVED_LESSONS.filter((x) => x.course === candidate.course && x.order < candidate.order)) {
        const actual = rows.find((r) => r.id === prev.id);
        if (!actual || actual.missing || actual.expectedId !== prev.id || actual.title !== prev.title || actual.course !== prev.course || actual.order !== prev.order ||
            actual.parent !== normalizeId(DB.lessons) || actual.archived || actual.trashed || actual.type !== "影片" ||
            (actual.status !== STATUS_DONE && (![STATUS_TODO, "進行中"].includes(actual.status) || !!actual.doneDate || !validWeek(effective.get(prev.id)) || effective.get(prev.id) > candidate.weekStart)))
          bad("同課程前序快照已變更或順序無法保證。");
      }
    }
    if (row.state === "conflict") { await save(row); throw failure(row.reason); }
    row.state = "applying"; row.approvedAt = now(); row.results = [];
    await save(row); // MUST persist before the first external PATCH
    for (const { item, noop } of actions) {
      if (!noop) {
        // Notion exposes no compare-and-swap or multi-page transaction. This
        // last read narrows, but cannot eliminate, the read/PATCH race window.
        const immediate = await readPage(env, item.id);
        if (!same(immediate, item.snapshot)) {
          bad("寫入前頁面再次變更，已停止剩餘寫入。", item);
          await save(row); throw failure(row.reason);
        }
        try {
          // Once-only PATCH: generic retry would risk overwriting an intervening
          // human edit after an ambiguous network result.
          await notion(env, `/pages/${item.id}`, "PATCH", { properties: {
            [P.lesson.weekLabel]: wr.text(item.after.week), [P.lesson.weekStart]: wr.date(item.after.weekStart),
          } }, { once: true });
        } catch {
          row.reason = "寫入結果不明，已停止；不得重送，須人工核對。";
          await save(row); throw failure(row.reason);
        }
      }
      item.state = noop ? "noop" : "applied";
      row.results.push({ id: item.id, state: noop ? "noop" : "applied" });
      await save(row);
    }
    row.state = "applied"; row.appliedAt = now(); await save(row);
    return { proposal: row };
  }
  return { current: async () => ({ proposal: await current() }), recordCompletion, refresh, approve };
}
