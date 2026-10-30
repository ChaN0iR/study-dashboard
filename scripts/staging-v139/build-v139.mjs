// Build-only, never deploys. No network, npm dependency, credentials or Worker calls.
// Produce a synthetic copy of the PR45 dashboard while preserving its exact SW.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const CANDIDATE_SHA = "b83c37688990fe215706ec18cc43a1965bc1c2f9";
export const CACHE = "sd-v139";
const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = join(root, "docs");
const read = (name) => readFileSync(join(docs, name), "utf8");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const replaceOnce = (value, old, updated, label) => {
  if (value.split(old).length !== 2) throw new Error("Unique staging transformation missing: " + label);
  return value.replace(old, updated);
};
const reject = (value, reason) => { if (!value) throw new Error(reason); };

export function build(outDirectory) {
  const out = resolve(outDirectory);
  reject(out !== root && !out.startsWith(docs + "/") && out !== docs,
    "Output must not overwrite the checked-in source docs");
  reject(!existsSync(out) || readdirSync(out).length === 0,
    "Output must be a new or empty folder, never overwrite a previously inspected package");

  const sw = read("sw.js");
  const baseline = execFileSync("git", ["show", CANDIDATE_SHA + ":docs/sw.js"], {
    cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024
  });
  reject(sw === baseline, "SW has changed since the exact PR45 browser-tested candidate");
  reject(sw.includes('const CACHE = "' + CACHE + '";'),
    "Unexpected PR45 cache version");
  const shellMatch = sw.match(/^const SHELL = (\[[^\n]+\]);$/m);
  reject(shellMatch !== null, "Cannot parse candidate static shell");
  const shell = JSON.parse(shellMatch[1]);
  reject(Array.isArray(shell) && new Set(shell).size === shell.length,
    "Candidate shell contains duplicates");

  mkdirSync(out, { recursive: true });
  const artifacts = new Set();
  for (const entry of shell) {
    if (entry === "./") continue;
    const pathname = entry.split("?")[0];
    reject(/^[\w./-]+$/.test(pathname) && !pathname.startsWith("/") &&
      !pathname.includes(".."), "Unsafe static shell path: " + entry);
    if (artifacts.has(pathname)) continue;
    const from = join(docs, pathname);
    reject(existsSync(from), "Candidate shell asset missing: " + pathname);
    // No source asset (including scripts/icons) may drift from the exact
    // PR45 candidate. Staging-only overrides are applied AFTER this guard.
    const originalAsset = execFileSync("git", ["show", CANDIDATE_SHA + ":docs/" + pathname], {
      cwd: root, maxBuffer: 10 * 1024 * 1024
    });
    reject(readFileSync(from).equals(originalAsset),
      "Staging source asset drifted from PR45 candidate: " + pathname);
    mkdirSync(dirname(join(out, pathname)), { recursive: true });
    copyFileSync(from, join(out, pathname));
    artifacts.add(pathname);
  }

  // SW is not a shell entry. Copy it independently, and preserve the
  // byte-for-byte candidate that governs privacy and offline fallback.
  copyFileSync(join(docs, "sw.js"), join(out, "sw.js"));
  reject(sha(readFileSync(join(out, "sw.js"))) === sha(sw),
    "Candidate SW byte identity failed");

  // All payloads, history and backend operations must be synthetic.
  // The preview app differs only through these explicit forced-demo rewrites.
  let app = read("app.js");
  app = replaceOnce(app, 'const DEMO = qs.get("demo") === "1";',
    'const DEMO = true; // STAGING ONLY: never reach real APIs', "force synthetic backend");
  app = replaceOnce(app,
    'if (qs.get("api")) localStorage.setItem("apiBase", qs.get("api"));',
    '// STAGING ONLY: ignore ?api; never store a user-provided backend', "disable backend override");
  app = replaceOnce(app,
    'const apiBase = () => (localStorage.getItem("apiBase") || C.API_BASE || "").replace(/\\/+$/, "");',
    'const apiBase = () => ""; // STAGING ONLY', "disable persisted backend");
  app = replaceOnce(app,
    'if (qs.get("ui") === "v2") {',
    'if (true) { // STAGING ONLY: always show the candidate V2 opt-in UI', "force V2");
  reject(app.includes('const DEMO = true;') && app.includes('const apiBase = () => "";'),
    "Synthetic-only app guard missing");
  writeFileSync(join(out, "app.js"), app);

  const config = {
    EXAM_DATE: "2027-03-20", BASE_DONE: {}, DONE_TITLES: {}, API_BASE: "",
    MOODS: ["很好", "普通", "低落"],
    SUBJECTS: ["化學", "物理", "生物", "生化", "英文"],
    SCHEDULE: [], WAKE: "07:00", BED: "22:00"
  };
  writeFileSync(join(out, "config.js"), "window.CONFIG = " +
    JSON.stringify(config, null, 2) + ";\n");

  const manifest = JSON.parse(read("manifest.webmanifest"));
  manifest.name = "PR45 STAGING ONLY";
  manifest.short_name = "PR45測試";
  manifest.start_url = "./?demo=1&ui=v2";
  writeFileSync(join(out, "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");

  let html = read("index.html");
  html = replaceOnce(html, "<title>清大後醫</title>",
    "<title>PR45 STAGING ONLY · V2 合成測試</title>", "title");
  html = replaceOnce(html,
    '<meta name="apple-mobile-web-app-title" content="讀書">',
    '<meta name="apple-mobile-web-app-title" content="PR45測試">',
    "iPhone home-screen label");
  html = replaceOnce(html, "<head>",
    '<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\'; img-src \'self\' data: blob:; style-src \'self\' \'unsafe-inline\'; script-src \'self\' \'unsafe-inline\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'">',
    "restrict preview origins");
  html = html.replace(/href="https?:\/\/[^"]+"/g,
    'href="#" aria-disabled="true" data-staging-external="disabled"');
  reject(!/href="https?:\/\//.test(html), "Unexpected external HTML link remains");
  html = replaceOnce(html, '<script src="recall-room.js?v=1"></script>',
    "<!-- STAGING ONLY: recall-room links deliberately disabled -->", "disable Recall Room external redirects");
  const banner = '<aside id="pr45-staging-banner" role="status" style="padding:8px 14px;background:#263e36;color:#f1f7f2;font:600 12px/1.35 system-ui;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px"><span>PR #43 · STAGING ONLY · 假資料，不連正式 API</span><button type="button" id="pr45-qa-open" style="font:600 12px system-ui;padding:6px 8px;border-radius:8px;border:1px solid #bedbca;color:#fff;background:#294b3a">驗收</button></aside>';
  html = replaceOnce(html, "<body>", "<body>\n" + banner, "visible staging banner");

  const qa = readFileSync(new URL("./v139-diagnostics.js", import.meta.url), "utf8");
  reject(qa.includes("PR45_STAGING_DIAGNOSTICS"), "Missing intended synthetic QA script");
  html = replaceOnce(html, "</body>",
    '<script>\n' + qa + '\n</script>\n</body>', "embedded offline-capable QA");
  writeFileSync(join(out, "index.html"), html);

  // Cloudflare Pages normally canonicalizes /index.html to /. An internal
  // rewrite keeps SW install's 'redirect:error' safe; no SPA API fallback.
  writeFileSync(join(out, "_redirects"),
    "/index.html / 200\n");
  writeFileSync(join(out, "404.html"),
    "<!doctype html><html lang=\"zh-Hant\"><meta charset=\"utf-8\"><title>404 · PR45 STAGING ONLY</title><body><h1>404 · 合成測試沒有此路由</h1></body></html>\n");
  writeFileSync(join(out, "_headers"),
    "/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n/sw.js\n  Cache-Control: no-cache, no-store, must-revalidate\n");
  // The public result is not an attestation of a deployed environment.
  const report = {
    mode: "STAGING_ONLY_OFFLINE_BUILD", candidate: CANDIDATE_SHA,
    cache: CACHE, swSha256: sha(sw), appSha256: sha(app),
    sourceSWIdentical: true, sourceAssetsPinned: true, backendEnabled: false,
    demoForced: true, v2Forced: true,
    fileCount: artifacts.size + 3,
    operations: { cloudflareDeploys: 0, notionCalls: 0, workerCalls: 0 },
    manualGate: "iPhone Installed PWA test and explicit release authorization still required"
  };
  writeFileSync(join(out, "BUILD-EVIDENCE.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: node scripts/staging/build-pr45.mjs <empty-output-dir>");
  console.log(JSON.stringify(build(destination)));
}
