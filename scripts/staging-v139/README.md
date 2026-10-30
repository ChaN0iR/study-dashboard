# PR #46｜PR #45 `sd-v139` iPhone STAGING ONLY 驗收包

**狀態：只建置（BUILD ONLY），不得認定已部署／已完成實機驗收。**

此分支是 #45 精確候選 `b83c37688990fe215706ec18cc43a1965bc1c2f9` 的衍生測試工作，不能替換產品 commit 或改寫先前 #43 已驗收的 `sd-v138`。#45 主線 PR 維持 Draft；#39/#42/#43 不應重複合併。

## 使用範圍

- **產品候選 SW**：`sd-v139`，逐位元與 #45 指定 commit 完全相同。建置程式另外驗證 **SHELL 中每一個原始檔案**與候選 commit 的 blob 完全一致，除了合成包中明確列出的 app/config/index/manifest 專用變換。
- **預覽專用 app.js**：從原版強制 `DEMO=true`、`ui=v2`，拒絕 `?api=` 改寫及本機 API base；確保沒有正式 API 存取。**此 app.js 非正式版原始雜湊**。
- **預覽專用 config.js**：清空 `API_BASE`、`DONE_TITLES`、`SCHEDULE`；Manifest／iPhone App 名稱是**PR45測試**；頂部醒目 `PR #45 · STAGING ONLY` 與「驗收」入口。
- **發佈安全**：不帶 Notion/Worker/D1/DO/Cron 資源、token／環境變數，不呼叫外站；含 `_headers` 嚴格 CSP + `noindex`、`_redirects` 內部 200 rewrite（避免候選 SW 使用 `redirect:error` 時的 canonical redirect）、`404.html` 防未知 API 路由被當成 index。
- **15 項 iPhone 合成檢查**：包含原 #43 的線上／斷網／恢復網路 13 項，加上 **syntheticStaleMarkerBlocksHero** 與 **syntheticMarkerRecovery**。後兩項在測試頁內短暫設定 DOM 的 `data-state-verified=false`，確認 V2 不再把舊任務當成可操作，接著恢復為 true。這是**合成 DOM 行為驗證，不是真正正式 API 503**；真正合成 API 失敗／恢復已由 #45 `ui-live-v2.browser.py` 測試。
- 失敗、沒有控制 SW、缺少嚴格 CacheStorage 資產、不是 standalone、跳過步驟或不曾真正離線，均不能獲得 `PASS`。

## 重現建置

需要 Node 24 + Python 3.12；程式只接受空目錄，**不會呼叫 Cloudflare**：

```bash
node --test scripts/staging-v139/v139-staging.test.mjs
node scripts/staging-v139/build-v139.mjs /tmp/pr45-v139-synthetic-only
python scripts/staging-v139/v139-staging.browser.py
python docs/sw-upgrade-v139.browser.py
```

GitHub Actions workflow `pr45-staging-synthetic.yml`（權限僅 `contents:read`）會先執行 Node fail-closed package contracts，再以獨立 Chromium 在 390px/1440px 模擬 standalone、真正阻斷本地 HTTP 伺服器傳輸以驗證離線重開／API 拒絕，且用未安裝 SW 的負向案例證明不能假通過；另外用原本正式 `sd-v136` 原版 SW → `sd-v139` 執行升級／失敗回復及私人合成快取清除。最後產出 **STAGING ONLY ZIP、BUILD-EVIDENCE.json 與截圖**，保留 14 天。這些是 Chromium／build 證據，**不是 iPhone 真機、也不是公開測試站**。

## 取得新 STAGING HTTPS 上傳授權後

1. 使用**全新** Cloudflare Pages Direct Upload 專案，例如 `study-dashboard-pr45-synth-v139`；**不可覆蓋**正式網站、先前 #39 或 #43 測試 Origin。不要接 Git/自動發布、不設 Worker binding 或 secret。只有上傳 **內層** `pr45-synthetic-preview.zip`，不能將整個 GitHub Actions artifact ZIP 當作網站根目錄。
2. **工程端先核對遠端：** `/` 與 `/index.html` 均 200（無 301/302），`sw.js` SHA-256 等於 `BUILD-EVIDENCE.json.swSha256`，manifest 名稱 `PR45測試`，V2 JS/CSS MIME，`/api/pr45-synthetic-private` 及未知路由 404、CSP/noindex Headers，Chromium 公開網址 V2 正常且無外部請求。未證明之前不要加入 iPhone 主畫面。
3. **iPhone 操作仍是 3 步：** Safari → 加到主畫面 → 從「PR45測試」開啟，驗收按 `1. 已連網`；關飛航與 Wi-Fi，從主畫面重新打開 App，按 `2. 離線`；恢復網路，從主畫面重新開啟按 `3. 恢復網路`；複製 JSON 回私人聊天。驗證 `fixture=pr45-installed-pwa-v1`、`candidate=b83c...`、`cache=sd-v139`、`displayMode=standalone`、`15/15 true`、`stage=complete`、`status=PASS`。
4. 未在真正 iPhone 同一個 App 執行 `sd-v136`→`sd-v139` 原位升級；本包是**新安裝候選驗收**。獨立人類 review、GitHub Pages 正式來源映射、合併／正式發布仍是各自 release gates。

**禁止誤導：** 不自動發佈、不合併，不請使用者公開貼完整 User-Agent/runId，也不將 #43 的 iPhone `sd-v138` PASS 當作 `sd-v139` PASS。任何 release 失敗回滾只能維持隱私 SW 的安全行為、使用更高版本向前修復，不能直接回到 `sd-v136`。
