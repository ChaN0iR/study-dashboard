import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const available = spawnSync('chromium', ['--version']).status === 0 &&
  spawnSync('python3', ['-c', 'import playwright.sync_api, PIL']).status === 0;

const runner = String.raw`
import functools, http.server, io, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, threading
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright, expect
root = pathlib.Path.cwd()
evidence = pathlib.Path(os.environ['CARDS_SCREENSHOTS']) if os.environ.get('CARDS_SCREENSHOTS') else None
if evidence: evidence.mkdir(parents=True, exist_ok=True)
results = []
clock = """(() => {
  const NativeDate = Date, at = NativeDate.parse('2026-10-18T10:00:00+08:00');
  window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };
  localStorage.setItem('sd-tab', 'record');
})()"""
with tempfile.TemporaryDirectory(prefix='desktop-cards-') as temp:
    archive = subprocess.check_output(['git', 'archive', '4ff8cf0', 'docs'])
    baseline = pathlib.Path(temp) / 'baseline'
    baseline.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle: bundle.extractall(baseline, filter='data')
    (pathlib.Path(temp) / 'candidate').symlink_to(root)
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=temp))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox','--disable-gpu','--disable-lcd-text','--font-render-hinting=none'])
        def open_page(width, height, variant='candidate', theme='light'):
            context = browser.new_context(viewport={'width':width,'height':height}, color_scheme=theme,
                reduced_motion='reduce', service_workers='block', timezone_id='Asia/Taipei', has_touch=width < 900)
            context.add_init_script(clock)
            page = context.new_page()
            page.errors = []
            page.on('pageerror', lambda err: page.errors.append(str(err)))
            page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
            page.goto(origin + '/' + variant + '/docs/?demo=1', wait_until='networkidle')
            page.locator('#tasks .item').first.wait_for(state='attached')
            # fcLoad runs before state load; wait for the existing 1s render to use all demo tasks.
            expect(page.locator('#fc-goal-t')).to_have_text('目標 6.5 時　26%')
            page.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}')
            assert not page.errors, page.errors
            return context, page
        def shot(page, name):
            return page.screenshot(path=str(evidence / (name + '.png')) if evidence else None, animations='disabled')
        for width,height in [(900,560),(1024,768),(1440,900),(1515,1008),(1920,1080)]:
            context,page = open_page(width,height)
            record = page.locator('.rec')
            note = page.locator('.note-card')
            rt = page.get_by_role('button', name='今日進度', exact=True)
            nt = page.get_by_role('button', name='快速筆記', exact=True)
            assert not page.locator('.recall-room-card').is_visible()
            assert page.locator('#recall-room-shortcut').is_visible()
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'true'
            page.locator('#f-review').fill('進度草稿：保留日記')
            page.locator('#n-title').fill('筆記草稿')
            page.locator('#n-points').fill('保留筆記內容')
            original = record.bounding_box()['height']
            shot(page, 'desktop-expanded-' + str(width) + 'x' + str(height))
            rt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert record.bounding_box()['height'] < original
            for selector in ['#completion','.rec-content > .prog','#prog-i']:
                assert page.locator(selector).is_visible(), selector
            for selector in ['#moods','#f-review','#f-points','#save-record']:
                assert not page.locator(selector).is_visible(), selector
            assert nt.get_attribute('aria-expanded') == 'true'
            if width == 1440: shot(page, 'desktop-progress-collapsed-1440x900')
            nt.focus(); page.keyboard.press('Space')
            assert nt.get_attribute('aria-expanded') == 'false'
            for selector in ['.note-content','.n-tools','#save-note','.note-footer']:
                assert not page.locator(selector).is_visible(), selector
            if width == 1440:
                shot(page, 'desktop-both-collapsed-1440x900')
                page.emulate_media(color_scheme='dark')
                shot(page, 'desktop-both-collapsed-dark-1440x900')
                page.emulate_media(color_scheme='light')
            rt.focus(); page.keyboard.press('Enter')
            nt.click()
            assert page.locator('#f-review').input_value() == '進度草稿：保留日記'
            assert page.locator('#n-title').input_value() == '筆記草稿'
            assert page.locator('#n-points').input_value() == '保留筆記內容'
            assert page.locator('#save-record').is_visible() and page.locator('#save-note').is_visible()
            # Editor clicks must not accidentally collapse a card.
            page.locator('#n-title').click()
            assert nt.get_attribute('aria-expanded') == 'true'
            # A successful demo record save re-renders the app without losing toggles.
            page.locator('#save-record').click()
            page.get_by_role('status').filter(has_text='已儲存').wait_for(timeout=5000)
            assert rt.get_attribute('aria-expanded') == 'true'
            rt.click(); nt.click()
            # Breakpoint exits must restore the original mobile DOM and controls.
            page.set_viewport_size({'width':899,'height':844})
            expect(page.locator('.desktop-card-toggle')).to_have_count(0)
            assert page.locator('.desktop-collapsed').count() == 0
            assert page.locator('#f-review').is_visible()
            assert page.locator('#f-review').input_value() == '進度草稿：保留日記'
            page.get_by_role('button', name='筆記', exact=True).click()
            assert page.locator('#n-title').is_visible()
            assert page.locator('#n-points').input_value() == '保留筆記內容'
            page.set_viewport_size({'width':width,'height':height})
            expect(page.locator('.desktop-card-toggle')).to_have_count(2)
            assert page.get_by_role('button',name='今日進度',exact=True).get_attribute('aria-expanded') == 'false'
            page.set_viewport_size({'width':width,'height':559})
            expect(page.locator('.desktop-card-toggle')).to_have_count(0)
            assert page.locator('#n-title').is_visible()
            page.set_viewport_size({'width':width,'height':560})
            expect(page.locator('.desktop-card-toggle')).to_have_count(2)
            assert not page.errors, page.errors
            results.append({'desktop':[width,height], 'toggle_keyboard_draft_resize_save':'PASS'})
            context.close()
        # Compare every mobile tab to exactly 4ff8cf0, including short-wide fallback.
        for width,height in [(375,667),(390,844),(430,932),(899,844),(1100,559)]:
            for theme in (['light','dark'] if width == 390 else ['light']):
                bc,bp = open_page(width,height,'baseline',theme)
                cc,cp = open_page(width,height,'candidate',theme)
                for tab in ['today','record','notes','lessons']:
                    for page in [bp,cp]:
                        page.locator('#tabs button[data-t="' + tab + '"]').click()
                        expect(page.locator('.desktop-card-toggle')).to_have_count(0)
                    bp.mouse.move(0,0); cp.mouse.move(0,0)
                    bp.bring_to_front()
                    before = bp.screenshot(animations='disabled')
                    cp.bring_to_front()
                    after = cp.screenshot(animations='disabled')
                    # Exact layout/style comparison catches even invisible mobile regressions.
                    inspect = '''() => [...document.querySelectorAll('header,header *,main,main *,#tabs,#tabs *')].map(e => {
                        const s=getComputedStyle(e),r=e.getBoundingClientRect();
                        return {tag:e.tagName,id:e.id,cls:e.getAttribute('class'),text:e.children.length?null:e.textContent,
                            value:'value' in e?e.value:null,box:[r.x,r.y,r.width,r.height],
                            style:Object.fromEntries(['display','position','flex','flex-direction','grid-template-columns','gap','padding','margin','overflow','font-family','font-size','font-weight','line-height','letter-spacing','color','background','border','border-radius','box-shadow','transform','visibility','opacity','width','height','min-width','min-height','max-width','max-height','align-items','justify-content','white-space'].map(k=>[k,s.getPropertyValue(k)]))};
                    })'''
                    base_layout, candidate_layout = bp.evaluate(inspect), cp.evaluate(inspect)
                    assert base_layout == candidate_layout, ('mobile layout/style difference',width,height,theme,tab)
                    diff = ImageChops.difference(Image.open(io.BytesIO(before)).convert('RGB'), Image.open(io.BytesIO(after)).convert('RGB'))
                    if diff.getbbox() is not None and evidence:
                        (evidence / 'mismatch-baseline.png').write_bytes(before)
                        (evidence / 'mismatch-candidate.png').write_bytes(after)
                    pixels = list(diff.getdata())
                    changed = sum(1 for rgb in pixels if any(rgb))
                    maximum = max(max(rgb) for rgb in pixels)
                    # Chromium can rasterize rounded shortcut edges slightly differently across tabs.
                    # Never allow geometry/style drift or a high-contrast/content difference.
                    assert maximum <= 16 and changed <= width * height * .001, ('mobile pixel difference',width,height,theme,tab,changed,maximum)
                    if diff.getbbox() is not None:
                        bounds=diff.getbbox(); header=cp.locator('.top').bounding_box()
                        assert bounds[1] >= header['y'] and bounds[3] <= header['y'] + header['height'], ('non-header pixel difference',bounds)
                    if width == 390 and theme == 'light':
                        shot(cp, 'mobile-' + tab + '-390x844')
                        if evidence: (evidence / ('baseline-mobile-' + tab + '-390x844.png')).write_bytes(before)
                    results.append({'mobile':[width,height], 'theme':theme, 'tab':tab, 'layout_style_equal':True, 'changed_pixels':changed, 'max_channel_delta':maximum})
                assert not bp.errors and not cp.errors
                bc.close(); cc.close()
                print('mobile ' + str(width) + 'x' + str(height) + ' ' + theme + ': all tabs PASS', file=sys.stderr, flush=True)
        browser.close()
    server.shutdown()
if evidence: (evidence / 'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps({'status':'PASS','desktop_cases':5,'mobile_pixel_comparisons':24,'results':results},ensure_ascii=False))
`;

test('desktop card toggles, drafts, keyboard, resize and unchanged mobile layout/styles', { skip: !available }, () => {
  const result = spawnSync('python3', ['-c', runner], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 180000,
    env: process.env,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, 'PASS');
  assert.equal(report.mobile_pixel_comparisons, 24);
});
