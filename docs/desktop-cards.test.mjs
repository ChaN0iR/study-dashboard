import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const shell = JSON.parse(sw.match(/^const SHELL = (\[[^\n]+\]);$/m)[1]);

test('index.html references the updated desktop card assets exactly once', () => {
  assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="(app\.js[^\"]*)"/g)].map(m => m[1]), ['app.js?v=127']);
  assert.deepEqual([...html.matchAll(/<link\b[^>]*\bhref="(style\.css[^\"]*)"/g)].map(m => m[1]), ['style.css?v=127']);
});

test('SW cache and shell match the index.html static asset references', () => {
  assert.match(sw, /^const CACHE = "sd-v142";$/m);
  assert.equal(new Set(shell).size, shell.length, 'shell has no duplicate entries');
  for (const entry of ['./', 'index.html', 'app.js?v=127', 'style.css?v=127']) assert.ok(shell.includes(entry), entry);
  assert.deepEqual(shell.filter(entry => /^(app\.js|style\.css)(\?|$)/.test(entry)), ['style.css?v=127', 'app.js?v=127']);
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^\"]+)"/g)].map(m => m[1]);
  for (const reference of references) assert.ok(shell.includes(reference), `shell includes ${reference}`);
  for (const entry of shell) assert.ok(existsSync(new URL(entry.split('?')[0], import.meta.url)), `shell file exists: ${entry}`);
});

const available = spawnSync('chromium', ['--version']).status === 0 &&
  spawnSync('python3', ['-c', 'import playwright.sync_api']).status === 0;

const runner = String.raw`
import functools, http.server, json, os, pathlib, shutil, tempfile, threading
from playwright.sync_api import sync_playwright, expect
root = pathlib.Path.cwd()
evidence = pathlib.Path(os.environ['CARDS_SCREENSHOTS']) if os.environ.get('CARDS_SCREENSHOTS') else None
if evidence: evidence.mkdir(parents=True, exist_ok=True)
results = []
clock = """(() => {
  const NativeDate = Date, at = NativeDate.parse('2026-10-18T10:00:00+08:00');
  window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };
})()"""
with tempfile.TemporaryDirectory(prefix='desktop-cards-') as temp:
    (pathlib.Path(temp) / 'candidate').symlink_to(root)
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_): pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=temp))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = 'http://127.0.0.1:' + str(server.server_port)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox','--disable-gpu','--disable-lcd-text','--font-render-hinting=none'])
        # Run with native prompts disabled and route every API call to a test fixture.
        context = browser.new_context(viewport={'width':390,'height':844}, service_workers='block')
        context.add_init_script("window.prompt = () => { throw new Error('prompt() is not supported'); };")
        page = context.new_page()
        page_errors = []
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        backend = origin + '/synthetic'
        site = origin + '/candidate/docs/'
        received = []
        def connection_route(route):
            request = route.request
            if request.url.startswith(backend + '/api/'):
                path = request.url.split('/api/')[-1]
                token = request.headers.get('x-app-key')
                received.append((request.method, path, token))
                if token != 'synthetic-key':
                    route.fulfill(status=401)
                elif path == 'state':
                    route.fulfill(json={'today':'2026-11-23','tasks':[],'lessons':[]})
                else:
                    route.fulfill(json={'now':0,'todayDoneSec':0})
            elif request.url.startswith(origin + '/'):
                route.continue_()
            else:
                route.abort()
        page.route('**/*', connection_route)
        page.goto(site + '?api=' + backend)
        dialog = page.get_by_role('dialog', name='設定儀表板連線')
        expect(dialog).to_be_visible()
        assert page.locator('#connection-key').get_attribute('type') == 'password'
        dialog.get_by_role('button', name='取消').click()
        expect(dialog).to_be_hidden()
        assert not received
        page.get_by_role('button', name='設定連線').click()
        dialog.get_by_label('APP_KEY').fill('incorrect')
        dialog.get_by_role('button', name='連線', exact=True).click()
        expect(dialog.get_by_role('status')).to_have_text('APP_KEY 錯誤，請重新輸入。')
        assert page.evaluate("localStorage.getItem('appKey')") is None
        dialog.get_by_label('APP_KEY').fill('synthetic-key')
        dialog.get_by_role('button', name='連線', exact=True).click()
        page.wait_for_url(site)
        expect(page.locator('#tasks')).to_have_attribute('data-state-verified', 'true')
        expect(dialog).to_be_hidden()
        page.get_by_role('button', name='筆記', exact=True).click()
        page.get_by_role('link', name='重設連線').click()
        expect(dialog).to_be_visible()
        expect(dialog.get_by_label('APP_KEY')).to_have_value('')
        dialog.get_by_role('button', name='取消').click()
        page.reload()
        expect(page.locator('#tasks')).to_have_attribute('data-state-verified', 'true')
        expect(dialog).to_be_hidden()
        assert all(method == 'GET' for method, _, _ in received), received
        assert not page_errors, page_errors
        context.close()
        def open_page(width, height):
            context = browser.new_context(viewport={'width':width,'height':height}, color_scheme='light',
                reduced_motion='reduce', service_workers='block', timezone_id='Asia/Taipei', has_touch=width < 900)
            context.add_init_script(clock)
            page = context.new_page()
            page.errors = []
            page.on('pageerror', lambda err: page.errors.append(str(err)))
            page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') else route.abort())
            page.goto(origin + '/candidate/docs/?demo=1', wait_until='networkidle')
            page.locator('#tasks .item').first.wait_for(state='attached')
            # fcLoad runs before state load; wait for the existing 1s render to use all demo tasks.
            expect(page.locator('#fc-goal-t')).to_have_text('目標 6.5 時　26%')
            page.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}')
            assert not page.errors, page.errors
            return context, page
        def shot(page, name):
            return page.screenshot(path=str(evidence / (name + '.png')) if evidence else None, animations='disabled')
        # Compact desktop stacks achievements below the first row of cards.
        # Wheel over a card and check the dashboard can reach the last control.
        for width, height in [(900, 560), (988, 718), (1099, 650)]:
            context, page = open_page(width, height)
            main = page.locator('main')
            assert main.evaluate('(node) => node.scrollHeight > node.clientHeight')
            task_list = page.locator('#tasks').bounding_box()
            page.mouse.move(task_list['x'] + 12, min(task_list['y'] + 20, height - 20))
            page.mouse.wheel(0, 450)
            page.wait_for_function("document.querySelector('main').scrollTop > 100")
            page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            assert main.evaluate('(node) => node.scrollTop') > 100
            select_course = page.get_by_role('button', name='選擇課程去完成')
            select_course.scroll_into_view_if_needed()
            expect(select_course).to_be_in_viewport()
            select_course.click()
            expect(select_course).to_have_attribute('aria-expanded', 'true')
            assert main.evaluate('(node) => node.scrollTop') > 100
            context.close()
        for width, height in [(900,560), (1024,768), (1440,900), (1515,1008), (1920,1080)]:
            context, page = open_page(width, height)
            note = page.get_by_role('button', name='快速筆記', exact=True)
            expect(page.get_by_role('heading', name='推薦任務', exact=True)).to_be_visible()
            expect(page.locator('#tasks .task-item')).to_have_count(1)
            expect(page.get_by_role('heading', name='今日進度', exact=True)).to_have_count(0)
            expect(page.locator('.desktop-card-toggle')).to_have_count(1)
            expect(page.locator('.top > #focus')).to_be_visible()
            expect(note).to_have_attribute('aria-expanded', 'true')
            page.locator('#n-title').fill('筆記草稿')
            page.locator('#n-points').fill('保留筆記內容')
            note.focus()
            page.keyboard.press('Space')
            expect(note).to_be_focused()
            expect(note).to_have_attribute('aria-expanded', 'false')
            expect(page.locator('#n-title')).to_be_hidden()
            note.click()
            expect(page.locator('#n-points')).to_have_value('保留筆記內容')
            note.click()
            page.reload(wait_until='networkidle')
            expect(note).to_have_attribute('aria-expanded', 'false')
            note.click()
            expect(note).to_have_attribute('aria-expanded', 'true')
            expect(page.locator('#n-title')).to_have_value('筆記草稿')
            if width == 1440: shot(page, 'desktop-single-recommendation')
            page.set_viewport_size({'width':899, 'height':844})
            expect(page.locator('.desktop-card-toggle')).to_have_count(0)
            page.get_by_role('button', name='專注', exact=True).click()
            expect(page.locator('main #fc-main')).to_be_visible()
            page.get_by_role('button', name='筆記', exact=True).click()
            expect(page.locator('#n-title')).to_have_value('筆記草稿')
            page.set_viewport_size({'width':width, 'height':height})
            expect(note).to_have_attribute('aria-expanded', 'true')
            assert not page.errors, page.errors
            results.append({'desktop':[width,height], 'note_toggle_and_resize':'PASS'})
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
                if path == '/api/note':
                    api_writes.append([path,json.loads(route.request.post_data or '{}')])
                    message = 'TEST_NOTE_SAVE_FAILED'
                    route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':message})); return
                route.fulfill(status=200,content_type='application/json',body='{}'); return
            if request_url.startswith(origin + '/'): route.continue_()
            else: route.abort()
        failure_page.route('**/*',failure_route)
        failure_page.goto(origin + '/candidate/docs/?api=' + origin,wait_until='networkidle')
        expect(failure_page.locator('.desktop-card-toggle')).to_have_count(1)
        failure_note = failure_page.get_by_role('button',name='快速筆記',exact=True)
        failure_page.locator('#n-title').fill('筆記 API 失敗測試')
        failure_page.locator('#n-points').fill('失敗後仍留在草稿')
        failure_page.locator('#save-note').click()
        expect(failure_page.locator('#toast')).to_have_text('TEST_NOTE_SAVE_FAILED')
        assert api_writes[-1][0] == '/api/note' and api_writes[-1][1]['points'] == '失敗後仍留在草稿'
        expect(failure_note).to_have_attribute('aria-expanded', 'true')
        expect(failure_page.locator('#n-title')).to_have_value('筆記 API 失敗測試')
        expect(failure_page.locator('#n-draft textarea').first).to_have_value('失敗後仍留在草稿')
        failure_note.click()
        failure_note.click()
        expect(failure_page.locator('#n-draft textarea').first).to_have_value('失敗後仍留在草稿')
        assert not failure_page.errors, failure_page.errors
        results.append({'note_save_failure':'PASS','draft_retained':True})
        failure_context.close()
        for width, height in [(375,667), (390,844), (430,932), (899,844), (1100,559)]:
            context, page = open_page(width, height)
            expect(page.locator('#tasks .task-item')).to_have_count(1)
            expect(page.get_by_role('button', name='進度', exact=True)).to_have_count(0)
            expect(page.locator('.desktop-card-toggle')).to_have_count(0)
            page.evaluate("localStorage.setItem('sd-tab','record')")
            page.reload(wait_until='networkidle')
            expect(page.get_by_role('button', name='專注', exact=True)).to_have_attribute('aria-selected', 'true')
            expect(page.locator('#fc-main')).to_be_visible()
            page.get_by_role('button', name='筆記', exact=True).click()
            expect(page.locator('#n-title')).to_be_visible()
            assert page.locator('body').evaluate('(e) => e.scrollWidth <= e.clientWidth')
            assert not page.errors, page.errors
            results.append({'compact':[width,height], 'legacy_tab_and_notes':'PASS'})
            context.close()
        browser.close()
    server.shutdown()
if evidence: (evidence / 'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps({'status':'PASS','results':results},ensure_ascii=False))
`;

test('one recommendation, notes, compact scrolling and focus remain usable', { skip: !available }, () => {
  const result = spawnSync('python3', ['-c', runner], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 180000, env: process.env,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, 'PASS');
  assert.equal(report.results.filter(item => item.desktop).length, 5);
  assert.equal(report.results.filter(item => item.compact).length, 5);
});
