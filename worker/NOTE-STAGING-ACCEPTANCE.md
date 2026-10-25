# PR #38：非正式 Notion 驗收

此工具直接載入候選 `worker/index.js`，只在獨立 Node 程序暫時改用指定的測試 notes database；不改 repo 設定、不啟動或部署 Cloudflare Worker，不執行 Cron、D1 或 DO。

## 目前證據與限制

離線測試驗證防護及呼叫順序。真實 Notion `POST /pages` 同時帶 children / image.file_upload 的相容性，仍須在隔離資料庫驗收；mock 成功不能取代此步。

尚未取得明確隔離、且預定 Worker integration 可存取的測試 database；因此目前只可執行 plan 與離線測試。本工具不自行搜尋、新建、複製、重新命名或分享 Notion 資料庫，也不讀取正式筆記或自動載入 `.dev.vars`。

## 先完成目的地準備

1. 由擁有者建立空白、可丟棄且明確與正式筆記分離的測試 database，名稱必須完全為 `Study Dashboard STAGING ONLY`。不可將正式資料庫改名來通過檢查。
2. 分享給預定驗收的 integration，確認這就是要核對的 Worker integration。token 由操作者安全提供，禁止貼到聊天、PR、命令列參數或提交到 repo。
3. database 需有 `標題` title、`日期` date、`複習狀態` select，且既有 select 選項含 `未複習`。工具不會修改 schema，也不帶正式課程 relation。
4. 記錄 repo commit、測試 database ID、integration 身分及「只准寫合成測試筆記」的授權。標題標記與已知正式 ID 拒絕清單是防誤操作檢查，無法證明未知資料庫必然非正式；操作者仍須確認隔離。

## 執行

使用 Node 24，在 repo 根目錄：

```sh
node worker/note-staging-acceptance.mjs
node --test worker/note-staging-acceptance.test.mjs
```

第一個命令預設只列計畫，忽略環境中的 token，不進行網路呼叫。CI 只執行第二個命令的攔截式測試，無 secrets。

取得上述隔離目的地與寫入授權後，操作者在本機安全設定以下環境變數，再手動執行 `node worker/note-staging-acceptance.mjs --live`：

- `NOTION_STAGING_DATABASE_ID`：測試 database UUID；repo 所有已知正式 DB ID（含大小寫／連字號變形）都拒絕。
- `NOTION_STAGING_TOKEN`：明確提供的 integration token；工具不讀正式 Worker secrets。
- `NOTION_STAGING_CONFIRM`：`WRITE SYNTHETIC NOTE TO ` 加上小寫、去連字號的測試 database ID。

此命令只對固定 `https://api.notion.com/v1` 呼叫，禁止 redirect，每次 15 秒逾時，無 retry：先讀 database identity/title/schema，再上傳兩張合成 1px PNG，以候選 Worker 建立唯一 `[STAGING ACCEPTANCE]` 筆記，最後只讀回該筆記的 blocks。成功要求段落／圖片／段落／圖片與頁次標籤符合預期。

## 結果與不明提交

保存 commit、執行時間及工具輸出的去敏 JSON。成功包含 pageId、2 張圖片、7 次 API 呼叫；不輸出 token、筆記內容或 signed image URL。這不是部署驗收，也不解除 #39 的 iPhone 實機門檻。

- 上傳失敗：不應嘗試建頁；暫存 upload 可能等待 Notion 到期。
- `page-create-unknown` 或 `pageCreateAttempted: true`：不要自動重跑。請擁有者只在隔離 database 核對是否已有合成頁面；若回應未含 pageId，提交狀態仍未知。
- readback 失敗：輸出已知 pageId，保留測試頁供檢查。
- 工具不做 PATCH、DELETE、archive 或自動 cleanup。確認結果後，由擁有者手動處理該合成頁；程式回滾不代表 Notion 資料回復。

## 完成清單

- [ ] 明確隔離目的地、integration 存取與寫入授權已記錄。
- [ ] 指定 head 的 Worker offline CI 成功，無跳過。
- [ ] 真實模式成功，讀回兩頁圖文順序正確，保留去敏證據。
- [ ] 擁有者核對合成筆記，手動決定清理。
- [ ] 另行取得合併／部署授權；此工具不會合併或部署。
