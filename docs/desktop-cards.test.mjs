import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const shell = JSON.parse(sw.match(/^const SHELL = (\[[^\n]+\]);$/m)[1]);

test('index.html references the updated desktop card assets exactly once', () => {
  assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="(app\.js[^\"]*)"/g)].map(m => m[1]), ['app.js?v=123']);
  assert.deepEqual([...html.matchAll(/<link\b[^>]*\bhref="(style\.css[^\"]*)"/g)].map(m => m[1]), ['style.css?v=124']);
});

test('SW cache and shell match the index.html static asset references', () => {
  assert.match(sw, /^const CACHE = "sd-v138";$/m);
  assert.equal(new Set(shell).size, shell.length, 'shell has no duplicate entries');
  for (const entry of ['./', 'index.html', 'app.js?v=123', 'style.css?v=124']) assert.ok(shell.includes(entry), entry);
  assert.deepEqual(shell.filter(entry => /^(app\.js|style\.css)(\?|$)/.test(entry)), ['style.css?v=124', 'app.js?v=123']);
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^\"]+)"/g)].map(m => m[1]);
  for (const reference of references) assert.ok(shell.includes(reference), `shell includes ${reference}`);
  for (const entry of shell) assert.ok(existsSync(new URL(entry.split('?')[0], import.meta.url)), `shell file exists: ${entry}`);
});

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
    archive = subprocess.check_output(['git', 'archive', '7b2d6dabb54f9a3183171c67e024c0b5939fcd8c', 'docs'])
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
        def open_page(width, height, variant='candidate', theme='light', saved_collapsed=False):
            context = browser.new_context(viewport={'width':width,'height':height}, color_scheme=theme,
                reduced_motion='reduce', service_workers='block', timezone_id='Asia/Taipei', has_touch=width < 900)
            context.add_init_script(clock)
            if saved_collapsed:
                context.add_init_script("localStorage.setItem('sd-desktop-record-collapsed','true'); localStorage.setItem('sd-desktop-note-collapsed','true')")
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
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            assert not page.locator('#f-review').is_visible()
            assert page.locator('#n-title').is_visible()
            expect(page.locator('.desktop-card-chevron')).to_have_count(0)
            for button in [rt,nt]:
                assert button.get_attribute('type') == 'button'
                for target in button.get_attribute('aria-controls').split():
                    expect(page.locator('#' + target)).to_have_count(1)
            if width == 1440: shot(page, 'desktop-default-progress-collapsed-note-open-1440x900')
            # Opening one card closes the other, and the choice survives reloads.
            rt.focus(); page.keyboard.press('Enter')
            assert rt.evaluate('(e) => e === document.activeElement')
            assert rt.evaluate('(e) => getComputedStyle(e).outlineStyle') == 'solid'
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'false'
            page.reload(wait_until='networkidle')
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'false'
            nt.focus(); page.keyboard.press('Space')
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            page.reload(wait_until='networkidle')
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'false'
            page.reload(wait_until='networkidle')
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'false'
            if width == 1440: shot(page, 'desktop-reloaded-both-collapsed-1440x900')
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            # A new tab sees the same exclusive, persisted preference.
            other = context.new_page()
            other.goto(page.url, wait_until='networkidle')
            assert other.get_by_role('button',name='今日進度',exact=True).get_attribute('aria-expanded') == 'false'
            assert other.get_by_role('button',name='快速筆記',exact=True).get_attribute('aria-expanded') == 'true'
            other.close()
            page.locator('#n-title').fill('筆記草稿')
            page.locator('#n-points').fill('保留筆記內容')
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'false'
            rt.click()
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'false'
            page.locator('#f-review').fill('進度草稿：保留日記')
            page.locator('#f-points').fill('保留進度重點')
            assert page.locator('#n-title').input_value() == '筆記草稿'
            assert page.locator('#n-points').input_value() == '保留筆記內容'
            original = record.bounding_box()['height']
            shot(page, 'desktop-expanded-' + str(width) + 'x' + str(height))
            rt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'false'
            assert record.bounding_box()['height'] < original
            for selector in ['#completion','.rec-content > .prog','#prog-i']:
                assert page.locator(selector).is_visible(), selector
            for selector in ['#moods','#f-review','#f-points','#save-record']:
                assert not page.locator(selector).is_visible(), selector
            for selector in ['#n-title','#n-points','#save-note']:
                assert not page.locator(selector).is_visible(), selector
            if width == 1440: shot(page, 'desktop-progress-collapsed-1440x900')
            nt.focus(); page.keyboard.press('Space')
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            for selector in ['.note-content','.n-tools','#save-note','.note-footer']:
                assert page.locator(selector).is_visible(), selector
            nt.focus(); page.keyboard.press('Space')
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'false'
            for selector in ['.note-content','.n-tools','#save-note','.note-footer']:
                assert not page.locator(selector).is_visible(), selector
            if width == 1440:
                shot(page, 'desktop-both-collapsed-1440x900')
                page.emulate_media(color_scheme='dark')
                shot(page, 'desktop-both-collapsed-dark-1440x900')
                page.emulate_media(color_scheme='light')
            # Reopening either card must preserve both cards' unsent fields.
            rt.focus(); page.keyboard.press('Enter')
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'false'
            assert page.locator('#f-review').input_value() == '進度草稿：保留日記'
            assert page.locator('#f-points').input_value() == '保留進度重點'
            assert page.locator('#n-title').input_value() == '筆記草稿'
            assert page.locator('#n-points').input_value() == '保留筆記內容'
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            assert page.locator('#n-title').input_value() == '筆記草稿'
            assert page.locator('#n-points').input_value() == '保留筆記內容'
            # Editor clicks must not accidentally collapse a card.
            page.locator('#n-title').click()
            assert nt.get_attribute('aria-expanded') == 'true'
            # A successful demo record save keeps the exclusive state.
            rt.focus(); page.keyboard.press('Enter')
            page.locator('#save-record').click()
            page.get_by_role('status').filter(has_text='已儲存').wait_for(timeout=5000)
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'false'
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            assert page.locator('#n-title').input_value() == '筆記草稿'
            assert page.locator('#n-points').input_value() == '保留筆記內容'
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
        # Invalid values and unavailable storage must not break the controls.
        for mode in ['invalid','read-blocked','write-blocked']:
            context,page = open_page(1440,900)
            context.add_init_script('''(() => {
                const keys = ['sd-desktop-record-collapsed','sd-desktop-note-collapsed'];
                const mode = "''' + mode + '''";
                for (const key of keys) localStorage.setItem(key, 'invalid');
                if (mode !== 'invalid') {
                    const method = mode === 'read-blocked' ? 'getItem' : 'setItem';
                    const original = Storage.prototype[method];
                    Storage.prototype[method] = function(key,...args) {
                        if (keys.includes(key)) throw new DOMException('blocked','SecurityError');
                        return original.call(this,key,...args);
                    };
                }
            })()''')
            page.reload(wait_until='networkidle')
            rt = page.get_by_role('button', name='今日進度', exact=True)
            nt = page.get_by_role('button', name='快速筆記', exact=True)
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            rt.click()
            assert rt.get_attribute('aria-expanded') == 'true'
            assert nt.get_attribute('aria-expanded') == 'false'
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'true'
            nt.click()
            assert rt.get_attribute('aria-expanded') == 'false'
            assert nt.get_attribute('aria-expanded') == 'false'
            assert not page.errors, page.errors
            results.append({'storage':mode,'fallback':'PASS'})
            context.close()
        # Legacy independent preferences with both cards open normalize to one.
        context,page = open_page(1440,900)
        page.evaluate("localStorage.setItem('sd-desktop-record-collapsed','false'); localStorage.setItem('sd-desktop-note-collapsed','false')")
        page.reload(wait_until='networkidle')
        assert page.get_by_role('button',name='今日進度',exact=True).get_attribute('aria-expanded') == 'false'
        assert page.get_by_role('button',name='快速筆記',exact=True).get_attribute('aria-expanded') == 'true'
        context.close()
        # Real API failures are intercepted by a localhost-only mock; no Worker request is made.
        failure_context = browser.new_context(viewport={'width':1440,'height':900}, color_scheme='light',
            reduced_motion='reduce', service_workers='block', timezone_id='Asia/Taipei')
        failure_context.add_init_script(clock + "\nlocalStorage.setItem('appKey','test-key');")
        failure_page = failure_context.new_page()
        failure_page.errors = []
        failure_page.on('pageerror', lambda err: failure_page.errors.append(str(err)))
        api_writes = []
        api_state = {'today':'2026-10-18','tasks':[],'lessons':[],'courseStats':[],
            'record':{'id':'r1','hours':0,'minutes':0,'review':'','workout':'','points':'','mood':None}}
        def failure_route(route):
            request_url = route.request.url
            if request_url.startswith(origin + '/api/'):
                path = request_url.split(origin,1)[1].split('?',1)[0]
                if path == '/api/state':
                    route.fulfill(status=200,content_type='application/json',body=json.dumps(api_state)); return
                if path == '/api/reschedule':
                    route.fulfill(status=200,content_type='application/json',body='{"proposal":null}'); return
                if path in ['/api/record','/api/note']:
                    api_writes.append([path,json.loads(route.request.post_data or '{}')])
                    message = 'TEST_RECORD_SAVE_FAILED' if path == '/api/record' else 'TEST_NOTE_SAVE_FAILED'
                    route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':message})); return
                route.fulfill(status=200,content_type='application/json',body='{}'); return
            if request_url.startswith(origin + '/'): route.continue_()
            else: route.abort()
        failure_page.route('**/*',failure_route)
        failure_page.goto(origin + '/candidate/docs/?api=' + origin,wait_until='networkidle')
        expect(failure_page.locator('.desktop-card-toggle')).to_have_count(2)
        failure_record = failure_page.get_by_role('button',name='今日進度',exact=True)
        failure_note = failure_page.get_by_role('button',name='快速筆記',exact=True)
        failure_record.click()
        assert failure_record.get_attribute('aria-expanded') == 'true'
        assert failure_note.get_attribute('aria-expanded') == 'false'
        failure_page.locator('#f-review').fill('記錄 API 失敗測試')
        failure_page.locator('#f-points').fill('保留互斥卡片狀態')
        failure_page.locator('#save-record').click()
        expect(failure_page.locator('#toast')).to_have_text('TEST_RECORD_SAVE_FAILED')
        assert api_writes[-1][0] == '/api/record' and api_writes[-1][1]['心得'] == '記錄 API 失敗測試'
        assert failure_record.get_attribute('aria-expanded') == 'true'
        assert failure_note.get_attribute('aria-expanded') == 'false'
        failure_note.click()
        assert failure_record.get_attribute('aria-expanded') == 'false'
        assert failure_note.get_attribute('aria-expanded') == 'true'
        failure_page.locator('#n-title').fill('筆記 API 失敗測試')
        failure_page.locator('#n-points').fill('失敗後仍留在草稿')
        failure_page.locator('#save-note').click()
        expect(failure_page.locator('#toast')).to_have_text('TEST_NOTE_SAVE_FAILED')
        assert api_writes[-1][0] == '/api/note' and api_writes[-1][1]['points'] == '失敗後仍留在草稿'
        assert failure_record.get_attribute('aria-expanded') == 'false'
        assert failure_note.get_attribute('aria-expanded') == 'true'
        assert failure_page.locator('#n-title').input_value() == '筆記 API 失敗測試'
        assert failure_page.locator('#n-draft textarea').first.input_value() == '失敗後仍留在草稿'
        failure_record.click()
        assert failure_record.get_attribute('aria-expanded') == 'true'
        assert failure_note.get_attribute('aria-expanded') == 'false'
        failure_note.click()
        assert failure_record.get_attribute('aria-expanded') == 'false'
        assert failure_note.get_attribute('aria-expanded') == 'true'
        assert failure_page.locator('#n-draft textarea').first.input_value() == '失敗後仍留在草稿'
        assert not failure_page.errors, failure_page.errors
        results.append({'api_save_failures':['record','note'],'exclusive_state':'PASS','note_draft_retained':True})
        failure_context.close()
        # Compare unchanged mobile tabs to the exact release base, including short-wide fallback.
        # Achievements has intentional UI changes, covered by achievement-toggles.test.mjs.
        for width,height in [(375,667),(390,844),(430,932),(899,844),(1100,559)]:
            for theme in (['light','dark'] if width == 390 else ['light']):
                bc,bp = open_page(width,height,'baseline',theme)
                cc,cp = open_page(width,height,'candidate',theme,saved_collapsed=True)
                for tab in ['today','record','notes']:
                    for page in [bp,cp]:
                        page.locator('#tabs button[data-t="' + tab + '"]').click()
                        expect(page.locator('.desktop-card-toggle')).to_have_count(0)
                    # Only the approved Dashboard shortcut artwork differs from the release base.
                    # Keep its wrapper geometry/style in the equality checks; hide only artwork.
                    for page in [bp,cp]:
                        page.add_style_tag(content='#recall-room-shortcut > svg{visibility:hidden!important}')
                    bp.mouse.move(0,0); cp.mouse.move(0,0)
                    bp.bring_to_front()
                    before = bp.screenshot(animations='disabled')
                    cp.bring_to_front()
                    after = cp.screenshot(animations='disabled')
                    # Exact layout/style comparison catches even invisible mobile regressions.
                    # Exclude only the intentionally changed, hidden achievement subtree on these tabs.
                    inspect = '''() => [...document.querySelectorAll('header,header *,main,main *,#tabs,#tabs *')].filter(e => !e.closest('#recall-room-shortcut svg') && !e.closest('.achievements-card')).map(e => {
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
print(json.dumps({'status':'PASS','desktop_cases':5,'mobile_pixel_comparisons':sum(1 for r in results if r.get('mobile')),'results':results},ensure_ascii=False))
`;

test('desktop card toggles, drafts, keyboard, resize and unchanged mobile layout/styles', { skip: !available }, () => {
  const result = spawnSync('python3', ['-c', runner], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 180000,
    env: process.env,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, 'PASS');
  const mobileResults = report.results.filter(r => r.mobile);
  const mobileKeys = mobileResults.map(r => `${r.mobile[0]}x${r.mobile[1]}:${r.theme}:${r.tab}`).sort();
  const expectedMobileKeys = [375, 390, 430, 899, 1100].flatMap(width => {
    const height = ({375: 667, 390: 844, 430: 932, 899: 844, 1100: 559})[width];
    const themes = width === 390 ? ['light', 'dark'] : ['light'];
    return themes.flatMap(theme => ['today', 'record', 'notes'].map(tab => `${width}x${height}:${theme}:${tab}`));
  }).sort();
  assert.equal(mobileResults.length, 18, 'all six viewport/theme combinations cover three tabs');
  assert.deepEqual(mobileKeys, expectedMobileKeys, 'all expected viewport/theme/tab comparisons ran exactly once');
  assert.equal(report.mobile_pixel_comparisons, mobileResults.length, 'reported count is derived from collected browser results');
});
