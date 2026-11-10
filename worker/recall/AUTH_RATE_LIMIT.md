# 回想室登入與註冊限流

預設沿用現有記憶體限流。將 `AUTH_RATE_LIMIT_ENABLED` 設為字串 `true` 後，登入與註冊跨執行個體共用 D1 計數。每個來源 IP 在一小時內可嘗試十二次，第十三次回傳 429。D1 只存以密鑰產生的 IP 摘要。帳號註冊方式不變。

正式啟用前，先在隔離 D1 驗證 `0002_auth_attempt_windows.sql`，再依另行授權的流程準備正式資料庫及 `AUTH_RATE_LIMIT_KEY`。啟用時若缺少密鑰、資料表或 D1 連線，登入和註冊會回傳 503。停用旗標可回到原有限流，新增的資料表可以保留。

## 正式發布與核對

正式 Worker 已啟用共用限流。後續部署請使用 `wrangler deploy --keep-vars` 保留控制台設定，並核對承接流量的新版本仍有 `AUTH_RATE_LIMIT_ENABLED=true` 與加密的 `AUTH_RATE_LIMIT_KEY`。D1 已有符合定義的限流表和索引，遇到新環境才依核准流程檢查遷移需求。

發布後用少量無效資料確認登入回傳 `INVALID_CREDENTIALS`，註冊回傳 `INVALID_EMAIL`。請求會計入來源 IP 的限流額度。第 13 次拒絕與並行行為在隔離 D1 驗證。若出現 `AUTH_STORAGE_ERROR`，先核對版本、旗標、密鑰綁定和表結構，再依核准的回復程序處理。
