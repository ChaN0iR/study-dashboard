import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const match = source.match(/\$\("anki-link"\)\.addEventListener\("click", \(e\) => \{([\s\S]*?)\n\s*\}\);\s*\n\s*\$\("hevy-link"\)/);
assert.ok(match, "Anki click handler exists");
const handlerBody = match[1];

async function clickAnki(userAgent, shouldReject = false) {
  const effects = [];
  const timers = [];
  const listeners = new Map();
  const location = { _href: "https://dashboard.example/", set href(value) { this._href = value; effects.push(["location", value]); }, get href() { return this._href; } };
  const window = {
    addEventListener(name, listener, options) { effects.push(["addListener", name, options]); listeners.set(name, listener); },
    removeEventListener(name, listener) { effects.push(["removeListener", name]); if (listeners.get(name) === listener) listeners.delete(name); },
    open(...args) { effects.push(["window.open", ...args]); },
  };
  const ankiCall = (action) => {
    effects.push(["ankiCall", action]);
    return shouldReject ? Promise.reject(new Error("AnkiConnect unavailable")) : Promise.resolve({});
  };
  const context = {
    navigator: { userAgent }, location, window, document: { hidden: false }, ankiCall,
    setTimeout(callback, delay) { effects.push(["setTimeout", delay]); timers.push(callback); return timers.length; },
  };
  const clickHandler = vm.runInNewContext(`(function(e) {${handlerBody}\n})`, context);
  clickHandler({ preventDefault() { effects.push(["preventDefault"]); } });
  await Promise.resolve();
  await Promise.resolve();
  return { effects, timers, listeners };
}

test("desktop success keeps the AnkiConnect deck-browser launch", async () => {
  const { effects, timers } = await clickAnki("Windows NT 10.0", false);
  assert.ok(effects.some(([kind, action]) => kind === "ankiCall" && action === "guiDeckBrowser"));
  assert.equal(timers.length, 0);
  assert.ok(!effects.some(([kind]) => kind === "window.open" || kind === "location"));
});

test("desktop AnkiConnect failure still tries the existing Anki app URI, waits 2500ms, and never opens a website", async () => {
  for (const trigger of ["timeout-before-launch", "window-blur-before-timeout"]) {
    const result = await clickAnki("Windows NT 10.0", true);
    const { effects, timers, listeners } = result;
    assert.ok(effects.some(([kind, action]) => kind === "ankiCall" && action === "guiDeckBrowser"));
    assert.ok(effects.some(([kind, uri]) => kind === "location" && uri === "anki://"));
    assert.ok(effects.some(([kind, event, options]) => kind === "addListener" && event === "blur" && options.once === true));
    assert.ok(effects.some(([kind, delay]) => kind === "setTimeout" && delay === 2500));
    assert.equal(timers.length, 1);

    if (trigger === "window-blur-before-timeout") listeners.get("blur")();
    timers[0]();
    assert.ok(effects.some(([kind, event]) => kind === "removeListener" && event === "blur"));
    assert.ok(!effects.some(([kind]) => kind === "window.open"));
    assert.ok(!effects.some(([kind, value]) => kind === "location" && /^https?:/.test(value)));
  }
});

test("iOS and Android launch branches remain unchanged", async () => {
  const ios = await clickAnki("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", false);
  assert.ok(ios.effects.some(([kind, uri]) => kind === "location" && uri === "anki://"));
  assert.ok(!ios.effects.some(([kind]) => kind === "ankiCall" || kind === "window.open"));

  const android = await clickAnki("Mozilla/5.0 (Linux; Android 15)", false);
  const intent = android.effects.find(([kind, uri]) => kind === "location" && typeof uri === "string")?.[1];
  assert.match(intent, /^intent:\/\//);
  assert.match(intent, /package=com\.ichi2\.anki/);
  assert.match(intent, /browser_fallback_url=https%3A%2F%2Fankiweb\.net%2Fdecks/);
  assert.ok(!android.effects.some(([kind]) => kind === "ankiCall" || kind === "window.open"));
});
