/* PR43_STAGING_DIAGNOSTICS - synthetic offline checks embedded in cached index.html.
   Only local CacheStorage, browser network probes and synthetic run state are used. */
(() => {
  "use strict";
  const CANDIDATE = "10c395f57b78fb92248e59bbe2c4edd456e43fca";
  const CACHE = "sd-v138";
  const KEY = "pr43-staging-only-qa-v1";
  const required = ["app.js?v=123", "ui-live-v2.js", "ui-live-v2.css?v=1", "index.html"];
  const $ = (id) => document.getElementById(id);

  // In a public synthetic preview, links never navigate to external accounts.
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest("a");
    if (!anchor) return;
    const url = anchor.getAttribute("href") || "";
    if (anchor.id === "anki-link" || anchor.dataset.stagingExternal ||
        (url && !url.startsWith("#") && new URL(url, location.href).origin !== location.origin)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  const styles = document.createElement("style");
  styles.textContent = [
    "#pr43-qa{width:min(92vw,560px);max-height:87dvh;overflow:auto;border:1px solid #b1ccc1;border-radius:16px;padding:16px;background:#f6faf7;color:#172b22;box-shadow:0 14px 50px #0004;}",
    "#pr43-qa::backdrop{background:#0b2119a9}",
    "#pr43-qa h2{font-size:19px;margin:0 0 6px;color:#172b22}",
    "#pr43-qa p{font-size:13px;line-height:1.55;margin:8px 0;color:#203a2d}",
    "#pr43-qa .qa-steps{display:flex;flex-direction:column;gap:8px}",
    "#pr43-qa button{border:1px solid #628776;border-radius:10px;background:white;color:#172b22;min-height:43px;padding:9px 12px;text-align:left;font-size:13px;cursor:pointer}",
    "#pr43-qa button:disabled{opacity:.45;cursor:not-allowed}",
    "#pr43-qa pre{max-height:24dvh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;background:#e7f2e9;padding:10px;border-radius:10px}",
    "#pr43-qa #pr43-qa-status{font-weight:650;border-left:3px solid #628776;padding-left:8px}"
  ].join("\n");
  document.head.append(styles);
  document.body.insertAdjacentHTML("beforeend", [
    '<dialog id="pr43-qa" aria-label="PR43 iPhone PWA 合成驗收">',
    '<h2>PR #43｜主畫面 App 驗收</h2>',
    '<p>僅限 STAGING ONLY。沒有登入、Notion、Worker 或正式學習紀錄。請從主畫面的「PR43測試」圖示操作。</p>',
    '<p id="pr43-qa-status" role="status" aria-live="polite">按 1 開始</p>',
    '<div class="qa-steps">',
    '<button type="button" id="pr43-qa-1">1. 已連網：檢查安裝版和靜態資源</button>',
    '<button type="button" id="pr43-qa-2">2. 飛航＋Wi-Fi 關閉，從主畫面重開後按這裡</button>',
    '<button type="button" id="pr43-qa-3">3. 恢復網路，重開 App 後按這裡</button>',
    '<button type="button" id="pr43-qa-copy">複製驗收 JSON</button>',
    '<button type="button" id="pr43-qa-close">返回儀表板</button>',
    '</div>',
    '<pre id="pr43-qa-json" aria-label="驗收 JSON">尚未開始</pre>',
    '</dialog>'
  ].join(""));
  const dialog = $("pr43-qa");
  const status = $("pr43-qa-status");
  const output = $("pr43-qa-json");
  const load = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      return v && v.fixture === "pr43-installed-pwa-v1" && v.candidate === CANDIDATE ? v : null;
    } catch { return null; }
  };
  const save = (data) => {
    localStorage.setItem(KEY, JSON.stringify(data));
    output.textContent = JSON.stringify(data, null, 2);
    status.textContent = data.status === "PASS" ? "完成：合成安裝版測試通過" :
      data.status === "FAIL" ? "測試未通過；保留結果讓工程端排查" :
      data.stage === "offline-pass" ? "離線檢查通過；恢復網路後按 3" :
      data.stage === "online-pass" ? "線上檢查通過；現在關閉網路並從主畫面重開 App" : "準備中";
  };
  const render = () => {
    const v = load();
    if (v) save(v); else {
      output.textContent = "尚未開始；請先確保在主畫面安裝版開啟。";
      status.textContent = "按 1 開始（需要網路）";
    }
  };
  const fresh = () => ({
    fixture: "pr43-installed-pwa-v1", candidate: CANDIDATE,
    cache: CACHE, runId: crypto.randomUUID(), userAgent: navigator.userAgent,
    displayMode: null, checks: {}, stage: "init", status: "IN_PROGRESS",
    completedAt: null
  });
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  const assetCheck = async () => {
    const names = await caches.keys();
    if (!names.includes(CACHE)) return false;
    const cache = await caches.open(CACHE);
    for (const entry of required) {
      const request = new Request(new URL(entry, location.href), { credentials: "omit" });
      if (!await cache.match(request)) return false;
    }
    return true;
  };
  const cachePrivateFree = async () => {
    const cache = await caches.open(CACHE);
    return !(await cache.keys()).some((request) => {
      const path = new URL(request.url).pathname;
      return path.includes("/api/") || path.includes("/recall/");
    });
  };
  const requestProbe = (path) => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", path + "?nonce=" + crypto.randomUUID());
    xhr.timeout = 7000;
    // Some WebKit/Chromium SW failures surface onload with status 0.
    // Only an actual HTTP status demonstrates that the network responded.
    xhr.onload = () => resolve({ networkResponded: xhr.status > 0, status: xhr.status });
    xhr.onerror = () => resolve({ networkResponded: false, status: null });
    xhr.ontimeout = () => resolve({ networkResponded: false, status: null });
    xhr.send();
  });
  const fail = (v, reason) => {
    v.status = "FAIL";
    v.error = String(reason).slice(0, 140);
    save(v);
  };
  const isControlled = () => {
    const c = navigator.serviceWorker?.controller;
    return !!c && new URL(c.scriptURL).pathname === new URL("./sw.js", location.href).pathname;
  };
  const isDemo = () =>
    $("mode")?.textContent.includes("示範") &&
    $("sd-v2-count")?.textContent.includes("示範資料");
  const isV2 = () => !!$("sd-v2-live") && !!$("sd-v2-task");
  const allTrue = (data) => Object.values(data).every((v) => v === true);

  $("pr43-qa-open").addEventListener("click", () => { render(); dialog.showModal(); });
  $("pr43-qa-close").addEventListener("click", () => dialog.close());

  $("pr43-qa-1").addEventListener("click", async () => {
    const v = fresh();
    v.displayMode = standalone() ? "standalone" : "browser";
    try {
      v.checks.installedStandalone = standalone();
      v.checks.candidateController = isControlled();
      v.checks.v2Rendered = isV2();
      v.checks.demoOnly = !!isDemo();
      v.checks.staticShellReady = await assetCheck();
      v.checks.noPrivateApiCached = await cachePrivateFree();
      // Unique, uncached same-origin request must respond while online.
      const probe = await requestProbe("./pr43-online-probe");
      v.checks.onlineResponded = probe.networkResponded;
      if (!allTrue(v.checks)) return fail(v, "線上或安裝版前置條件尚未通過。檢查九項布林值。");
      v.stage = "online-pass";
      save(v);
    } catch (e) { fail(v, "線上檢查失敗：" + e.message); }
  });

  $("pr43-qa-2").addEventListener("click", async () => {
    const v = load();
    if (!v || v.stage !== "online-pass" || v.status !== "IN_PROGRESS") {
      status.textContent = "請先完成線上檢查 1；不可跳步或沿用失敗結果。";
      return;
    }
    try {
      // XMLHttpRequest avoids the source app's forced-demo window.fetch guard:
      // the actual Service Worker must reject these distinct uncached requests.
      const network = await requestProbe("./pr43-offline-probe");
      const api = await requestProbe("./api/pr43-synthetic-private");
      v.checks.offlineNetworkBlocked = !network.networkResponded;
      v.checks.offlinePrivateApiRejected = !api.networkResponded;
      v.checks.offlineShellRendered = !!isV2() && !!isDemo();
      v.checks.offlineCandidateControlled = isControlled();
      if (!allTrue(v.checks)) return fail(v, "離線網路或安全邊界檢查未通過。");
      v.stage = "offline-pass";
      save(v);
    } catch (e) { fail(v, "離線檢查失敗：" + e.message); }
  });

  $("pr43-qa-3").addEventListener("click", async () => {
    const v = load();
    if (!v || v.stage !== "offline-pass" || v.status !== "IN_PROGRESS") {
      status.textContent = "請先完成步驟 1、2；請勿猜測或補填 PASS。";
      return;
    }
    try {
      const probe = await requestProbe("./pr43-online-restored");
      v.checks.onlineRestored = probe.networkResponded;
      v.checks.restoredV2 = !!isV2() && !!isDemo();
      if (!allTrue(v.checks)) return fail(v, "恢復網路或 V2 顯示檢查未通過。");
      v.stage = "complete";
      v.status = "PASS";
      v.completedAt = new Date().toISOString();
      save(v);
    } catch (e) { fail(v, "恢復網路檢查失敗：" + e.message); }
  });

  $("pr43-qa-copy").addEventListener("click", async () => {
    const data = load();
    if (!data) return;
    const content = JSON.stringify(data, null, 2);
    output.textContent = content;
    try {
      await navigator.clipboard.writeText(content);
      status.textContent = "已複製結果；請貼給 ChatGPT（不含帳密）。";
    } catch {
      status.textContent = "無法自動複製；請長按下方 JSON 選取並複製。";
    }
  });
  render();
})();
