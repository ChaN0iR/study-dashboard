"""Read-only deployed-site smoke in a fresh Chromium profile; never submit forms.

Cache cleanup uses a seeded legacy cache, not an installed old Service Worker.
This does not claim physical-device or installed-PWA acceptance.
"""
import argparse
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

SITE = 'https://chan0ir.github.io/study-dashboard/'
HEALTH = 'https://study-dashboard-api.tw-ching.workers.dev/health'
parser = argparse.ArgumentParser()
parser.add_argument('--release-sha', required=True)
parser.add_argument('--output', default='production-smoke-evidence')
parser.add_argument('--wait-seconds', type=int, default=0)
parser.add_argument('--allow-legacy-cleanup', action='store_true')
args = parser.parse_args()
assert re.fullmatch(r'[0-9a-f]{40}', args.release_sha), 'Expected a full immutable release SHA'
if args.allow_legacy_cleanup:
    assert args.release_sha in {'5771bdc49dfdd0ea09439d717797be12357cf86d',
                                '0b0314ee9374f9cb24b98138e1771340e7662c43'}, 'Legacy exception is restricted to known pre-fix releases'
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)


def read_url(url):
    with urlopen(url, timeout=30) as response:
        assert response.status == 200, (url, response.status)
        return response.read()


# Pages publication can complete after the main push starts this workflow.
# Retry only until the exact immutable release assets are present; never accept drift.
expected_assets = {path: subprocess.check_output(['git', 'show', f'{args.release_sha}:docs/{path}'])
                   for path in ['index.html', 'app.js', 'sw.js', 'style.css', 'config.js', 'manifest.webmanifest']}
deadline = time.monotonic() + max(0, args.wait_seconds)
while True:
    mismatches = []
    actual_assets = {}
    for path, expected in expected_assets.items():
        try:
            actual_assets[path] = read_url(SITE + path)
            if actual_assets[path] != expected:
                mismatches.append(path + ': content differs')
        except OSError as error:
            mismatches.append(path + ': ' + str(error))
    (output / 'asset-check.json').write_text(json.dumps({'release_sha': args.release_sha,
        'matched': not mismatches, 'mismatches': mismatches}, indent=2))
    if not mismatches:
        break
    if time.monotonic() >= deadline:
        raise AssertionError('Deployed assets do not match release: ' + '; '.join(mismatches))
    print('Waiting for Pages assets: ' + '; '.join(mismatches), flush=True)
    time.sleep(min(10, max(0, deadline - time.monotonic())))
hashes = {path: hashlib.sha256(content).hexdigest() for path, content in actual_assets.items()}
sw = actual_assets['sw.js'].decode()
require_sibling_preservation = not args.allow_legacy_cleanup
cache_name = re.search(r'const CACHE = "([^"]+)";', sw).group(1)
shell = json.loads(re.search(r'const SHELL = (\[[^\n]+\]);', sw).group(1))
app_ref = next(entry for entry in shell if entry.startswith('app.js?'))
# Use curl for the same read-only health probe already verified from the desktop.
# Keep its failure evidence while allowing independent PWA checks to finish.
health = subprocess.run(['curl', '--silent', '--show-error', '--fail-with-body',
                         '--max-time', '30', HEALTH], capture_output=True, text=True)
try:
    health_ok = health.returncode == 0 and json.loads(health.stdout) == {'ok': True}
except json.JSONDecodeError:
    health_ok = False
(output / 'health.json').write_text(json.dumps({'ok': health_ok, 'exit_code': health.returncode,
    'response': health.stdout[:2000], 'error': health.stderr[:1000]}, indent=2))
report = {'release_sha': args.release_sha, 'site': SITE, 'asset_sha256': hashes,
          'health': 'PASS' if health_ok else 'FAIL', 'cache': cache_name, 'cases': [],
          'limitations': ['Fresh browser profile, not a physically installed PWA',
                          'Legacy cache is seeded; no old Service Worker upgrade simulated']}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 900}, service_workers='allow')
    blocked = []

    def guard(route):
        request = route.request
        if request.method != 'GET' or urlsplit(request.url).netloc != 'chan0ir.github.io':
            blocked.append({'method': request.method, 'url': request.url})
            route.abort()
        else:
            route.continue_()

    context.route('**/*', guard)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Establish only the origin first, before any application Service Worker exists.
    page.goto(SITE + 'config.js', wait_until='networkidle')
    legacy = 'sd-v135' if cache_name != 'sd-v135' else 'sd-smoke-legacy'
    page.evaluate("""async legacy => {
      const cache = await caches.open(legacy);
      await cache.put('index.html', new Response('smoke legacy marker'));
    }""", legacy)
    if require_sibling_preservation:
        page.evaluate("""async () => {
          const cache = await caches.open('sibling-pwa-smoke');
          await cache.put('sibling-marker', new Response('preserve sibling data'));
        }""")
    page.goto(SITE + '?demo=1', wait_until='networkidle')
    page.wait_for_function('navigator.serviceWorker.controller !== null')
    page.wait_for_function("""async ({name, shell, legacy}) => {
      const keys = await caches.keys();
      if (!keys.includes(name) || keys.includes(legacy)) return false;
      const cache = await caches.open(name);
      return (await Promise.all(shell.map(path => cache.match(path)))).every(Boolean);
    }""", arg={'name': cache_name, 'shell': shell, 'legacy': legacy})
    cached_app = page.evaluate("""async ({name, path}) =>
      (await (await caches.open(name)).match(path)).text()
    """, {'name': cache_name, 'path': app_ref})
    assert hashlib.sha256(cached_app.encode()).hexdigest() == hashes['app.js']
    report['cache_install_and_seeded_legacy_cleanup'] = 'PASS'
    if require_sibling_preservation:
        assert 'sibling-pwa-smoke' in page.evaluate('caches.keys()')
        assert page.evaluate("""async () =>
          (await (await caches.open('sibling-pwa-smoke')).match('sibling-marker')).text()
        """) == 'preserve sibling data'
        report['sibling_cache_preserved_on_production'] = 'PASS'
    else:
        report['sibling_cache_preserved_on_production'] = 'KNOWN_PRE_FIX_RELEASE_EXPLICIT_COMPATIBILITY_MODE'

    record = page.get_by_role('button', name='今日進度', exact=True)
    note = page.get_by_role('button', name='快速筆記', exact=True)
    expect(note).to_have_attribute('aria-expanded', 'true')
    page.locator('#n-title').fill('smoke unsent draft')
    record.focus()
    page.keyboard.press('Enter')
    expect(record).to_have_attribute('aria-expanded', 'true')
    expect(note).to_have_attribute('aria-expanded', 'false')
    note.click()
    expect(record).to_have_attribute('aria-expanded', 'false')
    expect(page.locator('#n-title')).to_have_value('smoke unsent draft')
    note.click()
    expect(record).to_have_attribute('aria-expanded', 'false')
    expect(note).to_have_attribute('aria-expanded', 'false')
    page.reload(wait_until='networkidle')
    expect(record).to_have_attribute('aria-expanded', 'false')
    expect(note).to_have_attribute('aria-expanded', 'false')
    note.click()
    report['desktop_exclusive_keyboard_draft_persistence'] = 'PASS'

    context.set_offline(True)
    for width, height in [(1440, 900), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        for theme in ['light', 'dark']:
            page.emulate_media(color_scheme=theme)
            page.reload(wait_until='networkidle')
            expect(page.locator('#recall-room-shortcut')).to_be_visible()
            if width < 900:
                expect(page.locator('.desktop-card-toggle')).to_have_count(0)
                page.get_by_role('button', name='進度', exact=True).click()
                expect(page.locator('#f-review')).to_be_visible()
                page.get_by_role('button', name='筆記', exact=True).click()
                expect(page.locator('#n-title')).to_be_visible()
            else:
                expect(note).to_be_visible()
                record.click()
                expect(record).to_have_attribute('aria-expanded', 'true')
                expect(note).to_have_attribute('aria-expanded', 'false')
                note.click()
            assert page.locator('body').evaluate('(body) => body.scrollWidth <= body.clientWidth')
            page.screenshot(path=str(output / f'{width}x{height}-offline-{theme}.png'))
            report['cases'].append({'viewport': [width, height], 'theme': theme, 'offline': 'PASS'})
    assert not errors, errors
    assert not blocked, blocked
    context.close()
    browser.close()

(output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))

assert health_ok, 'Cloudflare health probe failed; see health.json (PWA evidence retained)'
