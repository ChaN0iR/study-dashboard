# 部署與維運手冊

本文件依儲存庫程式與官方文件整理；未驗證線上部署、帳號方案、備份可用性或正式資料狀態。下列發布、migration、secret 與 restore 指令供維護者另行授權後執行，本次 PR 不執行。

## 架構與設定清單

- GitHub Pages 發布 `docs/`，無前端建置。建議來源為 `main /docs`，實際 Pages 設定須於 Settings > Pages 查核。推送發布來源可能自動發布，審查分支不可設為正式來源。
- `worker/index.js` 是 Wrangler entrypoint；`/recall/` 由編入 Worker 的資產提供，不靠 Pages cookie。
- 儀表板以 `x-app-key` 呼叫 Worker，Worker 使用 `NOTION_TOKEN` 與 Notion-Version `2022-06-28`。`worker/config.js` 定義 tasks、records、lessons、notes、focus 資料庫及精確欄名；確認 integration 已連接這五個資料庫及所需權限。
- 回想室使用 D1 binding `DB`（users、sessions、user_progress），cookie `rr_session`；與儀表板 APP_KEY 是兩種獨立認證。評分需登入，且另需 `GEMINI_API_KEY`。模型名稱以 `recall/worker.js` 為準，未確認供應商可用性。
- Durable Object binding `LESSON_AUTOMATION`、class `LessonAutomationCoordinator`、SQLite migration `lesson-automation-v1`。固定物件名稱 `study-dashboard-lessons-v1` 儲存自動任務日誌、去重及重排狀態。不可任意改名或刪除 namespace。
- Cron `10 16 * * *` 是 UTC 16:10，即次日台北 00:10。**目前設定有啟用 Cron**，部署就可能啟用寫入，不能將部署視為唯讀操作。
- `wrangler.toml` 已含正式 D1 ID。建立測試環境必須複製設定至另檔、換用獨立 Worker 名稱、D1、DO namespace 與測試 Notion 資料庫；刪除測試設定的 triggers。Notion IDs 是程式常數，單換 token 不足以保證隔離。

## 建置與發布（維護者執行）

1. 記錄已核可 Git SHA、現行 Worker deployment/version、Pages 發布 SHA、bindings、migration 及 Cron。先完成下方備份與隔離環境演練。
2. 在 `worker/` 執行 `npm ci`、`npm test`；根目錄執行 `node --test docs/*.test.mjs`。若修改回想室資產，執行 `npm run build:recall` 並檢查生成檔及 Pages 副本差異。
3. `npx wrangler deploy --dry-run` 僅驗證打包，不證明 D1、Notion 欄位、secret、線上權限或 Cron 正確。勿用 `npm run deploy` 代替 dry-run。
4. 使用經核對的設定與帳號，在測試環境建立 D1，將回傳 ID 填入設定；於 `worker/` 執行 `npx wrangler d1 migrations apply <TEST_DATABASE> --remote --config <TEST_CONFIG>`，migration 來源為儲存庫的 `worker/recall/migrations`（相對 `worker/` 為 `recall/migrations`）。本機可用同指令的 `--local`；這不會套用正式 schema。現有儲存庫只有正向 migration，沒有 down migration；程式回滾不會撤銷 schema。失敗時先停寫與核對實際狀態，由維護者審查向前修復或 Time Travel 復原方案，不可直接重跑或假設無資料損失。
5. 透過 `npx wrangler secret put <NAME> --config <CONFIG>` 分別輸入 `NOTION_TOKEN`、`APP_KEY`、需要時的 `GEMINI_API_KEY`。不要將值放進 URL、程式碼、Git、日誌或截圖。APP_KEY 會交付使用者瀏覽器，不能當作多使用者權限分級。
6. `ALLOWED_ORIGIN` 必須是 Pages origin（不含 `/study-dashboard/`）；`docs/config.js` 的 `API_BASE` 設為核可 Worker URL。亦可使用既有 `?api=` 設定流程。CORS 控制瀏覽器讀取，不取代 APP_KEY；現行預檢固定回傳設定 origin，並非拒絕所有非允許 Origin 的 HTTP 請求。
7. 核可後才執行 `npx wrangler deploy --config <CONFIG>`；保留既有 DO migration tag/binding。正式 D1 migration 必須獨立審查及備份，不要重新套用不相容 schema。現有程式沒有全域維護模式，維護時需另由平台停用 Cron/限制寫入流量。
8. Pages 設定 Deploy from a branch > main > /docs > Save。發布前核對即將推送內容、API URL 與 cache；觀察 GitHub Pages build/deployment 成功後，使用 demo 模式驗證靜態 UI。這些步驟不是本 PR 已執行的結果。

## 驗證與故障處理

- 正式驗證遵循 `worker/AUTOMATION.md`：查平台部署資訊及帶 APP_KEY 的唯讀 `GET /api/automation/audit`，不使用 live `/api/state` 或 `/health` 作驗證。audit 需保護輸出，包含任務 ID 與日誌；以 nextCursor 分頁或 taskId 查詢，不會呼叫 Notion。
- 隔離環境測試：錯誤/缺 APP_KEY 回 401；缺設定回泛化 5xx；無 cookie 的 progress/grade 回 401（未配置 DB 為 503）；auth 與 progress 寫入缺/錯 Origin 回 403；以測試帳號驗證登入、登出、cookie 與進度。評分功能測試可能產生供應商費用，先用 mock。
- PR-01 引入 dashboard 12,000,000 bytes 上限（含照片 JSON），auth login/register 8,000、progress 400,000、grade 650,000 bytes；超量回 413。照片批次過大需減少圖片/拆批，不能依賴 Content-Length 繞過限制。
- 一般 API 5xx 不再公開內部訊息；從平台受控日誌與 deployment 資訊追查，勿將 token、cookie 或完整答案記到日誌。503 檢查 bindings；502 檢查上游權限、schema 與可用性。401 先確認使用哪一種認證，勿放寬保護。
- `uncertain`/`conflict` 先核對 audit、Notion 追蹤鍵與 canonical page，依 AUTOMATION.md/RESCHEDULE.md 處理；不可清空 DO、重發建立或猜測解鎖。

## 備份與復原

每次發布前保存 code SHA、設定（不含秘密）、Pages/Worker 版本及 schema，指定維護者、加密備份位置與保留期限。以下沒有自動備份排程；RPO/RTO 尚未量測，必須完成隔離演練才可承諾。

- D1：維護者執行 `npx wrangler d1 export <DATABASE> --remote --output <BACKUP.sql> --config <CONFIG>`。匯出期間會阻塞其他資料庫請求，應安排低流量或維護窗口並通知使用者。資料含帳號雜湊、session、學習內容，限制存取。先將 SQL 匯入全新隔離資料庫：`npx wrangler d1 execute <RESTORE_TEST_DATABASE> --remote --file <BACKUP.sql> --config <TEST_CONFIG>`，核對三表筆數、關聯及測試登入/進度，不要直接覆寫正式庫。
- D1 Time Travel：先以 `npx wrangler d1 time-travel info <DATABASE> --config <CONFIG>` 確認可用 bookmark/時間窗；復原前停寫、保存目前匯出及復原前 bookmark，再由維護者依選定 bookmark 執行 `npx wrangler d1 time-travel restore <DATABASE> --bookmark=<BOOKMARK> --config <CONFIG>`。**這是破壞性操作，會原地覆寫資料庫並取消進行中的查詢與交易。**保存指令回傳可撤銷這次復原的 bookmark；任何 undo 也是另一次需核准的原地復原，不能假設會合併復原後的新寫入。截至 2026-10-19 官方窗口為 Workers Paid 30 天、Free 7 天；執行前仍須核對實際方案與 bookmark 有效性。復原可使已登出 session 重新有效，需評估 session 撤銷；程式沒有管理員全域撤銷端點。
- DO：保存完整分頁 audit 可協助核對，但 **不是可匯入備份**。SQLite DO 提供 PITR API；本 repo 沒有暴露 bookmark/export/restore 管理工具，不能宣稱已可一鍵復原。需維護者先設計受控管理程序、取得 bookmark、在隔離環境依官方 API 演練，禁止新增公開 restore 端點。
- Notion：另行保存資料庫匯出、欄位型別、relations、頁面/附件及追蹤鍵對照。Notion 匯出不是此程式的自動可逆備份；重新匯入可能改變 page ID/relations。復原後須逐項核對 config IDs、欄名、DO canonical identity，不能直接恢復 Cron。
- D1、DO、Notion 沒有跨系統交易或同一還原點保證。復原其中之一可能重建重複任務或遺失完成同步狀態。停寫後對照 audit、Notion page ID 與 tracking keys，先解決 uncertain/conflict，再核可恢復寫入及 Cron。

## 回滾

保留上一個 Worker 版本，維護者依 Cloudflare 部署管理 rollback 至已驗證版本；先確認它相容現行 D1 schema、DO migration 與日誌。程式回滾不回滾資料，不刪 migration、不重建 namespace。Pages 以審查過的 revert 恢復前版資產後再發布，核對 service worker cache (`docs/sw.js`) 與瀏覽器實際載入版本。若只有前端問題，保持後端資料不動；資料問題依上述復原程序處理。完成後用平台 metadata、唯讀 audit 與隔離測試驗證，記錄觀察結果與未解風險。

維護者另行核准回滾後，於 `worker/` 先以 `npx wrangler deployments list --config <CONFIG>` 核對目標 Worker、現行 deployment 與版本 ID，再執行 `npx wrangler rollback <VERSION_ID> --config <CONFIG>`。不得混淆 deployment ID 與 version ID。回滾前先評估並依核准維護程序停用 Cron 與限制寫入，核對平台實際狀態；不要假設換回舊版會關閉排程。若 Cron 仍啟用，舊版程式仍可能寫 Notion/DO。官方限制指出兩版本間發生 DO class lifecycle/migration 變更時不能直接 rollback；遇到限制須停止並審查相容的向前修復，不可刪除 DO 資源繞過保護。本次只補文件，未執行上述指令。

## 官方參考（執行前再次核對）

- [GitHub Pages 發布來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [D1 匯入匯出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [SQLite DO storage / PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Worker rollback 與 DO 限制](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
