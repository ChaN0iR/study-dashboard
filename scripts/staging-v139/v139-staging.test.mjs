import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build, CACHE, CANDIDATE_SHA } from "./build-v139.mjs";
import { execFileSync } from "node:child_process";

const hash = (x) => createHash("sha256").update(x).digest("hex");
const root = new URL("../../", import.meta.url);
function withBuild(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pr45-synthetic-"));
  try { const result = build(dir); return fn(dir, result); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const contentOf = (dir, name) => readFileSync(join(dir, name), "utf8");

test("synthetic build pins the exact checked candidate service worker", () => withBuild((dir, r) => {
  const source = execFileSync("git", ["show", CANDIDATE_SHA + ":docs/sw.js"], {
    cwd: root, encoding: "utf8"
  });
  assert.equal(contentOf(dir, "sw.js"), source);
  assert.equal(r.swSha256, hash(source));
  assert.equal(r.cache, CACHE);
  assert.equal(r.sourceSWIdentical, true);
  assert.equal(r.sourceAssetsPinned, true);
  assert.equal(r.candidate, "b83c37688990fe215706ec18cc43a1965bc1c2f9");
  assert.deepEqual(r.operations, { cloudflareDeploys: 0, notionCalls: 0, workerCalls: 0 });
}));

test("preview disables all real API access and previously completed personal history", () => withBuild((dir) => {
  const js = contentOf(dir, "app.js");
  const config = contentOf(dir, "config.js");
  const html = contentOf(dir, "index.html");
  const manifest = JSON.parse(contentOf(dir, "manifest.webmanifest"));
  assert.match(js, /const DEMO = true;/);
  assert.match(js, /const apiBase = \(\) => "";/);
  assert.match(js, /dataset\.stateVerified = "false"/);
  assert.match(js, /dataset\.stateVerified = "true"/);
  assert.match(js, /if \(true\) \{\s*\/\/ STAGING ONLY: always show/);
  assert.doesNotMatch(js, /if \(qs\.get\("api"\)\) localStorage\.setItem/);
  assert.match(config, /"API_BASE": ""/);
  assert.match(config, /"DONE_TITLES": \{\}/);
  assert.match(config, /"SCHEDULE": \[\]/);
  assert.doesNotMatch(config, /study-dashboard-api|NOTION_TOKEN|APP_KEY/);
  assert.match(html, /PR #43 · STAGING ONLY/);
  assert.match(html, /PR45_STAGING_DIAGNOSTICS/);
  assert.doesNotMatch(html, /href="https?:\/\//);
  assert.doesNotMatch(html, /src="recall-room.js/);
  assert.match(html, /connect-src 'self'/);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./?demo=1&ui=v2");
  assert.equal(manifest.short_name, "PR45測試");
}));

test("the entire strict SW static shell is copied, and no live private backend is packaged", () => withBuild((dir) => {
  const sw = contentOf(dir, "sw.js");
  const shell = JSON.parse(sw.match(/^const SHELL = (\[[^\n]+\]);$/m)[1]);
  for (const url of shell) {
    if (url === "./") continue;
    const name = url.split("?")[0];
    assert.ok(readFileSync(join(dir, name)).length > 0, name);
  }
  assert.equal(contentOf(dir, "_redirects").trim(), "/index.html / 200");
  assert.match(contentOf(dir, "_headers"), /noindex, nofollow/);
  assert.match(contentOf(dir, "_headers"), /Content-Security-Policy: default-src 'self'; connect-src 'self'/);
  assert.match(contentOf(dir, "_headers"), /frame-ancestors 'none'/);
  assert.match(contentOf(dir, "404.html"), /404/);
  assert.ok(readdirSync(dir).length > 5);
}));

test("the synthetic iPhone checker fails closed on missing steps and never issues a real API", () => withBuild((dir) => {
  const html = contentOf(dir, "index.html");
  assert.match(html, /fixture: "pr45-installed-pwa-v1"/);
  assert.match(html, /v\.stage !== "online-pass"/);
  assert.match(html, /v\.stage !== "offline-pass"/);
  assert.match(html, /status = "FAIL"/);
  assert.match(html, /offlinePrivateApiRejected/);
  assert.match(html, /candidateController/);
  assert.match(html, /syntheticStaleMarkerBlocksHero/);
  assert.match(html, /syntheticMarkerRecovery/);
  assert.match(html, /tasks\.dataset\.stateVerified = "false"/);
  assert.match(html, /tasks\.dataset\.stateVerified = "true"/);
  assert.match(html, /目前無法確認下一項任務/);
  assert.match(html, /installedStandalone/);
  assert.match(html, /XMLHttpRequest/);
  assert.doesNotMatch(html, /https:\/\/api\.notion\.com|https:\/\/study-dashboard-api/);
}));

test("the builder refuses to overwrite the project source or a populated package", () => {
  assert.throws(() => build(new URL("../../docs", import.meta.url).pathname),
    /must not overwrite/);
  withBuild((dir) => assert.throws(() => build(dir), /new or empty folder/));
});
