"""CI-only, synthetic Chromium verification of the PR43 iPhone preview package.

This is not a real iPhone or public HTTPS deployment. No Notion, Worker,
secrets, external websites or existing production domains are contacted.
"""
import functools
import http.server
import json
import os
import subprocess
import tempfile
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = Path(os.getenv("PR43_STAGING_EVIDENCE", "/tmp/pr43-staging-evidence"))
EVIDENCE.mkdir(parents=True, exist_ok=True)

def load_result(page):
    return page.evaluate("""() =>
        JSON.parse(document.querySelector('#pr43-qa-json').textContent)
    """)

def wait_stage(page, stage):
    page.wait_for_function("""expected => {
      try {
        return JSON.parse(document.querySelector('#pr43-qa-json').textContent).stage === expected;
      } catch { return false; }
    }""", arg=stage, timeout=12000)

def serve(directory):
    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(directory))
    )
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, "http://127.0.0.1:" + str(server.server_port)

report = []
with tempfile.TemporaryDirectory(prefix="pr43-staging-") as folder:
    out = Path(folder) / "site"
    subprocess.run(["node", "scripts/staging/build-pr43.mjs", str(out)],
                   cwd=ROOT, check=True, capture_output=True, text=True)
    evidence = json.loads((out / "BUILD-EVIDENCE.json").read_text())
    assert evidence["sourceSWIdentical"] is True
    assert evidence["backendEnabled"] is False

    server, thread, origin = serve(out)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in [(390, 844), (1440, 900)]:
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        service_workers="allow", reduced_motion="reduce"
                    )
                    # Only a test stand-in for iOS's standalone display mode.
                    # A real iPhone installed-PWA result is still required.
                    context.add_init_script("""
                    Object.defineProperty(navigator, 'standalone', {
                      value: true, configurable: true
                    });
                    """)
                    page = context.new_page()
                    outside = []
                    errors = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    def route_check(route):
                        if not route.request.url.startswith(origin + "/"):
                            outside.append(route.request.url)
                            route.abort()
                        else:
                            route.continue_()
                    page.route("**/*", route_check)
                    url = origin + "/?demo=1&ui=v2"
                    page.goto(url, wait_until="load")
                    page.wait_for_function("""() =>
                        document.querySelector('#sd-v2-count')?.textContent.includes('示範資料') &&
                        document.querySelector('#mode')?.textContent.includes('示範')
                    """, timeout=15000)
                    page.evaluate("navigator.serviceWorker.ready")
                    page.reload(wait_until="load")
                    page.wait_for_function("""() => navigator.serviceWorker.controller !== null""")
                    page.wait_for_function("""() =>
                        document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                    """)
                    assert page.locator("#pr43-staging-banner").is_visible()
                    assert page.evaluate("window.CONFIG.API_BASE") == ""
                    assert page.evaluate("Object.keys(window.CONFIG.DONE_TITLES).length") == 0
                    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
                    page.locator("#pr43-qa-open").click()
                    page.locator("#pr43-qa-1").click()
                    wait_stage(page, "online-pass")
                    first = load_result(page)
                    assert first["status"] == "IN_PROGRESS", first
                    assert all(v is True for v in first["checks"].values()), first
                    assert first["displayMode"] == "standalone"

                    context.set_offline(True)
                    page.goto(url, wait_until="load")
                    page.wait_for_function("""() =>
                        document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                    """, timeout=15000)
                    assert page.locator("#pr43-staging-banner").is_visible()
                    page.locator("#pr43-qa-open").click()
                    page.locator("#pr43-qa-2").click()
                    wait_stage(page, "offline-pass")
                    offline = load_result(page)
                    assert offline["checks"]["offlineNetworkBlocked"]
                    assert offline["checks"]["offlinePrivateApiRejected"]
                    assert offline["checks"]["offlineShellRendered"]
                    page.screenshot(path=str(EVIDENCE / ("offline-" + str(width) + ".png")),
                                    full_page=True)

                    context.set_offline(False)
                    page.reload(wait_until="load")
                    page.wait_for_function("""() =>
                        document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                    """)
                    page.locator("#pr43-qa-open").click()
                    page.locator("#pr43-qa-3").click()
                    wait_stage(page, "complete")
                    final = load_result(page)
                    assert final["status"] == "PASS", final
                    assert final["candidate"] == evidence["candidate"]
                    assert all(v is True for v in final["checks"].values()), final
                    assert not errors, errors
                    assert not outside, outside
                    page.screenshot(path=str(EVIDENCE / ("online-" + str(width) + ".png")),
                                    full_page=True)
                    report.append({"viewport": width, "online": "PASS", "offline": "PASS",
                                   "recovered": "PASS", "externalRequests": 0,
                                   "syntheticStandaloneEmulation": True})
                    context.close()

                negative = browser.new_context(viewport={"width": 390, "height": 844},
                                               service_workers="block")
                p = negative.new_page()
                p.goto(origin + "/?demo=1&ui=v2", wait_until="load")
                p.wait_for_function("""() =>
                    document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                """)
                p.locator("#pr43-qa-open").click()
                p.locator("#pr43-qa-1").click()
                p.wait_for_function("""() => {
                  try { return JSON.parse(document.querySelector('#pr43-qa-json').textContent).status === 'FAIL'; }
                  catch { return false; }
                }""")
                failure = load_result(p)
                assert failure["checks"]["installedStandalone"] is False
                assert failure["checks"]["candidateController"] is False
                report.append({"negative": "browser-not-installed", "result": "FAIL_CLOSED"})
                negative.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print(json.dumps({"status": "PASS", "cases": len(report),
                  "sourceSWIdentical": True, "externalRequests": 0,
                  "device": "Chromium emulation, not iPhone",
                  "results": report}, ensure_ascii=False))
