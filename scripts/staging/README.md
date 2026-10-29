# PR #43：iPhone V2 合成驗收包（只建置，不部署）

**本分支從 #43 的已通過 Chromium/PWA/privacy CI 的 commit `10c395f57b78fb92248e59bbe2c4edd456e43fca` 衍生。**

本工作僅準備一個可分開部署到全新 HTTPS Origin 的測試包；不可默認上傳 Cloudflare、合併任何 PR、公開正式資料、改動正式 Worker 或讀寫 Notion。

## 內容與安全界線

- 由 `docs/sw.js` 中 **精確 SHELL 清單** 決定複製哪些檔案，並額外複製原 `sw.js`；建置程式先驗證此 SW 與固定 #43 commit **逐位元相同**，沒有自行重寫 Service Worker 隱私政策。
- 合成預覽的 `app.js` 必要轉換僅為強制 `DEMO=true`、強制顯示 V2、關閉 `?api=` 對本機儲存的覆寫，並將 `apiBase()` 改為空字串。這份 **演示版 app.js 不等於正式版產品 hash**，不能用預覽通過代替正式打包驗證。
- `config.js` 將 `API_BASE` 清空，並將個人已完成課程 `DONE_TITLES`、固定生活排程 `SCHEDULE` 清空，不匯出個人資料。
- 原 HTML 的外站網址被替換為 disabled 的假連結，停用 Recall Room 啟動腳本。安全 CSP 僅容許同網域的 connect，測試頁不含 Token、APP_KEY 或正式資料。
- 專用 Home Screen 標籤：**PR43測試**，可與原本主畫面 Study Dashboard 區分；頁面明顯顯示 `STAGING ONLY`。
- 「驗收」面板寫在首頁、因此可被原 Service Worker 靜態快取，且即使離線重開，仍能依序操作 1、2、3 並複製 JSON。狀態僅存在**此隔離測試網域**的 localStorage。
- 產生 `_redirects`（`/index.html / 200` 內部重寫），供 Cloudflare Pages 避免 index canonical redirect 破壞候選 Service Worker `redirect:error` 的安裝檢查；`404.html` 明確關閉未知路徑的 SPA fallback。

## 建置／獨立驗證

使用 Node 24；只在新空資料夾建立，**不部署**：

```sh
node --test scripts/staging/pr43-staging.test.mjs
node scripts/staging/build-pr43.mjs /tmp/pr43-synthetic-preview
# 自動瀏覽器測試需要 playwright 1.56.0 及 Chromium：
python scripts/staging/pr43-staging.browser.py
python scripts/staging/pr43-upgrade.browser.py
```

Workflow `pr43-staging-synthetic.yml` 自動執行 Node fail-closed tests 與真實 Chromium **合成 standalone 模擬**，涵蓋 390/1440px：連網初檢、完整斷網後 SW 重開、未知同源與 `/api/pr43-synthetic-private` 離線拒絕、恢復連網、缺少 SW 時的假陽性拒絕。另有使用 **#39 sd-v137 與 #43 sd-v138 指定 commit 的真實原版 SW** 執行的本機升級測試：舊版安裝、合成 sd-v136 私人快取及 sibling cache 種子、故意以 404 讓新版升級失敗並保留舊離線 shell、修復後重試、等待新 SW activate 真正完成、驗證舊快取刪除及 V2 資產快取。測試不連正式網域，沒有 Cloudflare credentials。

通過後 Actions artifact 包含可部署的 **STAGING ONLY ZIP**、原始測試 JSON／截圖及 `BUILD-EVIDENCE.json`。Artifacts 不是已發布的網址。

## 取得額外授權後才可部署

1. 使用全新且**不同於正式站、#39 staging** 的 Cloudflare Pages 測試專案／HTTPS Origin；獨立 Domain 與 CacheStorage，關閉 Git auto-deploy。只上傳該 ZIP 裡的合成靜態檔案，**不使用任何 Notion、Worker、D1、DO、環境變數或 API secrets**。
2. 部署後由工程端唯讀核對 `/sw.js` 遠端 SHA-256 與 `BUILD-EVIDENCE.json.swSha256` 相同、首頁正常 `200`、`/index.html` 不 redirect、靜態 JS/CSS MIME、陌生 `/api/` endpoint 為 `404`、CSP 及 `noindex` headers、iPhone Manifest/圖示。若其中一項失敗，**不請使用者安裝**。
3. 取得使用者允許做 iPhone 安裝版實機驗收後，要求從 Safari「分享 → 加入主畫面」，選取 **PR43測試** 圖示，無 Safari 網址列。從 App 點開「驗收」，完成：
   - 按「1. 已連網」，確認顯示線上通過
   - 返回主畫面、開飛航並關閉 Wi-Fi，從主畫面重新啟動 **PR43測試**，按「2. 已關閉網路」
   - 恢復網路，再次重開測試 App，按「3. 恢復網路」，複製完整結果到**私人聊天**
4. 不要把完整 User-Agent、runId 或私人 URL 貼入公開 PR。僅將通過的布林摘要記錄為「使用者回報」，不能宣稱獨立裝置稽核。
5. 不以此測試推論真實帳號或正式 Worker 的資料流完整；產品沒有合併或部署，下一步仍需獨立 review、rollback 與明確 release authorization。

**Important:** #39 `sd-v137` → #43 `sd-v138` 的真實版本更新，已由 **本機 Chromium** 以兩份精確原始 SW 成功驗證，也已測試升級失敗仍保留舊版，以及 sibling cache 不刪除。但這**不能替代真正 iPhone Installed PWA 的舊版→新版更新驗收**；單純新增「PR43測試」主畫面 App 並不等於升級舊 App。若要關閉 iPhone upgrade release gate，需另外取得使用者授權，在隔離 HTTPS Origin 執行舊版→新版的連續部署與實機驗收；不可挪用正式或既有 #39 測試 Origin。

## 不會執行

沒有 `wrangler pages deploy`、GitHub Pages 發布、Cloudflare Worker 寫入、Notion integration、APP_KEY 輸入、真實考試進度匯出、自動 merge 或正式遷移。
