# Study Dashboard 發布與維運

## 正式發布路徑

- 前端由 GitHub Pages 從 `main` 的 `docs/` 建置。合併至 `main` 會觸發 Pages，發布前須核對合併範圍與目標。從 Actions 確認部署對應的 commit、`./docs` 建置來源、正式網址與結果。
- 後端是 Cloudflare Worker `study-dashboard-api`，由 `worker/` 打包。先查目前承接流量的 Worker 版本，記下完整 version ID 與流量比例。核對 `DB`、`LESSON_AUTOMATION`、`ALLOWED_ORIGIN`、密鑰名稱及實際 Cron。設定檔中的 `10 16 * * *` 是 UTC 16:10（台北次日 00:10），以控制台確認實際排程。
- 正式回想室已啟用跨執行個體限流。發布前核對 `AUTH_RATE_LIMIT_ENABLED=true`、加密的 `AUTH_RATE_LIMIT_KEY` 與 D1 限流表。使用 `wrangler deploy --keep-vars` 保留控制台變數，並在發布後核對新版本仍帶有限流旗標。詳見[登入與註冊限流](worker/recall/AUTH_RATE_LIMIT.md)。
- AI 批改目前採預設停用。即使 `GEMINI_API_KEY` 已設定，Worker 仍須有 `AI_GRADING_ENABLED=true` 才能批改。啟用前另行取得授權並完成全站與帳號用量上限。保留既有密鑰，驗證時只查名稱及綁定狀態。

[GitHub Pages 發布來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) · [Worker 版本與部署](https://developers.cloudflare.com/workers/versions-and-deployments/)

## 發布前驗證

1. 固定待測 commit，檢查與現行正式版本的差異，記錄 Pages 與 Worker 各自的回復基準。
2. 在 `worker/` 使用 `npm ci`、`npm test`、`npm audit` 和 `npx wrangler deploy --dry-run`。前端依 GitHub Actions 使用 Chromium 跑完整測試。核對 CI 的實際 commit、結果與跳過項目。
3. 回想室 HTML 有 Worker 與 Pages 兩個入口。修改後用 `npm run build:recall` 重新產生 Worker 資產並核對兩個入口。筆記上傳使用 [隔離 Notion 驗收](worker/NOTE-STAGING-ACCEPTANCE.md)。
4. 若有排程或資料結構變更，另行核對 [自動化維運](worker/AUTOMATION.md) 與 [重排處理](worker/RESCHEDULE.md)。測試環境需分開配置 Worker、D1、DO 與 Notion 測試庫，並關閉測試 Cron。單換 token 無法隔離程式中固定的資料庫 ID。

## 發布後確認

- Pages 完成後核對線上首頁、Service Worker 與變更資產，並檢查 `scripts/production-smoke.py --release-sha <MERGED_SHA> --wait-seconds 240` 的結果。新安裝、離線重開與既有安裝原地升級分開記錄。
- Worker 發布後確認新版本的流量、綁定與排程。健康端點只驗證 Worker 可回應，筆記寫入與 Cron 行為各自需要對應的驗收證據。
- 記錄正式版本、驗證結果及任何待辦。正式資料的測試寫入與遷移分開審查。

## 回復

- 前端若需修正離線快取，保留匿名靜態預快取、私人回應不持久保存與其他 PWA 快取隔離。使用遞增的快取版本向前修復，並驗證舊快取清理和離線重開。
- Worker 回復前核對相容的版本 ID、D1 schema、DO migration、Cron 與 AI 批改政策。先前版本可能重新啟用目前已停用的行為。確認目標後，依 Cloudflare 的版本回復流程處理；回復程式版本不會還原 D1、DO 或 Notion 的資料。
- D1、DO、Notion 的復原需要分開演練。正式復原前先保存現況、確認復原點及寫入暫停方式。DO audit 用於對帳，無法作為可匯入備份；Notion 重新匯入可能改變頁面 ID 和關聯。備份時間點及可復原範圍以實際演練為準。

[Cloudflare Worker 回復](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) · [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
