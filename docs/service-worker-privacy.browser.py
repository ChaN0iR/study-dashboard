"""Real Chromium privacy regression against a loopback-only synthetic server.

Run with the Playwright Python environment used by visual-browser-checks.yml.
--sw-source and --expected-cache allow testing a historical worker without
modifying tracked files. No production URL, account, or credential is used.
"""
import argparse
import functools
import http.server
import json
import pathlib
import threading
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--sw-source', type=pathlib.Path)
parser.add_argument('--expected-cache', default='sd-v139')
args = parser.parse_args()
docs = pathlib.Path(__file__).resolve().parent
worker = (args.sw_source or docs / 'sw.js').read_bytes()
marker = 'synthetic-private-test-data'


class Handler(http.server.SimpleHTTPRequestHandler):
    offline = False
    shell_cookies = []
    worker_override = None
    shell_failure = None
    redirect_target_hits = 0

    def log_message(self, *_):
        pass

    def do_GET(self):
        if type(self).offline:
            self.close_connection = True
            return
        path = self.path.split('?')[0]
        if path == '/sw.js':
            body, kind = type(self).worker_override or worker, 'application/javascript'
        elif path == '/redirect-target':
            type(self).redirect_target_hits += 1
            body, kind = marker.encode(), 'text/plain'
        elif path == '/app.js' and type(self).shell_failure:
            failure = type(self).shell_failure
            self.send_response(302 if failure == 'redirect' else 404 if failure == '404' else 200)
            self.send_header('Content-Type', 'application/javascript')
            if failure == 'redirect':
                self.send_header('Location', '/redirect-target')
            elif failure in ['private', 'no-store']:
                self.send_header('Cache-Control', failure)
            elif failure == 'vary-star':
                self.send_header('Vary', '*')
            self.end_headers()
            self.wfile.write(marker.encode())
            return
        elif path == '/probe.html':
            body, kind = b'<!doctype html><title>Offline privacy test</title>', 'text/html'
        elif path in ['/private-cookie', '/private-nostore', '/api/progress']:
            body, kind = json.dumps({'marker': marker}).encode(), 'application/json'
        else:
            type(self).shell_cookies.append(self.headers.get("Cookie"))
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', kind)
        if path == '/private-cookie':
            self.send_header('Set-Cookie', 'probe_session=synthetic; Path=/; HttpOnly; SameSite=Lax')
            # Deliberately cacheable: catches HTTP-cache persistence as well as
            # Cache API persistence when Fetch hides the Set-Cookie header.
            self.send_header('Cache-Control', 'public, max-age=3600')
        else:
            self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


server = http.server.ThreadingHTTPServer(
    ('127.0.0.1', 0), functools.partial(Handler, directory=str(docs)))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = 'http://127.0.0.1:' + str(server.server_port)
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context()
            page = context.new_page()
            page.goto(origin + '/probe.html')
            context.add_cookies([{'name': 'existing_session', 'value': 'synthetic',
                                 'url': origin}])
            page.evaluate("""async oldCache => {
                await (await caches.open(oldCache)).put('/stale-private', new Response('synthetic stale'));
                await navigator.serviceWorker.register('/sw.js');
                await navigator.serviceWorker.ready;
            }""", 'sd-v135' if args.expected_cache == 'sd-v136' else 'sd-v136')
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            page.wait_for_function("name => caches.keys().then(keys => keys.includes(name))", arg=args.expected_cache)
            assert Handler.shell_cookies, 'shell install did not reach server'
            assert all(cookie is None for cookie in Handler.shell_cookies), 'install sent cookies'
            # Activation's claim occurs after eviction; verify stale body, not
            # only the version name, so a cache bump cannot hide leaked bytes.
            stale = page.evaluate("async () => !!(await caches.match('/stale-private'))")
            assert not stale, 'old private response was not evicted'
            online = page.evaluate("""async () => {
                const response = await fetch('/private-cookie');
                const body = await response.text();
                const cached = await caches.match('/private-cookie');
                return {hidden: !response.headers.has('set-cookie'), body,
                        cached: cached ? await cached.text() : null};
            }""")
            assert online['hidden'], 'test requires browser-filtered Set-Cookie'
            assert marker in online['body'], 'synthetic network response missing'
            assert any(c['name'] == 'probe_session' for c in context.cookies()), 'cookie was not accepted'
            assert online['cached'] is None, 'private response persisted in Cache API'
            for path in ['/private-nostore', '/api/progress']:
                cached = page.evaluate("""async path => {
                    await fetch(path); return !!(await caches.match(path));
                }""", path)
                assert not cached, path + ' persisted in Cache API'
            context.set_offline(True)
            Handler.offline = True
            offline = page.evaluate("""async () => {
                try { return await (await fetch('/private-cookie')).text(); }
                catch { return null; }
            }""")
            assert offline is None, 'private response remains readable offline'
            shell = page.evaluate("async () => (await fetch('/index.html')).text()")
            assert '<html' in shell.lower(), 'static shell is unavailable offline'
            print(json.dumps({'status': 'PASS', 'chromium': browser.version,
                              'hidden_set_cookie': True, 'install_omits_cookies': True, 'runtime_cache_empty': True,
                              'old_private_evicted': True, 'private_offline_unavailable': True,
                              'static_shell_offline_available': True}))
            context.close()
            Handler.offline = False
            # Each failed upgrade starts from a distinct, synthetic installed SW.
            # The fixture uses its own cache and never touches production data.
            baseline = b"""
const CACHE = 'fixture-stable-shell';
self.addEventListener('install', e => e.waitUntil((async () => {
  await (await caches.open(CACHE)).put('/index.html', new Response('stable offline shell'));
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(async () =>
  (await caches.open(CACHE)).match('/index.html'))));
"""
            failures = []
            for failure in ['private', 'no-store', 'redirect', '404', 'vary-star']:
                Handler.worker_override = baseline
                Handler.shell_failure = None
                Handler.redirect_target_hits = 0
                isolated = browser.new_context()
                try:
                    probe = isolated.new_page()
                    probe.goto(origin + '/probe.html')
                    probe.evaluate("""async () => {
                        await navigator.serviceWorker.register('/sw.js');
                        await navigator.serviceWorker.ready;
                    }""")
                    probe.wait_for_function('navigator.serviceWorker.controller !== null')
                    Handler.worker_override = worker
                    Handler.shell_failure = failure
                    state = probe.evaluate("""async () => {
                        const registration = await navigator.serviceWorker.getRegistration();
                        let timer;
                        const terminal = new Promise((resolve, reject) => {
                            timer = setTimeout(() => reject(new Error('upgrade did not terminate')), 15000);
                            registration.addEventListener('updatefound', () => {
                                const candidate = registration.installing;
                                const check = () => {
                                    if (['redundant', 'activated'].includes(candidate.state)) resolve(candidate.state);
                                };
                                candidate.addEventListener('statechange', check);
                                check();
                            }, {once: true});
                        });
                        try { await registration.update(); return await terminal; }
                        finally { clearTimeout(timer); }
                    }""")
                    assert state == 'redundant', failure + ': unsafe worker installed'
                    keys = probe.evaluate('() => caches.keys()')
                    assert keys == ['fixture-stable-shell'], (failure, 'partial candidate cache', keys)
                    assert Handler.redirect_target_hits == 0, 'install followed redirect'
                    isolated.set_offline(True)
                    Handler.offline = True
                    body = probe.evaluate("async () => (await fetch('/index.html')).text()")
                    assert body == 'stable offline shell', failure + ': previous worker lost'
                    failures.append(failure)
                finally:
                    isolated.close()
                    Handler.offline = False
                    Handler.worker_override = None
                    Handler.shell_failure = None
            print(json.dumps({'failed_upgrade_status': 'PASS', 'rejected_cases': failures,
                              'partial_cache_absent': True, 'previous_offline_shell_preserved': True,
                              'redirect_target_not_requested': True}))
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
