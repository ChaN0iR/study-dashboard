import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Optional CSS-only regression: Python Playwright + Chromium. No app JS or live services.
// CHROMIUM overrides the browser executable; TIMER_SCREENSHOTS saves visual evidence.
const chromium = process.env.CHROMIUM || "chromium";
const available = spawnSync(chromium, ["--version"]).status === 0 &&
  spawnSync("python3", ["-c", "import playwright.sync_api"]).status === 0;
const runner = String.raw`
import os, sys, shutil
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which(sys.argv[1]), headless=True,
        args=['--no-sandbox', '--disable-background-networking'])
    page = browser.new_page(viewport={'width': int(sys.argv[3]), 'height': int(sys.argv[4])})
    page.goto(sys.argv[2], wait_until='domcontentloaded')
    page.locator('body[data-timer-test]').wait_for(state='attached', timeout=10000)
    print(page.locator('body').get_attribute('data-timer-test'))
    if os.environ.get('TIMER_SCREENSHOTS'):
        os.makedirs(os.environ['TIMER_SCREENSHOTS'], exist_ok=True)
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[5] + '.png'))
    browser.close()
`;
const cssChecks = String.raw`
(() => {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const $ = id => document.getElementById(id);
  const desktop = matchMedia('(min-width:900px) and (min-height:560px)').matches;
  const box = element => element.getBoundingClientRect();
  const visible = element => box(element).width > 0 && box(element).height > 0;
  // Reproduce only app.js's responsive placement; never load or execute app.js.
  document.body.dataset.tab = 'record';
  if (desktop) document.querySelector('.top > div').after($('focus'));
  else document.querySelector('.rec .prog').after($('focus'));
  const centered = () => {
    const main = box($('fc-main')), clock = box($('fc-time')), title = box($('fc-heading'));
    check(Math.abs(clock.left + clock.width / 2 - main.left - main.width / 2) < 1,
      'clock is not centered inside the main timer control');
    check(clock.left >= main.left && clock.right <= main.right, 'clock overflows control');
    check(title.bottom <= clock.top, 'subject title overlaps clock');
    check(visible($('fc-heading')) && visible($('fc-hist')), 'title/history must remain visible');
    if (desktop) check(box($('fc-hist')).left >= main.right, 'history overlaps main control');
  };
  try {
    centered();
    for (const label of ['英文', '化學', '生物', '物理', '生化']) {
      $('focus').classList.add('is-running');
      $('fc-heading').textContent = label;
      $('fc-time').textContent = '123:45:56';
      centered();
    }
    $('focus').classList.remove('is-running');
    $('fc-heading').textContent = '열품타';
    $('fc-time').textContent = '1:40:00';
    if (desktop) {
      $('focus').classList.add('is-choosing');
      $('fc-subj').hidden = false;
      check(getComputedStyle($('fc-time')).display === 'none', 'picker clock should stay hidden');
      check(visible($('fc-heading')) && visible($('fc-hist')), 'picker title/history lost');
      $('focus').classList.remove('is-choosing');
      $('fc-subj').hidden = true;
    } else {
      check(getComputedStyle($('fc-main')).flexDirection === 'column', 'mobile direction changed');
      const expectedSize = innerWidth < 900 ? '40px' : '44px';
      check(getComputedStyle($('fc-time')).fontSize === expectedSize, 'responsive clock size changed');
    }
    centered();
    document.body.dataset.timerTest = 'PASS';
  } catch (error) { document.body.dataset.timerTest = 'FAIL: ' + error.message; }
})();`;

for (const [name, width, height] of [
  ["desktop", 1440, 1000], ["narrow desktop", 900, 800],
  ["desktop breakpoint", 899, 800], ["mobile", 390, 844], ["short viewport", 1100, 550],
]) {
  test(`offline timer CSS alignment: ${name}`, {
    skip: available ? false : "requires Python Playwright and Chromium",
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "timer-layout-"));
    try {
      await copyFile(new URL("style.css", import.meta.url), join(directory, "style.css"));
      let html = await readFile(new URL("index.html", import.meta.url), "utf8");
      // Read existing markup, strip every application script, and prohibit connections.
      html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'">`)
        .replace(/<link[^>]+rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, "")
        .replace("</body>", `<script>${cssChecks}</script></body>`);
      const page = join(directory, "index.html");
      await writeFile(page, html);
      const result = spawnSync("python3", [
        "-c", runner, chromium, pathToFileURL(page).href,
        String(width), String(height), name.replaceAll(" ", "-"),
      ], { encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.equal(result.stdout.trim(), "PASS", result.stdout.trim() || "CSS checks did not complete");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
