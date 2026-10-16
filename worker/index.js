import { DB, P, MOODS, SUBJECTS, STATUS_DONE, STATUS_TODO } from "./config.js";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// ---------- helpers ----------
const taipeiDate = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

const json = (data, status = 200, env, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(env), ...extra },
  });

const cors = (env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-headers": "content-type, x-app-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
  vary: "origin",
});

function safeEqual(a = "", b = "") {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function notion(env, path, method = "GET", body) {
  const res = await fetch(NOTION + path, {
    method,
    headers: {
      authorization: `Bearer ${env.NOTION_TOKEN}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Notion ${res.status}: ${data.message || "error"}`);
  return data;
}

async function queryAll(env, dbId, body) {
  const out = [];
  let cursor;
  do {
    const r = await notion(env, `/databases/${dbId}/query`, "POST", {
      page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && out.length < 500);
  return out;
}

// property readers
const txt = (arr) => (arr || []).map((t) => t.plain_text).join("");
const rd = {
  title: (p) => txt(p?.title),
  text: (p) => txt(p?.rich_text),
  check: (p) => !!p?.checkbox,
  select: (p) => p?.select?.name || null,
  number: (p) => (typeof p?.number === "number" ? p.number : null),
  date: (p) => p?.date?.start || null,
  formula: (p) => {
    const f = p?.formula;
    if (!f) return null;
    return f[f.type] ?? null;
  },
  relation: (p) => (p?.relation || []).map((r) => r.id),
};

// property writers
const wr = {
  text: (s) => ({
    rich_text: String(s ?? "").match(/[\s\S]{1,2000}/g)?.map((c) => ({ text: { content: c } })) || [],
  }),
  title: (s) => ({ title: [{ text: { content: String(s).slice(0, 2000) } }] }),
  check: (b) => ({ checkbox: !!b }),
  number: (n) => ({ number: n === null || n === "" || n === undefined ? null : Number(n) }),
  select: (n) => ({ select: n ? { name: n } : null }),
  date: (d) => ({ date: d ? { start: d } : null }),
};

function num(v, name, max) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${name} invalid`);
  return n;
}

const fmtYpt = (h, m) => {
  const total = Math.round((h || 0) * 60 + (m || 0));
  return total ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m` : "";
};

// ---------- shapers ----------
const shapeTask = (pg) => ({
  id: pg.id,
  title: rd.title(pg.properties[P.task.title]),
  done: rd.check(pg.properties[P.task.done]),
  skipped: rd.check(pg.properties[P.task.skip]),
  source: rd.select(pg.properties[P.task.source]) || "今日",
  order: rd.number(pg.properties[P.task.order]) ?? 999,
});

const shapeRecord = (pg) => {
  const p = pg.properties;
  const h = rd.number(p[P.record.hours]);
  const m = rd.number(p[P.record.minutes]);
  return {
    id: pg.id,
    date: rd.date(p[P.record.date]),
    hours: h, minutes: m,
    ypt: rd.formula(p[P.record.ypt]) || fmtYpt(h, m),
    review: rd.text(p[P.record.review]),
    points: rd.text(p[P.record.points]),
    workout: rd.text(p[P.record.workout]),
    mood: rd.select(p[P.record.mood]),
    completion: rd.formula(p[P.record.completion]),
  };
};

const shapeLesson = (pg) => {
  const p = pg.properties, L = P.lesson;
  return {
    id: pg.id,
    title: rd.title(p[L.title]),
    status: rd.select(p[L.status]) || STATUS_TODO,
    done: rd.select(p[L.status]) === STATUS_DONE,
    subject: rd.select(p[L.subject]),
    course: rd.select(p[L.course]),
    minutes: rd.number(p[L.length]),
    week: rd.text(p[L.weekLabel]),
    reviews: rd.number(p[L.reviews]) ?? 0,
    next: rd.formula(p[L.nextReview]),
    due: rd.formula(p[L.due]),
    order: rd.number(p[L.order]) ?? 0,
  };
};

// ---------- data ops ----------
async function findTodayRecord(env, today) {
  const r = await notion(env, `/databases/${DB.records}/query`, "POST", {
    page_size: 1,
    filter: { property: P.record.date, date: { equals: today } },
  });
  return r.results[0] || null;
}

async function getOrCreateRecord(env, today) {
  const found = await findTodayRecord(env, today);
  if (found) return found;
  return notion(env, "/pages", "POST", {
    parent: { database_id: DB.records },
    properties: {
      [P.record.title]: wr.title(today),
      [P.record.date]: wr.date(today),
    },
  });
}

async function getState(env) {
  const today = taipeiDate();
  const weekFloor = taipeiDate(-7);
  const [tasks, rec, lessons] = await Promise.all([
    queryAll(env, DB.tasks, {
      filter: { property: P.task.date, date: { equals: today } },
      sorts: [{ property: P.task.order, direction: "ascending" }],
    }),
    findTodayRecord(env, today),
    queryAll(env, DB.lessons, {
      filter: {
        and: [
          { property: P.lesson.weekStart, date: { on_or_before: today } },
          { or: [
            { property: P.lesson.status, select: { does_not_equal: STATUS_DONE } },
            { property: P.lesson.weekStart, date: { after: weekFloor } },
          ] },
        ],
      },
      sorts: [{ property: P.lesson.order, direction: "ascending" }],
    }),
  ]);
  return {
    today,
    tasks: tasks.map(shapeTask),
    record: rec ? shapeRecord(rec) : null,
    lessons: lessons.map(shapeLesson),
  };
}

async function postTask(env, id, body) {
  const props = {};
  if (typeof body.done === "boolean") props[P.task.done] = wr.check(body.done);
  if (typeof body.skip === "boolean") props[P.task.skip] = wr.check(body.skip);
  if (!Object.keys(props).length) throw new HttpError(400, "need done or skip (boolean)");
  return shapeTask(await notion(env, `/pages/${id}`, "PATCH", { properties: props }));
}

async function postRecord(env, body) {
  const today = taipeiDate();
  const rec = await getOrCreateRecord(env, today);
  const props = {};
  if ("hours" in body) props[P.record.hours] = wr.number(num(body.hours, "hours", 24));
  if ("minutes" in body) props[P.record.minutes] = wr.number(num(body.minutes, "minutes", 1440));
  if ("心得" in body) props[P.record.review] = wr.text(body["心得"]);
  if ("重點" in body) props[P.record.points] = wr.text(body["重點"]);
  if ("運動" in body) props[P.record.workout] = wr.text(body["運動"]);
  if ("心情" in body) {
    if (body["心情"] && !MOODS.includes(body["心情"])) throw new HttpError(400, "mood invalid");
    props[P.record.mood] = wr.select(body["心情"] || null);
  }
  if (!Object.keys(props).length) return shapeRecord(rec);
  return shapeRecord(await notion(env, `/pages/${rec.id}`, "PATCH", { properties: props }));
}

async function postLesson(env, id, body) {
  const today = taipeiDate();
  const props = {};
  if (typeof body.done === "boolean") {
    props[P.lesson.status] = wr.select(body.done ? STATUS_DONE : STATUS_TODO);
    props[P.lesson.doneDate] = wr.date(body.done ? today : null);
  }
  if (body.review === true) {
    const cur = await notion(env, `/pages/${id}`);
    props[P.lesson.reviews] = wr.number((rd.number(cur.properties[P.lesson.reviews]) || 0) + 1);
    props[P.lesson.lastReview] = wr.date(today);
  }
  if (!Object.keys(props).length) throw new HttpError(400, "need done (boolean) or review:true");
  return shapeLesson(await notion(env, `/pages/${id}`, "PATCH", { properties: props }));
}

async function postNote(env, body) {
  const title = String(body.title || "").trim();
  if (!title) throw new HttpError(400, "title required");
  const props = {
    [P.note.title]: wr.title(title),
    [P.note.date]: wr.date(taipeiDate()),
    [P.note.status]: wr.select("未複習"),
  };
  if (body.subject) {
    if (!SUBJECTS.includes(body.subject)) throw new HttpError(400, "subject invalid");
    props[P.note.subject] = wr.select(body.subject);
  }
  if (body.chapter) props[P.note.chapter] = wr.text(body.chapter);
  if (body.points) props[P.note.points] = wr.text(body.points);
  if (body.lessonId) {
    if (!ID_RE.test(body.lessonId)) throw new HttpError(400, "lessonId invalid");
    props[P.note.lesson] = { relation: [{ id: body.lessonId }] };
  }
  const pg = await notion(env, "/pages", "POST", { parent: { database_id: DB.notes }, properties: props });
  return { id: pg.id, title };
}


// ---------- focus timer ----------
const F = { title: "紀錄", date: "日期", start: "開始", end: "結束", acc: "累計秒", status: "狀態", subject: "科目" };
const tpIso = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + "+08:00";
const shapeFocus = (pg) => {
  const p = pg.properties;
  return {
    id: pg.id,
    status: rd.select(p[F.status]),
    start: rd.date(p[F.start]) ? Date.parse(rd.date(p[F.start])) : null,
    end: rd.date(p[F.end]) ? Date.parse(rd.date(p[F.end])) : null,
    acc: rd.number(p[F.acc]) || 0,
    subject: rd.select(p[F.subject]),
    date: rd.date(p[F.date]),
  };
};

async function getFocus(env) {
  const today = taipeiDate();
  const since = taipeiDate(-29);
  const rows = (await queryAll(env, DB.focus, {
    filter: { property: F.date, date: { on_or_after: since } },
    sorts: [{ property: F.start, direction: "descending" }],
  })).map(shapeFocus);
  const active = rows.find((r) => r.status === "進行中" || r.status === "暫停") || null;
  const done = rows.filter((r) => r.status === "完成");
  const days = {};
  for (const r of done) {
    const d = (days[r.date] ||= { date: r.date, sec: 0, count: 0 });
    d.sec += r.acc; d.count++;
  }
  return {
    now: Date.now(),
    active,
    todayDoneSec: done.filter((r) => r.date === today).reduce((a, r) => a + r.acc, 0),
    sessions: done.filter((r) => r.date === today).sort((a, b) => a.start - b.start),
    days: Object.values(days).sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

async function postFocus(env, body) {
  const action = body.action;
  const cur = (await getFocus(env)).active;
  const now = Date.now();
  if (action === "start") {
    if (cur) return getFocus(env);
    const subject = body.subject && SUBJECTS.includes(body.subject) ? body.subject : null;
    await notion(env, "/pages", "POST", { parent: { database_id: DB.focus }, properties: {
      [F.title]: wr.title("專注 " + tpIso(now).slice(11, 16)),
      [F.date]: wr.date(taipeiDate()),
      [F.start]: wr.date(tpIso(now)),
      [F.acc]: wr.number(0),
      [F.status]: wr.select("進行中"),
      ...(subject ? { [F.subject]: wr.select(subject) } : {}),
    } });
    return getFocus(env);
  }
  if (!cur) return getFocus(env);
  const running = cur.status === "進行中";
  const acc = cur.acc + (running && cur.start ? Math.max(0, Math.round((now - cur.start) / 1000)) : 0);
  let props;
  if (action === "pause") { if (!running) return getFocus(env); props = { [F.acc]: wr.number(acc), [F.status]: wr.select("暫停") }; }
  else if (action === "resume") { if (running) return getFocus(env); props = { [F.start]: wr.date(tpIso(now)), [F.status]: wr.select("進行中") }; }
  else if (action === "stop") props = { [F.acc]: wr.number(acc), [F.end]: wr.date(tpIso(now)), [F.status]: wr.select("完成") };
  else if (action === "subject") props = { [F.subject]: wr.select(SUBJECTS.includes(body.subject) ? body.subject : null) };
  else throw new HttpError(400, "bad action");
  await notion(env, `/pages/${cur.id}`, "PATCH", { properties: props });
  return getFocus(env);
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/" || path === "/health") return json({ ok: true }, 200, env);
      if (!env.APP_KEY || !env.NOTION_TOKEN) throw new HttpError(500, "worker secrets not configured");
      if (!safeEqual(request.headers.get("x-app-key") || "", env.APP_KEY)) throw new HttpError(401, "bad app key");

      const readBody = async () => {
        try { return (await request.json()) || {}; } catch { throw new HttpError(400, "invalid JSON"); }
      };
      const seg = path.split("/").filter(Boolean); // ["api", ...]
      if (seg[0] !== "api") throw new HttpError(404, "not found");

      if (request.method === "GET" && seg[1] === "state" && seg.length === 2)
        return json(await getState(env), 200, env, { "cache-control": "no-store" });

      if (request.method === "GET" && seg[1] === "focus" && seg.length === 2)
        return json(await getFocus(env), 200, env, { "cache-control": "no-store" });

      if (request.method === "POST") {
        if (seg[1] === "focus" && seg.length === 2) return json(await postFocus(env, await readBody()), 200, env);
        if (seg[1] === "record" && seg.length === 2) return json(await postRecord(env, await readBody()), 200, env);
        if (seg[1] === "note" && seg.length === 2) return json(await postNote(env, await readBody()), 200, env);
        if ((seg[1] === "task" || seg[1] === "lesson") && seg.length === 3) {
          if (!ID_RE.test(seg[2])) throw new HttpError(400, "bad id");
          const body = await readBody();
          return json(seg[1] === "task" ? await postTask(env, seg[2], body) : await postLesson(env, seg[2], body), 200, env);
        }
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e.message || "error" }, status, env);
    }
  },
};
