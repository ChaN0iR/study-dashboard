import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const available = spawnSync('chromium', ['--version']).status === 0 &&
  spawnSync('python3', ['-c', 'import playwright.sync_api']).status === 0;
const runner = String.raw`
import copy, functools, http.server, json, os, pathlib, shutil, threading
from playwright.sync_api import sync_playwright, expect
root = pathlib.Path.cwd()
evidence = pathlib.Path(os.environ['ACHIEVEMENT_SCREENSHOTS']) if os.environ.get('ACHIEVEMENT_SCREENSHOTS') else None
if evidence: evidence.mkdir(parents=True, exist_ok=True)
fixture = {
  'today':'2026-10-19',
  'tasks':[{'id':'study-30','title':'普化練習題','type':'練習','date':'2026-10-19','done':True,'skipped':False,'estimatedMinutes':30,'difficulty':'標準','relatedCourses':['普化']}],
  'lessons':[
    {'id':'lesson-1','course':'普化','subject':'化學','title':'普化第01堂','done':False,'status':'未開始','weekStart':'2026-10-19','order':1},
    {'id':'lesson-2','course':'普化','subject':'化學','title':'普化第02堂','done':True,'doneDate':'2026-10-18','status':'完成','weekStart':'2026-10-19','order':2}],
  'courseStats':[{'course':'普化','subject':'化學','total':10,'done':1}],
  'record':{'id':'r1','hours':0,'minutes':0},
}
class Handler(http.server.SimpleHTTPRequestHandler):
  def log_message(self, *_): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(Handler, directory=str(root/'docs')))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = 'http://127.0.0.1:' + str(server.server_port)
with sync_playwright() as p:
  browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox','--disable-gpu'])
  def open_page(width,height):
    state = copy.deepcopy(fixture)
    context = browser.new_context(viewport={'width':width,'height':height}, color_scheme='light', timezone_id='Asia/Taipei', reduced_motion='reduce', service_workers='block', has_touch=width < 900)
    context.add_init_script("""(() => {
      const NativeDate = Date, at = NativeDate.parse('2026-10-19T10:00:00+08:00');
      window.Date = class extends NativeDate { constructor(...a) { super(...(a.length ? a : [at])); } static now() { return at; } };
      localStorage.setItem('apiBase', location.origin); localStorage.setItem('appKey','test-key'); localStorage.setItem('sd-tab','lessons');
    })()""")
    page = context.new_page(); page.errors=[]; page.writes=[]
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    def route(r):
      u=r.request.url
      if u.startswith(origin + '/api/'):
        path=u[len(origin):]
        if path == '/api/state': r.fulfill(status=200, content_type='application/json', body=json.dumps(state)); return
        if path.startswith('/api/lesson/'):
          lesson_id=path.rsplit('/',1)[-1]
          lesson=next(x for x in state['lessons'] if x['id']==lesson_id)
          body=json.loads(r.request.post_data or '{}'); page.writes.append([path,body])
          lesson.update(body); lesson.update({'status':'完成' if body['done'] else '未開始','doneDate':'2026-10-19' if body['done'] else None})
          state['courseStats'][0]['done']=sum(x['done'] for x in state['lessons'])
          r.fulfill(status=200, content_type='application/json', body=json.dumps(lesson)); return
        if path == '/api/reschedule':
          r.fulfill(status=200, content_type='application/json', body='{"proposal":null}'); return
        r.fulfill(status=200, content_type='application/json', body='{}'); return
      if u.startswith(origin + '/'): r.continue_()
      else: r.abort()
    page.route('**/*', route)
    page.goto(origin + '/?api=' + origin, wait_until='networkidle')
    expect(page.locator('#achievement-xp-content .achievement-metric strong')).to_have_text('10 XP')
    page.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important}')
    return context,page
  def shot(page,name):
    if evidence: page.screenshot(path=str(evidence/(name+'.png')), animations='disabled')
  results=[]
  for width,height in [(1440,900),(390,844),(375,667),(900,560)]:
    ctx,page=open_page(width,height)
    course=page.locator('#achievement-course-toggle'); xp=page.locator('#achievement-xp-toggle'); sel=page.locator('#course-selection-toggle')
    for b,name,target in [(course,'課程與進度','achievement-course-content'),(xp,'今日 XP','achievement-xp-content'),(sel,'選擇課程去完成','course-selection-content')]:
      expect(b).to_have_accessible_name(name)
      assert b.get_attribute('type')=='button' and b.get_attribute('aria-controls')==target
      expect(page.locator('#'+target)).to_have_count(1)
    expect(page.get_by_role('button',name='選擇課程去完成',exact=True)).to_have_count(1)
    assert course.get_attribute('aria-expanded')=='true' and xp.get_attribute('aria-expanded')=='true'
    expect(page.locator('#course-selection-content')).to_be_hidden()
    expect(page.locator('#achievement-course-content #achievement-explanation-toggle')).to_have_count(1)
    expect(page.locator('#achievement-xp-content #achievement-xp-rules')).to_have_count(1)
    page.locator('#achievement-explanation-toggle').click()
    expect(page.locator('#achievement-course-content')).to_contain_text('資料日期 2026-10-19')
    page.locator('#achievement-xp-rules summary').click()
    expect(page.locator('#achievement-xp-rules p')).to_be_visible()
    if width in [1440,390]: shot(page,f'achievement-explanations-{width}x{height}')
    page.locator('#achievement-explanation-toggle').click(); page.locator('#achievement-xp-rules summary').click()
    if width in [1440,390]: shot(page,f'achievement-expanded-{width}x{height}')
    course.focus(); page.keyboard.press('Enter')
    expect(course).to_be_focused(); assert course.evaluate('(e)=>getComputedStyle(e).outlineStyle')=='solid'
    assert course.get_attribute('aria-expanded')=='false'
    expect(page.locator('#achievement-course-content')).to_be_hidden()
    page.keyboard.press('Tab'); expect(xp).to_be_focused()
    page.keyboard.press('Space'); assert xp.get_attribute('aria-expanded')=='false'
    expect(page.locator('#achievement-xp-content')).to_be_hidden()
    page.keyboard.press('Tab'); expect(sel).to_be_focused()
    if width in [1440,390]: shot(page,f'achievement-collapsed-{width}x{height}')
    xp.click(); assert course.get_attribute('aria-expanded')=='false' and xp.get_attribute('aria-expanded')=='true'
    sel.focus(); page.keyboard.press('Enter'); expect(page.locator('#course-selection-content')).to_be_visible()
    lesson_button=page.get_by_role('button',name='標記課次完成：普化第01堂',exact=True)
    lesson_button.focus(); page.keyboard.press('Space')
    expect(lesson_button).to_have_count(0)
    expect(page.locator('#lessons')).to_contain_text('普化第01堂')
    expect(page.locator('#achievement-course-content .achievement-metric strong')).to_have_text('2／10 堂 · 20%')
    expect(sel).to_be_focused()
    assert sel.get_attribute('aria-expanded')=='true'
    assert page.writes==[['/api/lesson/lesson-1',{'done':True}]], page.writes
    expect(page.locator('#achievement-xp-content .achievement-metric strong')).to_have_text('10 XP')
    assert course.get_attribute('aria-expanded')=='false' and xp.get_attribute('aria-expanded')=='true'
    course.click()
    if width in [1440,390]: shot(page,f'achievement-completed-{width}x{height}')
    # Undo still uses the original lesson operation, without changing task XP.
    undo=page.locator('#lessons .item').filter(has_text='普化第01堂').get_by_role('checkbox')
    undo.focus(); page.keyboard.press('Space')
    expect(page.get_by_role('button',name='標記課次完成：普化第01堂',exact=True)).to_be_visible()
    expect(course).to_be_focused()
    assert page.writes[-1]==['/api/lesson/lesson-1',{'done':False}]
    expect(page.locator('#achievement-xp-content .achievement-metric strong')).to_have_text('10 XP')
    # Preserve existing desktop-only record/note behavior.
    if width>=900 and height>=560:
      rec=page.get_by_role('button',name='今日進度',exact=True); note=page.get_by_role('button',name='快速筆記',exact=True)
      rec.click(); assert rec.get_attribute('aria-expanded')=='true'
      assert note.get_attribute('aria-expanded')=='false'
      note.click(); assert rec.get_attribute('aria-expanded')=='false' and note.get_attribute('aria-expanded')=='true'
    assert page.locator('body').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
    assert not page.errors, page.errors
    results.append([width,height]); ctx.close()
    print('viewport '+str(width)+'x'+str(height)+' PASS',flush=True,file=__import__('sys').stderr)
  ctx,page=open_page(1440,900)
  course=page.locator('#achievement-course-toggle'); xp=page.locator('#achievement-xp-toggle'); sel=page.locator('#course-selection-toggle')
  course.click(); page.reload(wait_until='networkidle')
  assert course.get_attribute('aria-expanded')=='false' and xp.get_attribute('aria-expanded')=='true'
  xp.click(); sel.click(); page.reload(wait_until='networkidle')
  assert course.get_attribute('aria-expanded')=='false' and xp.get_attribute('aria-expanded')=='false'
  assert sel.get_attribute('aria-expanded')=='false', 'selection is session-only, not persisted across reload'
  for size in [{'width':390,'height':844},{'width':1440,'height':900}]:
    page.set_viewport_size(size)
    assert course.get_attribute('aria-expanded')=='false' and xp.get_attribute('aria-expanded')=='false'
  ctx.close()
  for mode in ['invalid','read-blocked','write-blocked']:
    ctx,page=open_page(1440,900)
    ctx.add_init_script("""(() => { localStorage.setItem('sd-achievement-course-collapsed','invalid'); localStorage.setItem('sd-achievement-xp-collapsed','invalid'); const mode='%s'; if(mode!='invalid'){ const m=mode=='read-blocked'?'getItem':'setItem', old=Storage.prototype[m]; Storage.prototype[m]=function(k,...a){ if(k.startsWith('sd-achievement-')) throw new DOMException('blocked','SecurityError'); return old.call(this,k,...a); }; } })()""" % mode)
    page.reload(wait_until='networkidle')
    course=page.locator('#achievement-course-toggle'); xp=page.locator('#achievement-xp-toggle')
    assert course.get_attribute('aria-expanded')=='true' and xp.get_attribute('aria-expanded')=='true'
    course.click(); xp.click()
    assert course.get_attribute('aria-expanded')=='false' and xp.get_attribute('aria-expanded')=='false'
    # Reloading application state re-renders, but must retain in-memory preferences.
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    assert not page.errors, page.errors
    ctx.close()
  browser.close()
server.shutdown()
print(json.dumps({'status':'PASS','viewports':results,'storage_fallbacks':3},ensure_ascii=False))
`;

test('achievement toggles: keyboard, ARIA, completion/undo, persistence and responsive layout', { skip: !available }, () => {
  const result = spawnSync('python3', ['-c', runner], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 180000, env: process.env });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.viewports, [[1440,900],[390,844],[375,667],[900,560]]);
  assert.equal(report.storage_fallbacks, 3);
});
