"""PR45 isolated Chromium SW upgrade: original production sd-v136 -> candidate sd-v139.

All traffic is loopback; original production SW is loaded from pinned main
commit and current candidate SW from the checked-out product source. This simulates upgrade and failed-upgrade rollback in Chromium,
not on a real iPhone and not on a public deployment.
"""
import functools
import http.server
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CANDIDATE = "working-tree-sd-v139"
MAIN = "d96c45cc8008e21a1c5ca71e099e84c453586e9f"
EVIDENCE = Path(os.getenv("CANDIDATE_STAGING_EVIDENCE", "/tmp/pr45-staging-evidence"))
EVIDENCE.mkdir(parents=True, exist_ok=True)

def original(path, commit):
    return subprocess.run(
        ["git", "show", commit + ":" + path], cwd=ROOT,
        capture_output=True, text=True, check=True
    ).stdout

def wait_for_cache_state(page, label, timeout_sec=20):
    """Use page.evaluate, which AWAITS JS Promise results.

    Playwright wait_for_function may consider an async Promise object truthy
    before caches.keys() resolves; never use it for cache gate checks.
    """
    end = time.monotonic() + timeout_sec
    snapshot = None
    while time.monotonic() < end:
        snapshot = page.evaluate("""async () => {
          const keys = await caches.keys();
          return {
            keys,
            ready: keys.includes('sd-v139') &&
                   !keys.includes('sd-v136') &&
                   !keys.includes('sd-v136') &&
                   keys.includes('another-app-offline-v1')
          };
        }""")
        if snapshot["ready"]:
            return snapshot
        time.sleep(0.15)
    raise AssertionError({"message": label + " not satisfied", "snapshot": snapshot})


with tempfile.TemporaryDirectory(prefix="pr45-upgrade-") as folder:
    website = ROOT / "docs"
    old_script = original("docs/sw.js", MAIN)
    new_script = (ROOT / "docs" / "sw.js").read_text()
    assert old_script.startswith('const CACHE = "sd-v136";')
    assert new_script.startswith('const CACHE = "sd-v139";')
    assert (website / "sw.js").read_text() == new_script

    class Switchable(http.server.SimpleHTTPRequestHandler):
        version = "old"
        break_new_install = False
        old_script_served = 0
        new_script_served = 0

        def log_message(self, *_):
            pass

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/sw.js":
                script = old_script if type(self).version == "old" else new_script
                if type(self).version == "old":
                    type(self).old_script_served += 1
                else:
                    type(self).new_script_served += 1
                data = script.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.end_headers()
                self.wfile.write(data)
                return
            if path == "/ui-live-v2.js" and type(self).break_new_install:
                self.send_error(404, "synthetic invalid shell resource")
                return
            return super().do_GET()

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Switchable, directory=str(website))
    )
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    result = {"sourceMAIN": MAIN, "sourceCANDIDATE": CANDIDATE, "origin": "loopback-only"}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context(
                    viewport={"width": 390, "height": 844},
                    service_workers="allow", reduced_motion="reduce"
                )
                page = context.new_page()
                errors = []
                forbidden = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda req:
                    forbidden.append(req.url) if not req.url.startswith(origin + "/") else None)
                # Never call a non-loopback site.
                page.route("https://**", lambda route: route.abort())
                page.route("http://localhost/**", lambda route: route.abort())
                page.route("http://127.0.0.1:8765/**", lambda route: route.abort())
                url = origin + "/?demo=1&ui=v2"

                # Install actual MAIN privacy-safe sd-v136 SW first.
                page.goto(url, wait_until="load")
                page.evaluate("navigator.serviceWorker.ready")
                page.reload(wait_until="load")
                page.wait_for_function("""() => navigator.serviceWorker.controller !== null""")
                page.wait_for_function("""async () => (await caches.keys()).includes('sd-v136')""")
                before = page.evaluate("""async () => ({
                  caches: await caches.keys(),
                  controlled: Boolean(navigator.serviceWorker.controller),
                  title: document.title
                })""")
                assert "sd-v136" in before["caches"], before
                assert "sd-v139" not in before["caches"], before

                # Seed *synthetic* pre-privacy cache and a sibling app's cache
                # without ever contacting real APIs or touching another origin.
                seed = page.evaluate("""async () => {
                  const old = await caches.open('sd-v136');
                  await old.put('/api/synthetic-private-upgrade', new Response(
                    'SYNTHETIC_DO_NOT_PERSIST', { headers: { 'Cache-Control': 'private' } }));
                  const sibling = await caches.open('another-app-offline-v1');
                  await sibling.put('/sibling-synthetic-proof',
                    new Response('SIBLING_OK'));
                  return await caches.keys();
                }""")
                assert "sd-v136" in seed and "another-app-offline-v1" in seed
                assert page.evaluate("""async () => {
                  const response = await (await caches.open('sd-v136'))
                    .match('/api/synthetic-private-upgrade');
                  return response ? await response.text() : null;
                }""") == "SYNTHETIC_DO_NOT_PERSIST", (
                    "old broad-cache SW must actually contain the synthetic private marker")

                # Try installing the exact CANDIDATE SW, but intentionally return a
                # 404 for one of its new shell assets. The update must not
                # remove old shell or sibling cache.
                Switchable.version = "new"
                Switchable.break_new_install = True
                page.evaluate("""async () => {
                    const reg = await navigator.serviceWorker.getRegistration();
                    await reg.update();
                }""")
                page.wait_for_timeout(1600)
                fail_state = page.evaluate("""async () => ({
                  caches: await caches.keys(),
                  controlled: Boolean(navigator.serviceWorker.controller),
                  shell: Boolean(await (await caches.open('sd-v136')).match('index.html')),
                  sibling: await (await caches.open('another-app-offline-v1'))
                    .match('/sibling-synthetic-proof').then(r => r?.text())
                })""")
                assert "sd-v136" in fail_state["caches"], fail_state
                assert "sd-v139" not in fail_state["caches"], fail_state
                assert fail_state["shell"] is True
                assert fail_state["sibling"] == "SIBLING_OK"
                result["failedUpgradePreservesPrevious"] = True

                # Restore the static asset, retry the same exact new SW.
                Switchable.break_new_install = False
                page.evaluate("""async () => {
                  const reg = await navigator.serviceWorker.getRegistration();
                  await reg.update();
                }""")
                wait_for_cache_state(page, "activation and removal of old sd-v cache")
                before_reload_cache_names = page.evaluate("caches.keys()")
                page.reload(wait_until="load")
                page.wait_for_function("""() =>
                  navigator.serviceWorker.controller &&
                  document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                """)
                # SW install/activate/claim can race a navigation. The
                # no-old-cache condition must still hold after the app reload,
                # not just at one instant before reload.
                wait_for_cache_state(page, "old sd-v cache must remain deleted after reload", timeout_sec=8)
                after = page.evaluate("""async () => {
                  const cache = await caches.open('sd-v139');
                  const sibling = await caches.open('another-app-offline-v1');
                  const names = await caches.keys();
                  const keys = (await cache.keys()).map(r => r.url);
                  return {
                    names,
                    sibling: await sibling.match('/sibling-synthetic-proof').then(r => r?.text()),
                    oldPrivateStillPresent: names.includes('sd-v136'),
                    newV2Asset: Boolean(await cache.match('ui-live-v2.js')),
                    newV2Style: Boolean(await cache.match('ui-live-v2.css?v=1')),
                    badApiPersisted: keys.some(k => k.includes('/api/')),
                    controller: Boolean(navigator.serviceWorker.controller)
                  };
                }""")
                print(json.dumps({
                    "stage": "debug-pr45-upgrade",
                    "beforeReload": before_reload_cache_names,
                    "afterReload": after["names"],
                    "oldScriptServed": Switchable.old_script_served,
                    "newScriptServed": Switchable.new_script_served,
                    "browser": after,
                }, ensure_ascii=False), flush=True)
                assert after["names"].count("sd-v139") == 1
                assert "sd-v136" not in after["names"], after
                assert after["sibling"] == "SIBLING_OK", after
                assert after["oldPrivateStillPresent"] is False
                assert after["newV2Asset"] is True and after["newV2Style"] is True
                assert after["badApiPersisted"] is False
                assert after["controller"] is True
                assert not errors and not forbidden, {"pageErrors": errors, "external": forbidden}

                page.screenshot(path=str(EVIDENCE / "pr45-upgraded-v2-390.png"),
                                full_page=True)
                result.update({
                    "upgrade": "PASS", "oldVersion": "sd-v136",
                    "newVersion": "sd-v139",
                    "syntheticOldPrivateEvicted": True,
                    "siblingCachePreserved": True,
                    "newV2ShellCached": True,
                    "unlistedAPINotCached": True,
                    "externalRequests": 0,
                    "device": "Chromium, not Installed iPhone PWA"
                })
                context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print(json.dumps(result, ensure_ascii=False))
