import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test('static PWA shell references and CSS cache-bust', async () => {
  const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
  const sw = await readFile(new URL('sw.js', import.meta.url), 'utf8');
  const shell = JSON.parse(sw.match(/^const SHELL = (\[[^\n]+\]);$/m)[1]);
  const cache = sw.match(/^const CACHE = "([^"]+)";$/m)[1];
  const refs = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)]
    .map(match => match[1]);
  const cssRefs = refs.filter(ref => /^style\.css(?:\?|$)/.test(ref));
  assert.deepEqual(cssRefs, ['style.css?v=124']);
  assert.deepEqual(shell.filter(ref => /^style\.css(?:\?|$)/.test(ref)), cssRefs);
  assert.equal(cache, 'sd-v134');
  assert.equal(new Set(shell).size, shell.length, 'duplicate shell reference');
  assert.ok(!sw.includes('style.css?v=119') && !html.includes('style.css?v=119'), 'stale CSS URL');
  for (const ref of refs) assert.ok(shell.includes(ref), `index reference missing from shell: ${ref}`);
  for (const ref of shell) await access(new URL(ref.split('?')[0], import.meta.url));
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', import.meta.url), 'utf8'));
  for (const { src } of manifest.icons) {
    assert.ok(shell.some(ref => ref.split('?')[0] === src.split('?')[0]), `manifest icon missing from shell: ${src}`);
    await access(new URL(src.split('?')[0], import.meta.url));
  }
});

// Offline CSS-only regression: application scripts are removed and no network is allowed.
const chromium = process.env.CHROMIUM || "chromium";
const available = spawnSync(chromium, ["--version"]).status === 0 &&
  spawnSync("python3", ["-c", "import playwright.sync_api"]).status === 0;
const runner = String.raw`
import json, os, shutil, sys
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
        # Freeze transitions before state changes, not only during the capture itself.
        page.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important}')
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-idle.png'), animations='disabled')
        page.evaluate("window.__timerTestState('running')")
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-running.png'), animations='disabled')
        page.evaluate("window.__timerTestState('picker')")
        page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-picker.png'), animations='disabled')
        if sys.argv[5] == 'light' and sys.argv[7].startswith('desktop'):
            page.emulate_media(color_scheme='dark')
            page.evaluate("window.__timerTestState('picker')")
            page.screenshot(path=os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-picker-dark.png'), animations='disabled')
        with open(os.path.join(os.environ['TIMER_SCREENSHOTS'], sys.argv[7] + '-geometry.json'), 'w') as report:
            json.dump(page.evaluate('window.__timerGeometry'), report, ensure_ascii=False, indent=2)
    browser.close()
`;
const cssChecks = String.raw`
(() => {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const $ = id => document.getElementById(id);
  const desktop = matchMedia('(min-width:900px) and (min-height:560px)').matches;
  if (desktop) {
    // Measure the resting layout, not an arbitrary frame of the pencil's rotation.
    const stableIcon = document.createElement('style');
    stableIcon.textContent = '.top>.focus #fc-subject-icon{animation:none!important}';
    document.head.append(stableIcon);
  }
  const box = element => element.getBoundingClientRect();
  const style = (element, pseudo = undefined) => getComputedStyle(element, pseudo);
  const visible = element => box(element).width > 0 && box(element).height > 0 && style(element).opacity !== '0';
  const overlap = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
  const center = (a, b) => Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 1.5;
  const near = (a, b) => Math.abs(a - b) < 1;
  const actions = document.querySelector('.top-actions');
  const shortcuts = [...actions.querySelectorAll('.icon-btn')];
  const shortcutChecks = () => {
    const top = document.querySelector('.top'), bounds = box(actions), buttons = shortcuts.map(box);
    check(shortcuts.length === 6 && shortcuts.every(visible), 'all six shortcuts must be visible');
    check(style(actions).display === 'grid' && style(actions).gridTemplateColumns.split(' ').length === 3, 'shortcuts must have exactly three columns');
    check(near(buttons[0].top, buttons[1].top) && near(buttons[1].top, buttons[2].top), 'first shortcut row is not balanced');
    check(near(buttons[3].top, buttons[4].top) && near(buttons[4].top, buttons[5].top) && buttons[3].top > buttons[0].bottom, 'second shortcut row is not balanced');
    for (let i = 0; i < 3; i++) check(near(buttons[i].left, buttons[i + 3].left) && near(buttons[i].right, buttons[i + 3].right), 'shortcut columns are not aligned');
    check(near(buttons[2].right, bounds.right) && near(buttons[5].right, bounds.right), 'shortcut rows do not share the group right edge');
    check(near(bounds.right, box(top).right - parseFloat(style(top).paddingRight)), 'shortcut group is not aligned to header right padding');
    check(bounds.left >= 0 && bounds.right <= innerWidth && buttons.every(b => b.left >= bounds.left && b.right <= bounds.right && b.top >= bounds.top && b.bottom <= bounds.bottom), 'shortcut group overflows');
    check(!overlap(bounds, box(top.firstElementChild)), 'shortcuts overlap brand/date');
    for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) check(!overlap(buttons[i], buttons[j]), 'shortcuts overlap each other');
  };
  const main = $('fc-main'), focus = $('focus'), time = $('fc-time'), heading = $('fc-heading'), hist = $('fc-hist'), subj = $('fc-subj');
  check(main && focus && time && heading && hist && subj, 'timer structure is incomplete');
  // Measure visible first-row content, not transparent 44px hit areas or picker buttons.
  const desktopVisualGeometry = () => {
    const elements = [$('fc-subject-icon'), heading, time, hist.querySelector('svg')].filter(visible);
    const bounds = elements.map(box);
    const left = Math.min(...bounds.map(rect => rect.left));
    const right = Math.max(...bounds.map(rect => rect.right));
    return {left, right, center:(left + right) / 2, offset:(left + right) / 2 - innerWidth / 2,
      elements:elements.map(el => ({id:el.id || 'history-icon', ...box(el).toJSON()})),
      slots:Object.fromEntries([$('fc-heading-wrap'), main, hist].map(el => [el.id, box(el).toJSON()]))};
  };
  check(shortcuts.length === 6, 'header must expose exactly six shortcuts');
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
    const visual = desktopVisualGeometry();
    check(Math.abs(visual.offset) < .25, 'visible timer group is not viewport centered: ' + visual.offset + 'px');
    const iconSlot = box($('fc-heading-wrap')), historySlot = box(hist), focusBox = box(focus);
    check(near(iconSlot.width, 44) && near(historySlot.width, 44), 'desktop side hit areas changed');
    check(near(box(main).left - iconSlot.right, 8), 'subject hit area is not close to timer');
    check(near(historySlot.left - box(main).right, 8), 'history hit area is not close to timer');
    const central = [heading, time].filter(visible).map(box);
    const centralLeft = Math.min(...central.map(rect => rect.left));
    const centralRight = Math.max(...central.map(rect => rect.right));
    const gaps = {left:centralLeft - box($('fc-subject-icon')).right, right:box(hist.querySelector('svg')).left - centralRight};
    check(gaps.left > 0 && gaps.right > 0 && gaps.left <= 32 && gaps.right <= 32, 'visible timer gaps are not compact: ' + JSON.stringify(gaps));
    check(Math.abs(gaps.left - gaps.right) < 1, 'visible timer gaps are not symmetric: ' + JSON.stringify(gaps));
    window.__timerCompact = {gaps, centerError:visual.offset, hitAreas:[iconSlot.width,historySlot.width]};
    check(Math.abs(visual.offset) < 1, 'compact visible group left the viewport center');
    const cols = style(focus).gridTemplateColumns;
    const trackSizes = cols.split(' ').filter(Boolean);
    check(trackSizes.length === 5 && trackSizes[1] === '44px' && trackSizes[3] === '44px', 'focus does not reserve 44px side columns');
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
    shortcutChecks();
    if (desktop) {
      check(style(time).display !== 'none' || state === 'picker', 'clock unexpectedly hidden');
      check(visible(heading) && visible(hist), 'title/history lost');
      check(center(box(heading), box(main)), 'timer title is not centered in its control');
      check(style(heading).letterSpacing === 'normal' || style(heading).letterSpacing === '0px', 'title has trailing letter spacing that offsets visible glyphs');
      check(!visible($('fc-goal')) && style($('fc-goal')).display === 'none', 'desktop timer underline/progress track remains');
      check(box($('fc-prog-i').parentElement).height === 0, 'desktop progress track still occupies space');
      if (state !== 'picker') {
        assertBase();
        check(center(box(time), box(main)), 'time readout is not centered in its control');
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
      check(center(box(main), box(focus)), 'main is not centered inside the complete timer group');
      desktopChecks();
    } else {
      mobileChecks(); assertBase();
      check(visible($('fc-goal')) === (state !== 'running'), 'mobile progress track visibility regressed');
    }
    window.__timerGeometry ||= [];
    window.__timerGeometry.push({state, viewport:innerWidth, viewportCenter:innerWidth/2,
      centers:Object.fromEntries([focus,main,heading,time].map(el => [el.id,(box(el).left+box(el).right)/2])),
      ...(desktop ? {visual:desktopVisualGeometry(), compact:window.__timerCompact} : {}),
      shortcuts:{group:box(actions).toJSON(), buttons:shortcuts.map(el => ({id:el.id,...box(el).toJSON()})), columns:style(actions).gridTemplateColumns},
      goalDisplay:style($('fc-goal')).display, trackHeight:box($('fc-prog-i').parentElement).height});
  };
  // Reproduce only app.js responsive placement; never load or execute app.js.
  document.body.dataset.tab = 'record';
  $('date').textContent = '2026-10-18　Sun';
  $('countdown').textContent = '倒數 153 天';
  $('fc-goal-t').textContent = '目標 3.5 時　0%';
  if (desktop) document.querySelector('.top > div').after(focus);
  else document.querySelector('.rec-content > .prog').after(focus);
  window.__timerTestState = state => assertState(state);
  try {
    assertState('idle'); assertState('running');
    for (const label of ['英文', '化學', '生物', '物理', '生化']) {
      heading.textContent = label; assertBase();
      if (desktop) { check(center(box(heading), box(main)), 'subject label is not centered in its control'); desktopChecks(); }
    }
    assertState('picker'); assertState('idle'); document.body.dataset.timerTest = 'PASS';
  }
  catch (error) { document.body.dataset.timerTest = 'FAIL: ' + error.message; }
})();`;

for (const [name, width, height, scheme, motion] of [
  ['desktop-900', 900, 560, 'light', 'no-preference'], ['desktop-1100', 1100, 700, 'light', 'reduce'],
  ['desktop-1515', 1515, 1008, 'dark', 'no-preference'],
  ['desktop-1560', 1560, 900, 'dark', 'no-preference'], ['desktop-1920', 1920, 1080, 'light', 'no-preference'],
  ['mobile-320', 320, 740, 'dark', 'reduce'],
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
