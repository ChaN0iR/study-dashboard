import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
const asset = "icons/recall-hippocampus-256.png?v=hippocampus-1";
const link = html.match(/<a\b(?=[^>]*\bid="recall-room-shortcut")[^>]*>[\s\S]*?<\/a>/);

test("hippocampus shortcut preserves its accessible disabled/no-href initial state", () => {
  assert.ok(link, "recall shortcut exists");
  const opening = link[0].slice(0, link[0].indexOf(">") + 1);
  for (const attr of ['class="icon-btn"', 'aria-label="回想室"', 'title="回想室"', 'aria-disabled="true"']) {
    assert.ok(opening.includes(attr), attr);
  }
  assert.doesNotMatch(opening, /\bhref=/);
  assert.match(link[0], /<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">/);
  assert.ok(link[0].includes(`<image href="${asset}" width="24" height="24"/>`));
  assert.doesNotMatch(link[0], /<path\b|<rect\b|<span\b/);
});

test("shortcut uses the supplied 256px PNG unchanged, not the application icons", () => {
  const png = readFileSync(new URL(asset.split("?")[0], import.meta.url));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(createHash("sha256").update(png).digest("hex"), "5db2139234b9b7ddf7b2f03289a164ac0309116494621fd19b47b28295e18ea4");
  const manifest = JSON.parse(readFileSync(new URL("./manifest.webmanifest", import.meta.url), "utf8"));
  assert.ok(manifest.icons.every(icon => !icon.src.includes("hippocampus")), "app branding stays unchanged");
});

test("PWA cache version and shell include the exact versioned shortcut image once", () => {
  assert.match(sw, /^const CACHE = "sd-v132";$/m);
  const shell = JSON.parse(sw.match(/^const SHELL = (\[[^\n]+\]);$/m)[1]);
  assert.equal(shell.filter(entry => entry === asset).length, 1);
  assert.equal(new Set(shell).size, shell.length);
});

const available = spawnSync("chromium", ["--version"]).status === 0 &&
  spawnSync("python3", ["-c", "import playwright.sync_api, PIL"]).status === 0;
const runner = String.raw`
import functools, http.server, io, json, os, pathlib, shutil, subprocess, threading
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright
root = pathlib.Path.cwd()
evidence = pathlib.Path(os.environ['RECALL_ICON_SCREENSHOTS']) if os.environ.get('RECALL_ICON_SCREENSHOTS') else None
if evidence: evidence.mkdir(parents=True, exist_ok=True)
asset = 'icons/recall-hippocampus-256.png?v=hippocampus-1'
legacy_sw = subprocess.check_output(['git','show','f4743bc0fc9b8fe3819cc5ea4c8c6f0758071283:docs/sw.js'])
class Handler(http.server.SimpleHTTPRequestHandler):
    legacy = False
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/sw.js' and type(self).legacy:
            self.send_response(200); self.send_header('Content-Type','application/javascript')
            self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(legacy_sw)
        else: super().do_GET()
server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(Handler,directory=str(root/'docs')))
threading.Thread(target=server.serve_forever,daemon=True).start()
origin = 'http://127.0.0.1:' + str(server.server_port)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    for width,height in [(320,740),(375,667),(390,844),(430,932),(899,844),(900,560),(1440,900)]:
        for theme in ['light','dark']:
            context = browser.new_context(viewport={'width':width,'height':height},color_scheme=theme,reduced_motion='reduce',service_workers='block',has_touch=width<900)
            page = context.new_page(); errors=[]; images=[]
            page.on('pageerror',lambda error: errors.append(str(error)))
            page.on('response',lambda response: images.append(response.status) if response.url == origin+'/'+asset else None)
            page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin+'/') else route.abort())
            page.goto(origin+'/?demo=1',wait_until='networkidle')
            shortcut = page.locator('#recall-room-shortcut')
            assert shortcut.is_visible()
            assert shortcut.get_attribute('aria-label') == '回想室' and shortcut.get_attribute('title') == '回想室'
            assert shortcut.get_attribute('href') == 'https://study-dashboard-api.tw-ching.workers.dev/recall/'
            assert shortcut.get_attribute('aria-disabled') is None
            assert shortcut.locator('svg image').get_attribute('href') == asset
            assert images == [200], images
            box = shortcut.bounding_box(); icon = shortcut.locator('svg').bounding_box()
            assert box['x'] <= icon['x'] and icon['x']+icon['width'] <= box['x']+box['width']
            assert box['y'] <= icon['y'] and icon['y']+icon['height'] <= box['y']+box['height']
            assert abs(icon['x']+icon['width']/2-box['x']-box['width']/2)<1
            neighbor = page.locator('#gd-link svg').bounding_box()
            assert icon['width'] == icon['height'] == neighbor['width'] == neighbor['height'], (width,theme,icon,neighbor)
            # A decoded image must actually paint; a successful HTTP response alone is insufficient.
            before = shortcut.screenshot(animations='disabled')
            page.add_style_tag(content='#recall-room-shortcut image{visibility:hidden!important}')
            after = shortcut.screenshot(animations='disabled')
            assert ImageChops.difference(Image.open(io.BytesIO(before)).convert('RGB'),Image.open(io.BytesIO(after)).convert('RGB')).getbbox()
            page.add_style_tag(content='#recall-room-shortcut image{visibility:visible!important}')
            if evidence and width in [390,1440]:
                page.screenshot(path=str(evidence/f'{width}x{height}-{theme}.png'),animations='disabled')
                shortcut.screenshot(path=str(evidence/f'{width}x{height}-{theme}-shortcut.png'),animations='disabled')
            # Invalid API configuration must keep the existing disabled/no-href behavior.
            page.evaluate("localStorage.setItem('apiBase','invalid')")
            page.reload(wait_until='networkidle')
            assert shortcut.get_attribute('aria-disabled') == 'true' and shortcut.get_attribute('href') is None
            assert not errors, errors
            results.append({'viewport':[width,height],'theme':theme,'icon_px':icon['width'],'rendered':True,'initialization':'PASS'})
            context.close()
    # Real service-worker migration from the exact base cache, followed by an offline reload.
    Handler.legacy = True
    context = browser.new_context(viewport={'width':390,'height':844},service_workers='allow')
    page = context.new_page()
    page.goto(origin+'/?demo=1',wait_until='networkidle')
    page.evaluate('navigator.serviceWorker.ready.then(() => true)')
    page.wait_for_function("navigator.serviceWorker.controller !== null")
    assert 'sd-v131' in page.evaluate('caches.keys()')
    Handler.legacy = False
    page.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update()).then(() => true)')
    for attempt in range(100):
        cached = page.evaluate("async asset => { const keys = await caches.keys(); const r = await caches.match(asset,{cacheName:'sd-v132'}); return {keys,status:r?.status,type:r?.headers.get('content-type')}; }", asset)
        if 'sd-v131' not in cached['keys'] and cached.get('status') == 200: break
        page.wait_for_timeout(100)
    assert 'sd-v131' not in cached['keys'] and cached.get('status') == 200 and cached.get('type','').startswith('image/png'), cached
    context.set_offline(True)
    page.reload(wait_until='networkidle')
    page.wait_for_function("document.querySelector('#recall-room-shortcut image') !== null")
    assert page.evaluate("async asset => { const r = await fetch(asset); return r.ok && (await r.blob()).size === 49019; }", asset)
    before = page.locator('#recall-room-shortcut').screenshot(animations='disabled')
    page.add_style_tag(content='#recall-room-shortcut image{visibility:hidden!important}')
    after = page.locator('#recall-room-shortcut').screenshot(animations='disabled')
    assert ImageChops.difference(Image.open(io.BytesIO(before)).convert('RGB'),Image.open(io.BytesIO(after)).convert('RGB')).getbbox()
    page.add_style_tag(content='#recall-room-shortcut image{visibility:visible!important}')
    if evidence: page.screenshot(path=str(evidence/'390x844-offline-upgraded.png'),animations='disabled')
    context.close(); browser.close()
server.shutdown()
report = {'status':'PASS','responsive_cases':results,'cache_upgrade':'sd-v131 -> sd-v132 PASS','offline_image':'PASS'}
if evidence: (evidence/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False))
`;

test("desktop/mobile light-dark rendering, unchanged link initialization and real PWA offline upgrade", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", runner], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 120000, env: process.env,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, "PASS");
  assert.equal(report.responsive_cases.length, 14);
  assert.equal(report.offline_image, "PASS");
});
