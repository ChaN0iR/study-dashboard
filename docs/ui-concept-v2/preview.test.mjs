import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("./", import.meta.url);
const html = readFileSync(new URL("index.html", root), "utf8");
const js = readFileSync(new URL("controller-v2.js", root), "utf8");

test("V2 preview stays isolated from production resources and user persistence", () => {
  assert.match(html, /純示範資料/);
  assert.match(html, /<script src="controller-v2\.js" defer><\/script>/);
  assert.doesNotMatch(html + js, /fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|NOTION_TOKEN|APP_KEY/);
  assert.doesNotMatch(html, /<iframe\b|<form\b[^>]*\baction=/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc="https?:/i);
});

test("desktop and mobile navigation share matching panels", () => {
  for (const name of ["today", "progress", "achievements", "notes"]) {
    assert.equal((html.match(new RegExp('data-view="' + name + '"', "g")) || []).length, 2, name);
    assert.match(html, new RegExp('data-panel="' + name + '"'));
  }
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /:focus-visible/);
});

test("dynamic next task and focus controls are accessible", () => {
  assert.match(html, /id="next-title" aria-live="polite"/);
  for (const id of ["task-meter", "task-list", "start-focus", "timer-toggle", "timer-reset", "toast"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(js, /addEventListener\("change", syncTasks\)/);
  assert.match(js, /classList\.toggle\("is-complete", !next\)/);
  assert.match(js, /let hasStarted = false/);
  assert.match(js, /if \(timer === null && !hasStarted\)/);
});
