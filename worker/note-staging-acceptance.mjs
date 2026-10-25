// Standalone, serial CLI only. Never imported by the deployed Worker.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import worker from "./index.js";
import { DB, P } from "./config.js";

export const STAGING_TITLE = "Study Dashboard STAGING ONLY";
const normalize = (value) => String(value || "").replaceAll("-", "").toLowerCase();
const idPattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const productionIds = new Set(Object.values(DB).map(normalize));
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
let running = false;

export async function runAcceptance({ mode = "plan", databaseId, token, confirmation,
  fetchImpl = globalThis.fetch } = {}) {
  if (mode === "plan") return {
    mode, networkCalls: 0, writes: 0, requiredDatabaseTitle: STAGING_TITLE,
    actions: ["validate isolated database and schema", "upload two synthetic 1px PNGs",
      "create one synthetic two-page note", "read back its blocks; no automatic retry or cleanup"],
  };
  if (mode !== "live") throw new Error("Unknown acceptance mode");
  if (!idPattern.test(databaseId || "") || productionIds.has(normalize(databaseId)))
    throw new Error("An isolated, non-production database ID is required");
  if (confirmation !== `WRITE SYNTHETIC NOTE TO ${normalize(databaseId)}`)
    throw new Error("Explicit confirmation of the isolated destination is required");
  if (!token) throw new Error("A separately supplied staging integration token is required");
  if (running) throw new Error("Only one staging acceptance may run per process");
  running = true;

  const originalFetch = globalThis.fetch;
  const originalNotes = DB.notes;
  const uploads = new Set();
  const uploadIds = new Set();
  let uploadsCreated = 0;
  let uploadsSent = 0;
  let pageId;
  let pageCreateAttempted = false;
  let stage = "database-preflight";
  let networkCalls = 0;
  const title = `[STAGING ACCEPTANCE] ${randomUUID()}`;
  const call = async (path, init = {}) => {
    networkCalls++;
    // No redirects, retries, arbitrary host or caller-controlled API base URL.
    return fetchImpl(`https://api.notion.com/v1${path}`, {
      ...init, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28", ...init.headers },
    });
  };
  const json = async (response) => {
    if (!response.ok) throw new Error("Notion request failed");
    return response.json();
  };
  try {
    const database = await json(await call(`/databases/${normalize(databaseId)}`));
    const dbTitle = (database.title || []).map((t) => t.plain_text ?? t.text?.content ?? "").join("");
    if (normalize(database.id) !== normalize(databaseId) || database.archived || database.in_trash ||
        dbTitle !== STAGING_TITLE) throw new Error("Database identity or staging title mismatch");
    for (const [name, type] of [[P.note.title, "title"], [P.note.date, "date"], [P.note.status, "select"]]) {
      if (database.properties?.[name]?.type !== type) throw new Error("Staging note schema mismatch");
    }
    if (!database.properties[P.note.status].select?.options?.some((o) => o.name === "未複習"))
      throw new Error("Staging review-status option must already exist");

    // Reuse the actual candidate handler with an in-memory destination override.
    // This process has no Cloudflare bindings and never calls a deployed API.
    DB.notes = normalize(databaseId);
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method || "GET";
      if (url.origin !== "https://api.notion.com" || url.search || url.hash)
        throw new Error("Blocked unexpected acceptance destination");
      if (method === "POST" && url.pathname === "/v1/file_uploads" && uploadsCreated < 2) {
        uploadsCreated++;
        const response = await call("/file_uploads", init);
        const data = await json(response.clone());
        if (!idPattern.test(data.id || "") || uploadIds.has(normalize(data.id))) throw new Error("Invalid upload identity");
        uploadIds.add(normalize(data.id));
        uploads.add(data.id);
        return response;
      }
      const upload = url.pathname.match(/^\/v1\/file_uploads\/([^/]+)\/send$/);
      if (method === "POST" && upload && uploads.has(upload[1])) {
        uploads.delete(upload[1]);
        const response = await call(`/file_uploads/${upload[1]}/send`, init);
        if (response.ok) uploadsSent++;
        return response;
      }
      if (method === "POST" && url.pathname === "/v1/pages" && !pageCreateAttempted) {
        const body = JSON.parse(init.body);
        if (uploadsSent !== 2 || normalize(body.parent?.database_id) !== normalize(databaseId) ||
            body.properties?.[P.note.title]?.title?.[0]?.text?.content !== title)
          throw new Error("Blocked page outside synthetic staging destination");
        pageCreateAttempted = true;
        stage = "page-create-unknown";
        const response = await call("/pages", init);
        const page = await json(response.clone());
        if (!idPattern.test(page.id || "")) throw new Error("Invalid created page identity");
        pageId = page.id;
        if (normalize(page.parent?.database_id) !== normalize(databaseId) || page.archived || page.in_trash ||
            page.properties?.[P.note.title]?.title?.map((t) => t.plain_text ?? t.text?.content ?? "").join("") !== title)
          throw new Error("Created page identity mismatch");
        stage = "readback";
        return response;
      }
      throw new Error("Blocked unexpected acceptance operation");
    };
    stage = "upload-and-create";
    const response = await worker.fetch(new Request("https://acceptance.invalid/api/note", {
      method: "POST", headers: { "content-type": "application/json", "x-app-key": "local-staging-only" },
      body: JSON.stringify({ title, pages: [1, 2].map(() => ({ photos: [
        { name: "synthetic-1px.png", type: "image/png", data: image },
      ] })) }),
    }), { APP_KEY: "local-staging-only", NOTION_TOKEN: token });
    if (!response.ok || !pageId) throw new Error("Candidate note request did not complete");
    const result = await response.json();
    if (normalize(result.id) !== normalize(pageId) || result.title !== title || result.photos !== 2)
      throw new Error("Candidate note response mismatch");
    const blocks = await json(await call(`/blocks/${pageId}/children?page_size=100`));
    if (blocks.has_more || blocks.results?.map((b) => b.type).join(",") !== "paragraph,image,paragraph,image" ||
        blocks.results[0].paragraph.rich_text.map((t) => t.plain_text ?? t.text?.content ?? "").join("") !== "第 1 頁" ||
        blocks.results[2].paragraph.rich_text.map((t) => t.plain_text ?? t.text?.content ?? "").join("") !== "第 2 頁")
      throw new Error("Created note block readback mismatch");
    const images = [blocks.results[1], blocks.results[3]];
    if (images.some((block) => !idPattern.test(block.id || "") || block.image?.type !== "file" ||
        !URL.canParse(block.image.file?.url) || new URL(block.image.file.url).protocol !== "https:") ||
        normalize(images[0].id) === normalize(images[1].id))
      throw new Error("Created image file readback mismatch");
    return { mode, status: "PASS", pageId, networkCalls, photos: 2, cleanup: "manual review only" };
  } catch {
    // Do not echo upstream errors, tokens, signed file URLs, or note contents.
    const error = new Error(`Staging acceptance failed at ${stage}; do not retry page creation automatically`);
    error.evidence = { stage, pageId: pageId || null, pageCreateAttempted, networkCalls };
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
    DB.notes = originalNotes;
    running = false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1 || (args[0] && args[0] !== "--live")) throw new Error("Use no arguments for offline plan, or --live");
    console.log(JSON.stringify(await runAcceptance({ mode: args[0] ? "live" : "plan",
      databaseId: process.env.NOTION_STAGING_DATABASE_ID,
      token: process.env.NOTION_STAGING_TOKEN,
      confirmation: process.env.NOTION_STAGING_CONFIRM,
    })));
  } catch (error) {
    console.error(JSON.stringify({ status: "FAIL", error: error.message, ...error.evidence }));
    process.exitCode = 1;
  }
}
