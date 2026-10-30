import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const bridge = readFileSync(new URL("./ui-live-v2.js", import.meta.url), "utf8");
const style = readFileSync(new URL("./ui-live-v2.css", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("live V2 is only loaded through explicit ?ui=v2 flag", () => {
  assert.match(app, /if \(qs\.get\("ui"\) === "v2"\)/);
  assert.match(app, /import\("\.\/ui-live-v2\.js"\)/);
  assert.match(app, /mountLiveV2\(\)/);
  assert.doesNotMatch(html, /ui-live-v2/);
  assert.doesNotMatch(app, /(?<!ui-)renderUiPilot\(/);
});

test("V2 bridges existing tasks instead of storing or writing duplicate state", () => {
  assert.match(bridge, /document\.querySelector\("#tasks"\)/);
  assert.match(bridge, /document\.querySelector\("#task-count"\)/);
  assert.match(bridge, /querySelector\("\.task-activity"\)\?\.textContent/);
  assert.match(bridge, /new MutationObserver\(queueRender\)/);
  assert.doesNotMatch(bridge, /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|WebSocket|navigator\.serviceWorker/);
  assert.doesNotMatch(bridge, /window\.CONFIG|\/api\/|NOTION_TOKEN|APP_KEY|setInterval/);
  assert.doesNotMatch(bridge, /\.setAttribute\(\s*["']aria-checked["']|\.classList\.add\(\s*["']done["']\)/);
});

test("V2 cannot inadvertently stop real focus session on navigation", () => {
  assert.match(bridge, /button\[data-t="record"\]/);
  assert.match(bridge, /querySelector\("#fc-main"\)/);
  assert.match(bridge, /timer\?\.focus\(/);
  assert.doesNotMatch(bridge, /timer\?\.click\(|#fc-main"\)\.click\(/);
  assert.doesNotMatch(bridge, /dispatchEvent\(|\.submit\(/);
});

test("private API failures and optimistic task updates remain visibly unverified", () => {
  assert.match(bridge, /dataUnavailable = !match/);
  assert.match(bridge, /tasks\.dataset\.stateVerified !== "true"/);
  assert.match(app, /\$\("tasks"\)\.dataset\.stateVerified = "true"/);
  assert.match(app, /\$\("tasks"\)\.dataset\.stateVerified = "false"/);
  assert.match(bridge, /attributeFilter: \["aria-checked", "disabled", "data-state-verified"\]/);
  assert.match(bridge, /renderedDate\.startsWith\(taipeiDate\)/);
  assert.match(bridge, /更新中（未確認）/);
  assert.match(bridge, /同步狀態 · 未驗證/);
  assert.match(bridge, /目前沒有顯示任務/);
  assert.match(bridge, /taskButton\.disabled = !next/);
});

test("scoped styling preserves existing desktop, mobile, and reduced-motion behavior", () => {
  assert.match(style, /body\.sd-v2-live/);
  assert.match(style, /@media \(min-width:900px\) and \(min-height:560px\)/);
  assert.match(style, /@media \(max-width:899px\)/);
  assert.match(style, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(style, /:focus-visible/);
  assert.doesNotMatch(style, /(^|\n)(?:main|html|body|\.card|\.tabs)\s*\{/);
});
