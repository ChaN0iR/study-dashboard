"""Offline opt-in V2 + PWA integration on synthetic demo data (no production)."""
import functools
import http.server
import json
import os
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
EVIDENCE = Path(os.environ.get("LIVE_UI_V2_EVIDENCE", "/tmp/study-live-ui-v2"))
EVIDENCE.mkdir(parents=True, exist_ok=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
    functools.partial(QuietHandler, directory=str(ROOT)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = "http://127.0.0.1:" + str(server.server_port)
results = []
frozen_clock = """(() => {
  const OriginalDate = Date;
  const frozen = OriginalDate.parse('2026-10-27T01:30:00.000Z');
  window.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [frozen]));
    }
    static now() { return frozen; }
  };
})();"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width, height in [(390, 844), (1440, 900)]:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    service_workers="allow", reduced_motion="reduce"
                )
                context.add_init_script(frozen_clock)
                page = context.new_page()
                errors = []
                outside = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                def intercept(route):
                    if not route.request.url.startswith(origin + "/"):
                        outside.append(route.request.url)
                        route.abort()
                    else:
                        route.continue_()
                page.route("**/*", intercept)
                url = origin + "/index.html?demo=1&ui=v2"
                page.goto(url, wait_until="load")
                page.wait_for_function("""() =>
                    document.querySelector('#sd-v2-live') &&
                    document.querySelector('#sd-v2-title')?.textContent !== '讀取中' &&
                    document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                """)
                page.wait_for_function("""() =>
                    navigator.serviceWorker?.controller !== null
                """, timeout=20000)
                page.reload(wait_until="load")
                page.wait_for_function("""() =>
                    document.querySelector('#sd-v2-count')?.textContent.includes('示範資料')
                """)
                cache_state = page.evaluate("""async () => {
                    const names = await caches.keys();
                    const cache = await caches.open('sd-v139');
                    const keys = (await cache.keys()).map(item => new URL(item.url).pathname +
                        new URL(item.url).search);
                    return {names, keys};
                }""")
                assert "sd-v139" in cache_state["names"], cache_state
                for asset in ["/app.js?v=124", "/ui-live-v2.js", "/ui-live-v2.css?v=1"]:
                    assert asset in cache_state["keys"], (asset, cache_state)

                context.set_offline(True)
                page.goto(url, wait_until="load")
                page.wait_for_function("""() =>
                    document.querySelector('#sd-v2-count')?.textContent.includes('示範資料') &&
                    document.querySelector('#sd-v2-title')?.textContent &&
                    !document.querySelector('#sd-v2-title')?.textContent.includes('無法確認') &&
                    !document.querySelector('#sd-v2-title')?.textContent.includes('讀取中')
                """, timeout=20000)
                assert page.locator("#sd-v2-live").is_visible()
                assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
                assert not errors, errors
                assert not outside, outside
                # Only a synthetic demo task may be selected. It must be
                # present and focusable, even with all networking disabled.
                page.locator("#sd-v2-task").click()
                assert page.evaluate("document.activeElement.classList.contains('task-activity')")
                page.screenshot(path=str(EVIDENCE / ("offline-" + str(width) + ".png")),
                                full_page=True)
                results.append({"viewport": width, "offline_demo_v2": "PASS",
                                "shell_assets": "PASS", "external": 0})
                context.close()
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

print(json.dumps({"status": "PASS", "cases": len(results),
                  "evidence": len(results), "cache": "sd-v139",
                  "results": results}, ensure_ascii=False))
