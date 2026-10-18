import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Offline CSS-only regression: application scripts are removed and no network is allowed.
const chromium = process.env.CHROMIUM || "chromium";
const available = spawnSync(chromium, ["--version"]).status === 0 &&
  spawnSync("python3", ["-c", "import playwright.sync_api"]).status === 0;
const runner = String.raw`
import os, shutil, sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which(sys.argv[1]), headless=True,
        args=['--no-sandbox', '--disable-background-networking', '--disable-features=IsolateOrigins'])
    context = browser.new_context(viewport={'width': int(sys.argv[3]), 'height': int(sys.argv[4])},
        color_scheme=sys.argv[5], reduced_motion=sys.argv[6])
    page = context.new_page()
    requests = []
    page.on('request', lambda request: requests.append(request.url))
    page.goto(sys.argv[2], wait_until='domcontentloaded')
    page.locator('body[data-timer-test]').wait_for(state='attached', timeout=10000)
    print(page.locator('body').get_attribute('data-timer-test'))
    network = [url for url in requests if not url.startswith('file:')]
    if network:
        raise RuntimeError('unexpected network request: ' + network[0])
    if os.environ.get('TIMER_SCREENSHOTS'):
        os.makedirs(os.environ['TIMER_SCREENSHOTS'], exist_ok=True)
        # Capture each required visible state; no app.js is loaded to mutate user data.
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-idle.png'))
        page.evaluate("window.__timerTestState('running')")
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-running.png'))
        page.evaluate("window.__timerTestState('picker')")
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-picker.png'))
        if sys.argv[5] == 'light' and sys.argv[7].startswith('desktop'):
            page.emulate_media(color_scheme='dark')
            page.evaluate("window.__timerTestState('picker')")
            page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-picker-dark.png'))
    browser.close()
`;
const cssChecks = String.raw`
(() => {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const $ = id => document.getElementById(id);
  const desktop = matchMedia('(min-width:900px) and (min-height:560px)').matches;
  const box = element => element.getBoundingClientRect();
  const style = (element, pseudo = undefined) => getComputedStyle(element, pseudo);
  const visible = element => box(element).width > 0 && box(element).height > 0 && style(element).opacity !== '0';
  const overlap = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
  const center = (a, b) => Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 1.5;
  const main = $('fc-main'), focus = $('focus'), time = $('fc-time'), heading = $('fc-heading'), hist = $('fc-hist'), subj = $('fc-subj');
  check(main && focus && time && heading && hist && subj, 'timer structure is incomplete');
  check(document.querySelectorAll('.top-actions .icon-btn').length >= 4, 'header icons are missing');
  check(style(document.body).backgroundImage === 'none', 'unexpected body image/network asset');
  const assertBase = () => {
    check(visible(heading) && visible(hist), 'title/history must remain visible');
    check(box(time).width > 0 && box(time).height > 0, 'clock is not visible');
    check(!overlap(box(heading), box(time)), 'subject title overlaps clock');
    check(center(box(time), box(main)), 'clock is not centered inside main control');
    check(box(time).left >= box(main).left - 1 && box(time).right <= box(main).right + 1, 'clock overflows control');
  };
  const desktopChecks = () => {
    const top = document.querySelector('.top');
    check(style(top).display === 'grid', 'desktop header must use a three-column grid');
    check(style(top).gridTemplateColumns.split(' ').length === 3, 'desktop header is not three columns');
    check(box(focus).width > 0 && style(focus).maxWidth === 'none', 'focus is collapsed or capped');
    check(!overlap(box(focus), box(top.firstElementChild)), 'timer overlaps brand/date');
    check(!overlap(box(focus), box(document.querySelector('.top-actions'))), 'timer overlaps header actions');
    check(style(main).backgroundColor === 'rgba(0, 0, 0, 0)' || style(main).backgroundColor === 'transparent', 'fc-main has a background');
    check(style(main).borderTopWidth === '0px' && style(main).borderRightWidth === '0px', 'fc-main has a border');
    check(style(main, '::before').content === 'none' && style(main, '::after').content === 'none', 'fc-main pseudo decoration is active');
    check(style(focus).backgroundColor === 'rgba(0, 0, 0, 0)' || style(focus).backgroundColor === 'transparent', 'focus has a background');
    check(style(main).backgroundImage === 'none' && style(focus).backgroundImage === 'none', 'timer still has a painted background');
    check(style(focus, '::before').content === 'none' && style(focus, '::after').content === 'none', 'focus pseudo shell remains');
    check(style(focus).borderTopWidth === '0px', 'focus has an outer border');
    check(box(hist).left >= box(main).right - 1, 'history overlaps or precedes main control');
    check(Math.abs((box(focus).left + box(focus).right) / 2 - innerWidth / 2) < 2, 'focus is not viewport centered');
    const cols = style(focus).gridTemplateColumns;
    const trackSizes = cols.split(' ').filter(Boolean);
    check(trackSizes[0] === '44px' && trackSizes.at(-1) === '44px' && trackSizes.length >= 3, 'focus does not reserve 44px side columns');
  };
  const mobileChecks = () => {
    // These values mirror the unchanged mobile rules in git HEAD: stacked main and 40px clock.
    check(style(main).flexDirection === 'column', 'mobile direction changed from git HEAD');
    check(style(time).fontSize === (innerWidth < 900 ? '40px' : '44px'), 'mobile clock size changed from git HEAD');
    check(box(main).width <= innerWidth + 1 && box(focus).right <= innerWidth + 1, 'mobile control overflows viewport');
  };
  const assertState = state => {
    if (state === 'running') { focus.classList.remove('is-choosing'); subj.hidden = true; focus.classList.add('is-running'); heading.textContent = '英文'; time.textContent = '123:45:56'; }
    else if (state === 'picker') { focus.classList.remove('is-running'); focus.classList.add('is-choosing'); subj.hidden = false; heading.textContent = '열품타'; time.textContent = '1:40:00'; }
    else { focus.classList.remove('is-running', 'is-choosing'); subj.hidden = true; heading.textContent = '열품타'; time.textContent = '0:00:00'; }
    $('fc-goal').hidden = state === 'running';
    if (desktop) {
      check(style(time).display !== 'none' || state === 'picker', 'clock unexpectedly hidden');
      check(visible(heading) && visible(hist), 'title/history lost');
      if (state !== 'picker') {
        assertBase();
        check(center(box(time), {left:0,right:innerWidth}), 'time readout is not viewport centered');
      }
      if (state === 'picker') {
        check(style(time).display === 'none', 'picker clock should stay hidden');
        check(subj.querySelectorAll('button').length === 5, 'picker does not expose five subjects');
        const buttons = [...subj.querySelectorAll('button')];
        check(new Set(buttons.map(button => style(button).color)).size === 5, 'subjects do not have five distinct colors');
        if (matchMedia('(prefers-reduced-motion:reduce)').matches) {
          check(buttons.every(button => style(button).animationName === 'none' && style(button.querySelector('svg')).animationName === 'none'), 'reduced-motion animation remains');
        }
        // Settle entrance/spark animations before geometry and screenshot assertions.
        subj.querySelectorAll('*').forEach(element => element.getAnimations().forEach(animation => animation.finish()));
        check([...subj.querySelectorAll('button')].every(button => visible(button)), 'picker buttons are invisible');
        for (let i = 0; i < buttons.length; i++) {
          check(box(buttons[i]).left >= box(focus).left && box(buttons[i]).right <= box(focus).right, 'subject button overflows timer');
          check(box(buttons[i]).width >= 44 && box(buttons[i]).height >= 44, 'subject hit area is too small');
          for (let j = i + 1; j < buttons.length; j++) check(!overlap(box(buttons[i]), box(buttons[j])), 'subject buttons overlap');
        }
        check(style(subj).position !== 'fixed' && style(subj).position !== 'absolute', 'picker uses an overlay');
        check(style(subj).borderTopWidth === '0px', 'picker has an outer border');
        check([...subj.querySelectorAll('button')].every(button => !overlap(box(button), box(hist))), 'picker overlaps history');
      }
      check(!overlap(box(main), box(hist)), 'main/history overlap');
      check(!overlap(box(heading), box(time)), 'title/clock overlap');
      check(center(box(main), {left:0,right:innerWidth}), 'main is not centered in viewport');
      desktopChecks();
    } else { mobileChecks(); assertBase(); }
  };
  // Reproduce only app.js responsive placement; never load or execute app.js.
  document.body.dataset.tab = 'record';
  $('date').textContent = '2026-10-18　Sun';
  $('countdown').textContent = '倒數 153 天';
  if (desktop) document.querySelector('.top > div').after(focus);
  else document.querySelector('.rec .prog').after(focus);
  window.__timerTestState = state => assertState(state);
  try {
    assertState('idle'); assertState('running');
    for (const label of ['英文', '化學', '生物', '物理', '生化']) {
      heading.textContent = label; assertBase();
    }
    assertState('picker'); assertState('idle'); document.body.dataset.timerTest = 'PASS';
  }
  catch (error) { document.body.dataset.timerTest = 'FAIL: ' + error.message; }
})();`;

for (const [name, width, height, scheme, motion] of [
  ['desktop-900', 900, 560, 'light', 'no-preference'], ['desktop-1100', 1100, 700, 'light', 'reduce'],
  ['desktop-1560', 1560, 900, 'dark', 'no-preference'], ['desktop-1920', 1920, 1080, 'light', 'no-preference'],
  ['mobile', 390, 844, 'light', 'reduce'], ['breakpoint', 899, 800, 'dark', 'no-preference'], ['short', 1100, 550, 'light', 'reduce'],
]) {
  test(`offline timer CSS alignment: ${name}`, { skip: available ? false : 'requires Python Playwright and Chromium' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'timer-layout-'));
    try {
      await copyFile(new URL('style.css', import.meta.url), join(directory, 'style.css'));
      let html = await readFile(new URL('index.html', import.meta.url), 'utf8');
      html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'>`)
        .replace(/<link[^>]+rel="(?:manifest|icon|apple-touch-icon)"[^>]*>/g, '')
        .replace('</body>', `<script>${cssChecks}</script></body>`);
      const page = join(directory, 'index.html'); await writeFile(page, html);
      const result = spawnSync('python3', ['-c', runner, chromium, pathToFileURL(page).href,
        String(width), String(height), scheme, motion, name], {
        encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TIMER_SCREENSHOTS: process.env.TIMER_SCREENSHOTS || '' },
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.equal(result.stdout.trim(), 'PASS', result.stdout.trim() || 'CSS checks did not complete');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
