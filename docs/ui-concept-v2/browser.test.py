"""Browser-only Study Dashboard UI concept regression.

Runs a temporary loopback server with synthetic preview data only.
No production accounts, GitHub Pages, Notion, Worker, or external requests.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import os

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
EVIDENCE = Path(os.environ.get("UI_PREVIEW_EVIDENCE", "/tmp/study-ui-concept-v2"))
EVIDENCE.mkdir(parents=True, exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = "http://127.0.0.1:" + str(server.server_port)
results = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width, height in [(1440, 900), (402, 874), (390, 844), (320, 740)]:
                for theme in ("light", "dark"):
                    context = browser.new_context(
                        viewport={"width": width, "height": height},
                        color_scheme=theme,
                        reduced_motion="reduce",
                        service_workers="block",
                    )
                    page = context.new_page()
                    errors = []
                    seen_urls = []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    page.on("request", lambda request: seen_urls.append(request.url))
                    page.goto(origin + "/index.html", wait_until="load")
                    page.wait_for_function(
                        "document.querySelector('#timer-display').textContent === '25:00'"
                    )
                    assert page.locator("#next-title").inner_text() == "原子結構與週期表"
                    assert page.locator("#start-focus").is_enabled()
                    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
                    assert page.evaluate("localStorage.length === 0")
                    assert all(url.startswith(origin + "/") for url in seen_urls), seen_urls

                    # A screenshot before interactions preserves visual evidence.
                    name = str(width) + "x" + str(height) + "-" + theme
                    page.screenshot(path=str(EVIDENCE / (name + ".png")), full_page=True)

                    # Finishing the next task updates the spotlight and timer.
                    page.locator("#task-list input").nth(1).check(force=True)
                    assert page.locator("#next-title").inner_text() == "生化先修 01-2 堂"
                    assert page.locator("#timer-display").inner_text() == "45:00"
                    page.locator("#timer-toggle").click()
                    assert "進行中" in page.locator("#timer-state").inner_text()
                    page.wait_for_timeout(1050)
                    page.locator("#timer-toggle").click()
                    assert "已暫停" in page.locator("#timer-state").inner_text()
                    paused_time = page.locator("#timer-display").inner_text()
                    page.locator("#task-list input").nth(2).check(force=True)
                    assert page.locator("#next-title").inner_text() == "物理錯題閉卷重測"
                    assert page.locator("#timer-display").inner_text() == paused_time, (
                        "checking another task cannot discard a paused session"
                    )
                    page.locator("#timer-reset").click()
                    assert page.locator("#timer-display").inner_text() == "20:00"
                    page.locator("#task-list input").nth(3).check(force=True)
                    assert page.locator("#next-title").inner_text() == "今天的任務已完成"
                    assert page.locator("#start-focus").is_disabled()

                    navigation = ".side" if width > 760 else ".mobile-tabs"
                    page.locator(navigation + ' button[data-view="notes"]').click()
                    assert page.locator('[data-panel="notes"]').is_visible()
                    page.locator("#demo-note").fill("synthetic ephemeral note")
                    page.reload(wait_until="load")
                    page.wait_for_function(
                        "document.querySelector('#timer-display').textContent === '25:00'"
                    )
                    page.locator(navigation + ' button[data-view="notes"]').click()
                    assert page.locator("#demo-note").input_value() == "", (
                        "preview note must not be stored"
                    )
                    assert not errors, errors
                    results.append({"viewport": name, "status": "PASS"})
                    context.close()
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

print(json.dumps({
    "status": "PASS",
    "cases": len(results),
    "screenshots": len(list(EVIDENCE.glob("*.png"))),
    "no_external_requests": True,
    "no_persistence": True,
    "results": results,
}, ensure_ascii=False))
