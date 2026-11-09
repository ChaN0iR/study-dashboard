# 人工驗收：只留下你必須確認的兩件事

此清單基於 #38 `127f779677f7fe21dc24939cc4a4c0609537e30b`、#39 `bd9fe2107998d693a87578906962a520327fa85e`、main `d96c45cc8008e21a1c5ca71e099e84c453586e9f`。候選改變必須重新核對。清單、結果 PASS、圖片確認均不是合併或部署授權。

## 1. #38：看一次現有合成筆記

不用再上傳、建頁、執行 live 或清理。於你先前建立的 STAGING ONLY 測試庫打開既有 `[STAGING ACCEPTANCE]` 筆記：

- 順序是「第 1 頁 → 圖片 → 第 2 頁 → 圖片」。
- 點開兩個圖片 block，確認皆能載入，沒有破圖或讀取錯誤。圖片只有 1px，無法用它驗證真實照片畫質、方向或細節。

只需回覆：`#38：順序正確，兩張皆可載入；先保留測試頁。`
若任何一項不符，回覆哪張失敗即可；不重跑建頁、不自行刪除。不得代替擁有者填「已確認」。私有頁網址／ID 不必貼到公開 PR。

2026-10-26 最新 PR body 已記錄獨立測試 Integration 的一次兩頁兩圖 live PASS。舊 NOTE-STAGING-ACCEPTANCE.md 中「尚無測試庫」是歷史狀態；不代表正式 Worker Integration 已驗證。單圖、純文字及第二張上傳失敗的額外 live 情境未由該次成功路徑證明。

## 2. #39：三個按鈕，貼一次結果

只用測試站：https://study-dashboard-pr39-staging-only.pages.dev/acceptance/check

1. 連網時按「1. 準備」→「2. 升級」，等線上通過。
2. 開飛航模式，另確認 Wi-Fi 已關；保留本頁，不關閉或重新整理。按「3. 已關閉網路」。
3. 恢復網路，長按複製頁底整份結果貼回聊天；若失敗也貼原結果，不必自己分析或重試。

不輸入帳密、token 或私人筆記，不進正式站。這只操作測試 origin 的合成 cache。

**安裝版證據另記一句：** `執行位置：主畫面測試 App／Safari 分頁；iOS：____`。不要為了填主畫面而猜測：若測試 App 沒有可進入驗收頁的入口，就在 Safari 完成合成測試並如實回報，安裝版 gate 保留。v1 頁沒有記錄 standalone display mode；JSON PASS 本身不能證明 Installed PWA。

## 結果由程式判讀

你只需貼結果；維護者可在本機使用：

```sh
node scripts/check-manual-acceptance.mjs result.json
# 或不存檔，從 stdin 貼入原始 JSON
node scripts/check-manual-acceptance.mjs
```

檢查器離線執行，核對固定候選、九個嚴格布林 checks、完成狀態、runId、時間與 iPhone UA；不列印原始未知欄位。它只判斷回報是否完整一致，不獨立證明瀏覽器真實執行、Installed PWA 或正式站驗收，也不寫入資料。

## 其餘交給維護者，不要求你判讀

- 指定 head 的 CI、review、main 與組合測試；無 review 不視為已批准。
- 正式 Worker Integration 的身份與目的地授權；connector 看得到不等於 Worker 有權限。
- Cloudflare 實際 deployment/version、bindings、Cron、回復目標的唯讀快照。repo 預期：`study-dashboard-api`；`LESSON_AUTOMATION` / `LessonAutomationCoordinator`；D1 `DB` / `recall-room-accounts`；Cron `10 16 * * *`（台北 00:10）；ALLOWED_ORIGIN `https://chan0ir.github.io`；NOTION_TOKEN 與 APP_KEY 只核對存在，禁止輸出值。
- 無控制面存取時明確留未驗證，不將 repo 設定勾成正式通過。
- #38 建頁結果不明先人工對帳；code rollback 不復原 Notion 資料。#39 以新 cache 版號前進修復，不恢復舊私人快取 handler。

本次簡化不改候選 runtime、不改測試站、不合併、不部署、不清理或寫入正式資料。
