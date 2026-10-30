"""V2 opt-in adapter browser regression using only local and synthetic inputs.

No production host, secrets, Cloudflare Worker, or Notion API access.
"""
import functools
import http.server
import json
import os
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

DOCS = Path(__file__).resolve().parent
EVIDENCE = Path(os.environ.get("LIVE_UI_V2_EVIDENCE", "/tmp/study-live-ui-v2"))
EVIDENCE.mkdir(parents=True, exist_ok=True)
FIXED_DATE = "2026-10-27"
DATE_OVERRIDE = """
(() => {
  const OriginalDate = Date;
  const frozen = OriginalDate.parse("2026-10-27T01:30:00.000Z");
  window.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(frozen);
    }
    static now() { return frozen; }
  };
})();
"""

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
    functools.partial(QuietHandler, directory=str(DOCS)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = "http://127.0.0.1:" + str(server.server_port)
results = []

def first_actionable(page):
    return page.evaluate("""() => {
      const rows = [...document.querySelectorAll('#tasks .task-item')];
      const row = rows.find(r => !r.classList.contains('done') &&
        !r.classList.contains('blocked') && r.querySelector('.chk:not([disabled])'));
      return row?.querySelector('.task-activity')?.textContent.trim() || null;
    }""")

def install_route(page, mock_api=False):
    outside = []
    requests = []
    failure = {"state": False}
    tasks = [
        {"id": "synthetic-chem", "title": "普化｜週期表複習題 30 分鐘",
         "done": False, "skipped": False, "source": "今日", "date": FIXED_DATE,
         "order": 1, "type": "複習", "estimatedMinutes": 30, "difficulty": "標準"},
        {"id": "synthetic-eng", "title": "英文｜單字複習 20 分鐘",
         "done": False, "skipped": False, "source": "今日", "date": FIXED_DATE,
         "order": 2, "type": "複習", "estimatedMinutes": 20, "difficulty": "標準"}
    ]
    def handler(route):
        request = route.request
        url = request.url
        # The desktop app optionally probes AnkiConnect on localhost:8765.
        # Intercept that known optional integration with a synthetic response
        # instead of reaching a real local app or misclassifying it as leakage.
        if url == "http://127.0.0.1:8765/" and request.method == "POST":
            route.fulfill(status=200, headers={"Content-Type": "application/json"},
                          body='{"result":[],"error":null}')
            return
        if not url.startswith(origin + "/"):
            outside.append(url)
            route.abort()
            return
        path = urlparse(url).path
        if mock_api and path.startswith("/sandbox-api/"):
            requests.append((request.method, path))
            headers = {"Content-Type": "application/json", "Cache-Control": "no-store"}
            if path == "/sandbox-api/api/state" and request.method == "GET" and failure["state"]:
                route.fulfill(status=503, headers=headers,
                              body='{"error":"synthetic background refresh failure"}')
            elif path == "/sandbox-api/api/state" and request.method == "GET":
                route.fulfill(status=200, headers=headers, body=json.dumps({
                    "today": FIXED_DATE,
                    "tasks": tasks,
                    "lessons": [],
                    "courseStats": [],
                    "record": {"date": FIXED_DATE, "hours": 0, "minutes": 0,
                               "review": "", "points": "", "mood": ""}
                }))
            elif path == "/sandbox-api/api/focus" and request.method == "GET":
                route.fulfill(status=200, headers=headers, body=json.dumps({
                    "today": FIXED_DATE, "now": 1793080000000, "active": None,
                    "todayDoneSec": 0, "sessions": [], "history": [], "days": []
                }))
            elif path == "/sandbox-api/api/reschedule" and request.method == "GET":
                route.fulfill(status=200, headers=headers, body='{"proposal":null}')
            elif path.startswith("/sandbox-api/api/task/") and request.method == "POST":
                route.fulfill(status=503, headers=headers,
                              body='{"error":"synthetic rejected write"}')
            else:
                route.fulfill(status=400, headers=headers,
                              body='{"error":"unexpected synthetic endpoint"}')
            return
        route.continue_()
    page.route("**/*", handler)
    return outside, requests, failure

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width, height in [(1440, 900), (390, 844), (320, 740)]:
                for theme in ("light", "dark"):
                    context = browser.new_context(viewport={"width": width, "height": height},
                                                  color_scheme=theme,
                                                  reduced_motion="reduce",
                                                  service_workers="block")
                    context.add_init_script(DATE_OVERRIDE)
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    outside, calls, _ = install_route(page)
                    page.goto(origin + "/index.html?demo=1&ui=v2", wait_until="load")
                    page.wait_for_function("""() => {
                      const hero = document.querySelector('#sd-v2-title');
                      return hero && !hero.textContent.includes('讀取') &&
                        document.querySelector('#task-count')?.textContent.includes('/');
                    }""")
                    assert page.locator("#sd-v2-live").is_visible()
                    assert page.locator("#sd-v2-count").inner_text().startswith("示範資料")
                    first = first_actionable(page)
                    assert first, "demo task list should contain an actionable item"
                    assert page.locator("#sd-v2-title").inner_text() == first
                    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
                    assert not outside, outside
                    page.screenshot(path=str(EVIDENCE / (str(width) + "-" + theme + ".png")),
                                    full_page=True)
                    # Reproduce a task which is not done but temporarily
                    # disabled (optimistic API write). The hero and its CTA
                    # must agree on the *same* next actionable task.
                    page.evaluate("""() => {
                      const first = [...document.querySelectorAll('#tasks .task-item')]
                        .find(r => !r.classList.contains('done') &&
                          !r.classList.contains('blocked') &&
                          r.querySelector('.chk:not([disabled])'));
                      first.querySelector('.chk').disabled = true;
                    }""")
                    page.wait_for_function("""previous => {
                      const title = document.querySelector('#sd-v2-title')?.textContent;
                      return title && title !== previous &&
                        !document.querySelector('#sd-v2-task').disabled;
                    }""", arg=first)
                    second = first_actionable(page)
                    page.locator("#sd-v2-task").click()
                    assert page.evaluate("document.activeElement.classList.contains('task-activity')")
                    assert page.evaluate("document.activeElement.textContent.trim()") == second
                    page.evaluate("""() => {
                      document.querySelector('#tasks .task-item .chk').disabled = false;
                    }""")
                    page.wait_for_function("""previous =>
                      document.querySelector('#sd-v2-title')?.textContent === previous
                    """, arg=first)

                    # Focus shortcut only navigates and focuses the existing focus
                    # control. It must never click it, which could end a session.
                    before = page.locator("#fc-main").get_attribute("data-state")
                    page.locator("#sd-v2-focus").click()
                    assert page.locator("#fc-main").get_attribute("data-state") == before
                    assert page.evaluate("document.activeElement.id === 'fc-main'")
                    # Desktop hides mobile bottom tabs; exercise the
                    # same existing tab handler without a non-visible click.
                    if width >= 900:
                        page.evaluate("""() =>
                            document.querySelector('#tabs button[data-t="today"]').click()
                        """)
                    else:
                        page.locator('#tabs button[data-t="today"]').click()

                    check = page.locator("#tasks .task-item:not(.done):not(.blocked) .chk:not([disabled])").first
                    check.click()
                    page.wait_for_function("""previous => {
                      const hero = document.querySelector('#sd-v2-title');
                      const rows = [...document.querySelectorAll('#tasks .task-item')];
                      const next = rows.find(r => !r.classList.contains('done') &&
                        !r.classList.contains('blocked') && r.querySelector('.chk:not([disabled])'));
                      return hero && next &&
                        hero.textContent === next.querySelector('.task-activity').textContent.trim() &&
                        hero.textContent !== previous;
                    }""", arg=first)
                    assert not outside and not errors, {"external": outside, "errors": errors}

                    # Disabling the query flag must leave original app unchanged.
                    page.goto(origin + "/index.html?demo=1", wait_until="load")
                    # The app loads demo tasks asynchronously after DOM load.
                    page.wait_for_function("""() =>
                      document.querySelectorAll('#tasks .task-item').length > 0
                    """, timeout=10000)
                    assert page.locator("#sd-v2-live").count() == 0
                    results.append({"case": str(width) + "x" + str(height) + " " + theme,
                                    "demo_bridge": "PASS", "flag_off": "PASS"})
                    context.close()

            # Real API request path, with synthetic same-origin route responses:
            # reject a task update, assert original optimistic UI rolls back and
            # the new hero never displays a "confirmed" completion.
            for width in (390, 1440):
                context = browser.new_context(viewport={"width": width, "height": 900},
                                              service_workers="block")
                context.add_init_script(DATE_OVERRIDE)
                context.add_init_script("""
                (() => {
                  localStorage.setItem('appKey', 'synthetic-only');
                  localStorage.setItem('apiBase', location.origin + '/sandbox-api');
                })();
                """)
                page = context.new_page()
                outside, calls, failure = install_route(page, mock_api=True)
                page.goto(origin + "/index.html?ui=v2", wait_until="load")
                page.wait_for_function("""() =>
                  document.querySelector('#sd-v2-count')?.textContent.includes('0 / 2') &&
                  document.querySelector('#sd-v2-task:not([disabled])')""")
                original = page.locator("#sd-v2-title").inner_text()
                assert original == first_actionable(page)
                # Same-day cached tasks remain after a silent background fetch
                # failure; V2 must not present them as successfully verified.
                failure["state"] = True
                page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
                page.wait_for_function("""() =>
                  document.querySelector('#tasks')?.dataset.stateVerified === 'false' &&
                  document.querySelector('#sd-v2-title')?.textContent ===
                    '目前無法確認下一項任務'
                """, timeout=10000)
                assert page.locator("#sd-v2-task").is_disabled()
                assert page.locator("#sd-v2-count").inner_text() == "尚未取得可靠任務資料"
                assert page.locator("#banner").is_hidden(), (
                    "a silent refresh failure must be detected without an error banner")
                assert page.locator("#tasks .task-item").count() == 2, (
                    "cached tasks must remain visible but unverified")
                failure["state"] = False
                page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
                page.wait_for_function("""() =>
                  document.querySelector('#tasks')?.dataset.stateVerified === 'true' &&
                  document.querySelector('#sd-v2-title')?.textContent !==
                    '目前無法確認下一項任務'
                """, timeout=10000)
                assert page.locator("#sd-v2-task").is_enabled()
                page.locator("#sd-v2-focus").click()
                assert page.evaluate("document.activeElement.id === 'fc-main'")
                assert not any(method == "POST" for method, _ in calls), (
                    "opening focus must not start or stop a persisted focus session")
                if width >= 900:
                    page.evaluate("""() =>
                        document.querySelector('#tabs button[data-t="today"]').click()
                    """)
                else:
                    page.locator('#tabs button[data-t="today"]').click()
                page.locator("#tasks .task-item:not(.done):not(.blocked) .chk:not([disabled])").first.click()
                page.wait_for_function("""() =>
                  document.querySelector('#banner')?.hidden === false &&
                  document.querySelector('#sd-v2-title')?.textContent ===
                    '目前無法確認下一項任務'""")
                assert page.locator("#tasks .task-item.done").count() == 0, (
                    "optimistic checkbox change must rollback")
                assert page.locator("#sd-v2-count").inner_text() == "尚未取得可靠任務資料"
                assert calls.count(("POST", "/sandbox-api/api/task/synthetic-chem")) == 1, calls
                assert not outside, outside
                results.append({"case": str(width) + " synthetic rejected API",
                                "rollback": "PASS", "unverified": "PASS",
                                "silent_refresh_stale_then_recovers": "PASS"})
                context.close()
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

print(json.dumps({"status": "PASS", "cases": len(results),
                  "screenshots": len(list(EVIDENCE.glob("*.png"))),
                  "externalRequests": 0, "results": results}, ensure_ascii=False))
