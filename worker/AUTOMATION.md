# 每日整堂任務自動化

既有 `study-dashboard-api` Worker 是唯一擁有者。每天台北 00:10（Cloudflare Cron `10 16 * * *`）經由 `LESSON_AUTOMATION` 綁定，呼叫固定名稱 `study-dashboard-lessons-v1` 的 SQLite Durable Object。不可任意更換這個名稱、binding 或刪除其儲存資料，否則會切斷既有去重紀錄。

## 任務規則不變

每科每天最多建立一項自動整堂任務：選本週或逾期、尚未完成的最早課次，跳過無排定週與未來週。上限是本週日，不是今天；本週內日期在今日之後仍屬已核准的本週課。若同課次已有當日任務，或較早且未完成、未跳過的可補做任務，保留既有任務，不改派下一堂。

新任務包含既有核准欄位，加上 `自動課次任務=true` 與文字欄位 `自動任務鍵`。追蹤鍵格式為 `full-lesson:日期:科目`，只在本自動化建立的任務填入。舊任務不回填、不改寫、不封存。

## 原子保留及恢復

DO 的記憶體 queue 只負責串行處理等待中的請求；跨重啟的安全性來自持久日誌。`slot:日期:科目` 與 `lesson:課次ID` 在同一筆 storage transaction 內原子保留。所有外部 Notion I/O 都在交易之外。

建立流程為 `reserved → sending → created`。`sending` 必須在 Notion POST 之前落盤；每個建立操作只發送一次 POST，包括 429 也不自動重送。失敗或崩潰進入 `uncertain`，並保留跨日課次鎖。

下次同一 Cron 依追蹤鍵核對 Notion：恰有一筆且身分一致時，回收 page ID 並建立持久 task 紀錄；零筆只代表目前不可見，不能證明上次沒有建立，故持續保留而不補建；多筆或身分不符進入 `conflict`，不刪除任務、不更新課次，等待人工檢查。過日但確定尚未送出的 `reserved` 可取消；`sending`/`uncertain` 沒有租約到期自動釋放。

這是自動建立的 at-most-once 發送與保守核對，不是 Notion 的分散式 exactly-once 交易，也不保證未知寫入一定能自動恢復。若故障發生在 `sending` 落盤後、實際 POST 前，也會寧可暫停該課次。使用者在 Notion 同時手動新增或複製任務，不受 DO 的互斥控制。

## 完成同步與日期

只有 durable task 紀錄與 Notion 身分均一致的自動整堂初學任務，才可更新唯一對應課次。單有 checkbox、手動複習、其他資料庫、多課次關聯、跳過或封存的任務均不觸發課次更新。

從儀表板完成時，在任務 PATCH 前持久保存台北日期與 `dashboard` 來源；課次更新失敗、程序重啟或跨日重試，均沿用同一日期。在 Notion 直接勾選時，由每日 Cron 保存第一次觀察到完成的台北日期及 `notion_first_observed` 來源，這不是 Notion 勾選事件的精確日期。不得以 `last_edited_time` 猜測完成日期；其他編輯也會改變該時間。

課次 PATCH 是可重試的冪等寫入，不是 exactly-once。每次重試前重讀課次：若已完成，保留其既有日期；成功記為 `applied` 或保留記為 `preserved` 後，不因後續掃描重寫課次。任務取消完成不會自動撤回課次完成，這不在本規則授權內。

已結案/跳過紀錄不逐筆永久輪詢；每日以最近掃描時間加兩日重疊查詢近期變更，僅作發現變更使用，絕不用來決定完成日期。活躍、未知結果及衝突操作始終核對。若人工編輯的 Notion 查詢索引異常延遲超過重疊視窗，可由維護者查核，而不假裝能保證所有外部事件即時送達。

## 唯讀查核與維護

`GET /api/automation/audit` 使用既有 `x-app-key` 認證，回傳最多 100 筆 slot、`nextCursor`；用 `?cursor=...` 分頁，或 `?taskId=<Notion page UUID>` 取得逐任務紀錄。端點只讀 DO，不會查詢或寫入 Notion，也不會建立每日紀錄。沒有新增公開的執行 Cron／解除鎖／重送建立端點。

日誌保留追蹤鍵、課次與任務 ID、狀態、時間、建立嘗試次數、回應狀態或未知結果、延遲、核對次數、完成日期來源與階段。每筆保留最近 100 個事件及總事件數；主要狀態、身分、日期與錯誤欄位不因歷史裁剪而消失。不記錄 APP_KEY、Notion token 或請求認證 headers。

遇 `uncertain`／`conflict`：先讀 slot 與 task 紀錄，再於 Notion 查同追蹤鍵及 canonical page；不可僅因查不到結果就清除鎖、刪掉日誌或手動重發 POST。若需解除 hold，必須由維護者提出具體核對結果與修正，不透過自動重試猜測。現有程式沒有自動破壞式清理或解鎖操作。

部署前跑 `npm test` 及 `wrangler deploy --dry-run`，完成獨立審查後才恢復 Cron。新建 DO namespace 透過 `lesson-automation-v1` SQLite migration，保留既有 Worker secrets 與 origin。正式驗證使用 Cloudflare 設定、部署資訊與唯讀 audit，禁止以 live `/api/state` 或 `/health` 驗證。
