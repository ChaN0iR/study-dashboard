const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = "rr_session";
const PASSWORD_ITERATIONS = 310_000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_REQUEST_BYTES = 400_000;
const AUTH_WINDOW_MS = 60 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 12;
const authWindows = new Map();
const encoder = new TextEncoder();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CARD_ID_RE = /^[a-z0-9-]{1,64}$/;
const DUMMY_PASSWORD_HASH = `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${"A".repeat(43)}$${"A".repeat(43)}`;

function json(body, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function authUnavailable() {
  return json({ code: "AUTH_STORAGE_NOT_CONFIGURED" }, 503);
}

function sameOrigin(request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}

function limited(ip) {
  const now = Date.now();
  let entry = authWindows.get(ip);
  if (!entry || now - entry.start >= AUTH_WINDOW_MS) entry = { start: now, count: 0 };
  entry.count += 1;
  authWindows.set(ip, entry);
  if (authWindows.size > 5000) {
    for (const [key, value] of authWindows) {
      if (now - value.start >= AUTH_WINDOW_MS) authWindows.delete(key);
    }
  }
  return entry.count > MAX_AUTH_ATTEMPTS;
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) return { error: "REQUEST_TOO_LARGE" };
  const raw = await request.text();
  if (raw.length > maxBytes) return { error: "REQUEST_TOO_LARGE" };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value }
      : { error: "INVALID_JSON" };
  } catch {
    return { error: "INVALID_JSON" };
  }
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value) {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(new Uint8Array(bits))}`;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function verifyPassword(password, encoded) {
  const [algorithm, iterationText, saltText, hashText] = String(encoded || "").split("$");
  const iterations = Number(iterationText);
  if (algorithm !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 600_000) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = decodeBase64Url(saltText);
    expected = decodeBase64Url(hashText);
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return constantTimeEqual(new Uint8Array(bits), expected);
}

function getCookie(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === COOKIE_NAME) return valueParts.join("=").slice(0, 128);
  }
  return "";
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function issueSession(env, request, userId) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = encodeBase64Url(bytes);
  const tokenHash = await sha256(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(tokenHash, userId, now, expiresAt, now).run();
  return { token, expiresAt };
}

async function authenticatedUser(env, request) {
  const token = getCookie(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(
    "SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? LIMIT 1",
  ).bind(tokenHash, Date.now()).first();
}

async function authRegister(request, env) {
  if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(request)) return json({ code: "SAME_ORIGIN_ONLY" }, 403);
  if (limited(request.headers.get("cf-connecting-ip") || "unknown")) return json({ code: "AUTH_RATE_LIMIT" }, 429);
  const parsed = await readJson(request, 8_000);
  if (parsed.error) return json({ code: parsed.error }, parsed.error === "REQUEST_TOO_LARGE" ? 413 : 400);
  const email = typeof parsed.value.email === "string" ? parsed.value.email.trim().toLowerCase() : "";
  const password = typeof parsed.value.password === "string" ? parsed.value.password : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json({ code: "INVALID_EMAIL" }, 422);
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
    return json({ code: "PASSWORD_LENGTH" }, 422);
  }

  const passwordHash = await hashPassword(password);
  const user = { id: crypto.randomUUID(), email };
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).bind(user.id, user.email, passwordHash, now).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) return json({ code: "EMAIL_ALREADY_REGISTERED" }, 409);
    return json({ code: "AUTH_STORAGE_ERROR" }, 503);
  }

  const session = await issueSession(env, request, user.id);
  return json({ user }, 201, { "set-cookie": sessionCookie(request, session.token, Math.floor(SESSION_TTL_MS / 1000)) });
}

async function authLogin(request, env) {
  if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(request)) return json({ code: "SAME_ORIGIN_ONLY" }, 403);
  if (limited(request.headers.get("cf-connecting-ip") || "unknown")) return json({ code: "AUTH_RATE_LIMIT" }, 429);
  const parsed = await readJson(request, 8_000);
  if (parsed.error) return json({ code: parsed.error }, parsed.error === "REQUEST_TOO_LARGE" ? 413 : 400);
  const email = typeof parsed.value.email === "string" ? parsed.value.email.trim().toLowerCase() : "";
  const password = typeof parsed.value.password === "string" ? parsed.value.password : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email) || !password || password.length > 128) {
    return json({ code: "INVALID_CREDENTIALS" }, 401);
  }

  const record = await env.DB.prepare(
    "SELECT id, email, password_hash FROM users WHERE email = ? COLLATE NOCASE LIMIT 1",
  ).bind(email).first();
  const valid = await verifyPassword(password, record?.password_hash || DUMMY_PASSWORD_HASH);
  if (!record || !valid) return json({ code: "INVALID_CREDENTIALS" }, 401);

  const session = await issueSession(env, request, record.id);
  return json(
    { user: { id: record.id, email: record.email } },
    200,
    { "set-cookie": sessionCookie(request, session.token, Math.floor(SESSION_TTL_MS / 1000)) },
  );
}

async function authMe(request, env) {
  if (request.method !== "GET") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  const user = await authenticatedUser(env, request);
  return json(user ? { authenticated: true, user } : { authenticated: false });
}

async function authLogout(request, env) {
  if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(request)) return json({ code: "SAME_ORIGIN_ONLY" }, 403);
  const token = getCookie(request);
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), 8_640_000_000_000_000) : 0;
}

function cleanGradeResult(value) {
  if (!isObject(value)) return null;
  const judgements = new Set(["完全正確", "大致正確", "需要加強", "手寫內容不清楚"]);
  return {
    provider: value.provider === "gemini" ? "gemini" : "gemini",
    score: Math.max(0, Math.min(100, Math.round(Number(value.score) || 0))),
    judgement: judgements.has(value.judgement) ? value.judgement : "需要加強",
    feedback: typeof value.feedback === "string" ? value.feedback.slice(0, 500) : "",
    missing_points: Array.isArray(value.missing_points)
      ? value.missing_points.slice(0, 4).filter((item) => typeof item === "string").map((item) => item.slice(0, 140))
      : [],
    next_card_id: typeof value.next_card_id === "string" && CARD_ID_RE.test(value.next_card_id) ? value.next_card_id : "",
    adaptation_reason: typeof value.adaptation_reason === "string" ? value.adaptation_reason.slice(0, 240) : "",
    gradedAt: numberOrZero(value.gradedAt),
  };
}

function cleanState(input) {
  const output = Object.create(null);
  if (!isObject(input)) return output;
  for (const [id, item] of Object.entries(input)) {
    if (id === "_adaptiveNextId") {
      if (typeof item === "string" && CARD_ID_RE.test(item)) output._adaptiveNextId = item;
      continue;
    }
    if (id === "_gradeResults") {
      if (!isObject(item)) continue;
      const grades = Object.create(null);
      for (const [cardId, grade] of Object.entries(item)) {
        if (!CARD_ID_RE.test(cardId)) continue;
        const safeGrade = cleanGradeResult(grade);
        if (safeGrade) grades[cardId] = safeGrade;
      }
      output._gradeResults = grades;
      continue;
    }
    if (!CARD_ID_RE.test(id) || !isObject(item)) continue;
    const safe = {
      dueAt: numberOrZero(item.dueAt),
      reviewCount: Math.max(0, Math.min(100_000, Math.floor(Number(item.reviewCount) || 0))),
      updatedAt: numberOrZero(item.updatedAt),
    };
    if (["good", "hard", "again"].includes(item.lastRating)) safe.lastRating = item.lastRating;
    if (typeof item.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.lastDay)) safe.lastDay = item.lastDay;
    output[id] = safe;
  }
  return output;
}

function cleanPackedStrokes(strokes) {
  if (!Array.isArray(strokes)) return [];
  return strokes.slice(-80).map((stroke) => {
    if (!Array.isArray(stroke)) return null;
    const color = typeof stroke[0] === "string" && /^#[0-9a-f]{3,8}$/i.test(stroke[0]) ? stroke[0] : "#244b3e";
    const width = Math.max(1, Math.min(120, Math.floor(Number(stroke[1]) || 26)));
    const points = Array.isArray(stroke[2]) ? stroke[2].slice(0, 180).map((point) => {
      if (!Array.isArray(point)) return [0, 0, 50];
      return [
        Math.max(0, Math.min(1000, Math.round(Number(point[0]) || 0))),
        Math.max(0, Math.min(1000, Math.round(Number(point[1]) || 0))),
        Math.max(0, Math.min(100, Math.round(Number(point[2]) || 50))),
      ];
    }) : [];
    return [color, width, points];
  }).filter(Boolean);
}

function cleanDrafts(input) {
  const output = Object.create(null);
  if (!isObject(input)) return output;
  for (const [id, draft] of Object.entries(input)) {
    if (!CARD_ID_RE.test(id) || !isObject(draft)) continue;
    const safe = {
      mode: draft.mode === "draw" ? "draw" : "text",
      text: typeof draft.text === "string" ? draft.text.slice(0, 5_000) : "",
      savedAt: numberOrZero(draft.savedAt),
      strokes: cleanPackedStrokes(draft.strokes),
    };
    if (typeof draft.submittedAt === "string" && draft.submittedAt.length <= 40) safe.submittedAt = draft.submittedAt;
    output[id] = safe;
  }
  return output;
}

function normalizeSnapshot(input) {
  const value = isObject(input) ? input : {};
  return {
    state: cleanState(value.state),
    answerDrafts: cleanDrafts(value.answerDrafts),
    currentId: typeof value.currentId === "string" && CARD_ID_RE.test(value.currentId) ? value.currentId : null,
    currentView: ["dashboard", "practice", "deck"].includes(value.currentView) ? value.currentView : "dashboard",
    sessionUpdatedAt: numberOrZero(value.sessionUpdatedAt),
    updatedAt: numberOrZero(value.updatedAt),
  };
}

function cardVersion(item) {
  return Math.max(numberOrZero(item?.updatedAt), numberOrZero(item?.dueAt));
}

function mergeSnapshots(leftInput, rightInput) {
  const left = normalizeSnapshot(leftInput);
  const right = normalizeSnapshot(rightInput);
  const state = Object.create(null);
  const cardIds = new Set([...Object.keys(left.state), ...Object.keys(right.state)].filter((id) => !id.startsWith("_")));
  for (const id of cardIds) {
    const a = left.state[id];
    const b = right.state[id];
    if (!a) state[id] = b;
    else if (!b) state[id] = a;
    else if (Number(a.reviewCount || 0) !== Number(b.reviewCount || 0)) {
      state[id] = Number(a.reviewCount || 0) > Number(b.reviewCount || 0) ? a : b;
    } else {
      state[id] = cardVersion(a) >= cardVersion(b) ? a : b;
    }
  }

  const grades = Object.create(null);
  const leftGrades = left.state._gradeResults || {};
  const rightGrades = right.state._gradeResults || {};
  for (const id of new Set([...Object.keys(leftGrades), ...Object.keys(rightGrades)])) {
    const a = leftGrades[id];
    const b = rightGrades[id];
    grades[id] = !a ? b : !b ? a : numberOrZero(a.gradedAt) >= numberOrZero(b.gradedAt) ? a : b;
  }
  if (Object.keys(grades).length) state._gradeResults = grades;

  const newerSession = left.sessionUpdatedAt >= right.sessionUpdatedAt ? left : right;
  const adaptive = newerSession.state._adaptiveNextId;
  if (typeof adaptive === "string" && CARD_ID_RE.test(adaptive)) state._adaptiveNextId = adaptive;

  const answerDrafts = Object.create(null);
  for (const id of new Set([...Object.keys(left.answerDrafts), ...Object.keys(right.answerDrafts)])) {
    const a = left.answerDrafts[id];
    const b = right.answerDrafts[id];
    answerDrafts[id] = !a ? b : !b ? a : numberOrZero(a.savedAt) >= numberOrZero(b.savedAt) ? a : b;
  }

  return {
    state,
    answerDrafts,
    currentId: newerSession.currentId,
    currentView: newerSession.currentView,
    sessionUpdatedAt: Math.max(left.sessionUpdatedAt, right.sessionUpdatedAt),
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
  };
}

async function progressGet(request, env) {
  if (request.method !== "GET") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  const user = await authenticatedUser(env, request);
  if (!user) return json({ code: "UNAUTHORIZED" }, 401);
  const row = await env.DB.prepare("SELECT snapshot, updated_at FROM user_progress WHERE user_id = ? LIMIT 1").bind(user.id).first();
  if (!row) return json({ snapshot: normalizeSnapshot({}), updatedAt: 0 });
  try {
    return json({ snapshot: normalizeSnapshot(JSON.parse(row.snapshot)), updatedAt: numberOrZero(row.updated_at) });
  } catch {
    return json({ code: "PROGRESS_DATA_INVALID" }, 500);
  }
}

async function progressPut(request, env) {
  if (request.method !== "PUT") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (!sameOrigin(request)) return json({ code: "SAME_ORIGIN_ONLY" }, 403);
  const user = await authenticatedUser(env, request);
  if (!user) return json({ code: "UNAUTHORIZED" }, 401);
  const parsed = await readJson(request);
  if (parsed.error) return json({ code: parsed.error }, parsed.error === "REQUEST_TOO_LARGE" ? 413 : 400);
  const incoming = normalizeSnapshot(parsed.value.snapshot);
  const existing = await env.DB.prepare("SELECT snapshot FROM user_progress WHERE user_id = ? LIMIT 1").bind(user.id).first();
  let current = normalizeSnapshot({});
  if (existing?.snapshot) {
    try {
      current = normalizeSnapshot(JSON.parse(existing.snapshot));
    } catch {
      return json({ code: "PROGRESS_DATA_INVALID" }, 500);
    }
  }
  const merged = mergeSnapshots(current, incoming);
  const updatedAt = Date.now();
  merged.updatedAt = updatedAt;
  const serialized = JSON.stringify(merged);
  if (serialized.length > MAX_REQUEST_BYTES) return json({ code: "PROGRESS_TOO_LARGE" }, 413);
  await env.DB.prepare(
    "INSERT INTO user_progress (user_id, snapshot, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at",
  ).bind(user.id, serialized, updatedAt).run();
  return json({ snapshot: merged, updatedAt });
}

export { authenticatedUser };

export async function authApi(request, env, pathname) {
  if (!env.DB) return authUnavailable();
  try {
    if (pathname === "/api/auth/register") return await authRegister(request, env);
    if (pathname === "/api/auth/login") return await authLogin(request, env);
    if (pathname === "/api/auth/me") return await authMe(request, env);
    if (pathname === "/api/auth/logout") return await authLogout(request, env);
    return json({ code: "NOT_FOUND" }, 404);
  } catch {
    return json({ code: "AUTH_STORAGE_ERROR" }, 503);
  }
}

export async function progressApi(request, env) {
  if (!env.DB) return authUnavailable();
  try {
    if (request.method === "GET") return await progressGet(request, env);
    if (request.method === "PUT") return await progressPut(request, env);
    return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  } catch {
    return json({ code: "PROGRESS_STORAGE_ERROR" }, 503);
  }
}
