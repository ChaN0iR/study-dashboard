# Study Dashboard｜PWA 隱私＋V2 完整候選（sd-v139）發布門檻

本文件對應 **PR #45**，其 base 是 `main`。目前 **Draft，不是已授權發布**。

## 版本、範圍與證據

| 項目 | 固定／候選 |
| --- | --- |
| 尚未修改的 `main` | `d96c45cc8008e21a1c5ca71e099e84c453586e9f` |
| 既有正式 SW | `sd-v136`，採廣泛 GET 快取，可能持久保存私人回應 |
| 已經使用者在 iPhone 驗收的 #43 | `10c395f57b78fb92248e59bbe2c4edd456e43fca`，`sd-v138`，新安裝合成版 13/13 PASS |
| 新整合候選 | PR #45：`app.js?v=124` + `sd-v139`；`#tasks[data-state-verified]` 防止 silent load 失敗冒充同步成功 |
| 開啟 V2 的方式 | `?ui=v2`，預設畫面仍是原版，不自動儲存偏好 |
| Worker、Notion、D1/DO/Cron | 此候選不修改，不需要在此次前端發布中執行任何後端 migration |

PR #45 已包含 #39、#42 和 #43 整合後的產品內容；**只採用一個主線 PR**。不可另外把 #39/#42/#43 當獨立部署清單再次合併。

## 必要的 release gates

- [ ] **固定 commit / source mapping**：合併前重新取得 `main` HEAD、候選 HEAD、所有 CI 的精確 commit，核對本 repo 的 *GitHub Pages 發布來源確實是 main/docs*；README 只說明預期，不等於 Pages 後台設定已驗證。遇到差異，停止。
- [ ] **零 skipped 的候選 CI**：完整 docs suite、CacheStorage owner／隱私安全、V2 互動與 API 失敗／恢復、離線 PWA、既有桌機/Recall 版面全部在**同一個候選 HEAD** success；任何假綠或 skipped 都擋住。
- [ ] **真實升級路徑**：由目前正式 `sd-v136` 到 `sd-v139` 的受控合成舊→新 SW 測試（失敗升級保留舊 shell；成功升級清除廣泛快取留下的合成私人內容、保留 sibling cache），並證明離線 Shell 和未知 API 拒絕。
- [ ] **獨立 HTTPS staging 驗收**：使用與生產、#39、#43 不同的獨立測試 Origin；測試包僅能有合成資料，SW 必須與實際 PR #45 的 `docs/sw.js` 逐位元一致。核對 200/404、CSP、cache policies、資產版本及 noindex。
- [ ] **iPhone Installed PWA**：從主畫面 standalone 開啟 **PR #45 sd-v139**、離線重開、未知 API 離線失敗、恢復網路；使用者回傳完整 JSON，核對精確版本，不能拿 #43 的 13/13 充當 v139 結果。若要求證明已安裝舊版原位升級，需額外在隔離 Origin 以同一主畫面 App 連續舊版→新版驗收。
- [ ] **人工 review**：至少完成一次獨立 review（目前 PR #43/#45 均無 review 記錄）；特別覆核隱私、失敗時回滾、版號耦合。不得把 AI 本身的自審說成獨立 reviewer。
- [ ] **明確授權**：取得使用者對「要合併哪支 PR、是否允許正式部署」的明確批准前，保持 Draft，不合併／發布／變更正式資料。

## 最小發布序列（以上通過後才適用）

1. 固定 `main` 與候選 SHA，確認上述門檻與所需 review 均已關閉。
2. 核對 **是否存在 main 合併後自動發布 GitHub Pages 的行為**，取得與其相符的發布授權；禁止把「只是 merge」假設成不會改正式站。
3. 只採用 PR #45 單一路徑，不把 #39/#42/#43 重複合入。
4. 發布後執行**唯讀** `scripts/production-smoke.py --release-sha <exact merged SHA> --wait-seconds 240`，檢查正式首頁六項固定資產、現有 Worker `/health`、離線與 cache cleanup。若發現未依該 commit 出版，視為失敗，不以 staging PASS 代替。
5. 監控正式站 SW 更新、離線 UI、無私有資料進 CacheStorage；正式使用者的學習操作需另獲授權才能進行寫入驗證。

## 回滾：只可向前修復，不回退至私人快取不安全的 SW

**切勿直接把 `docs/sw.js` 還原成 main 的 `sd-v136`**，因它會再度廣泛持久快取 GET 回應，並可能無法安全清除舊快取。

如果新 V2 UI 出現問題，優先將新版本中的 `?ui=v2` opt-in 關閉／恢復原有 UI，**保持** #39 之後的 SW 隱私機制、匿名靜態預快取、runtime `cache:no-store`、精確 allowlist 與 sibling cache 保護。用全新且遞增的 SW cache 名稱（例如 `sd-v140`）連同 app asset 版本向前修正，經完整靜態、瀏覽器與 iPhone 必要驗收後，才發布修復版。

如果是 SW 安裝或路由問題，先停止 rollout、保留既有客戶端可用資料；調查 CacheStorage 及 CDN 資產一致性。不要透過清除使用者所有 CacheStorage、解除註冊全部 SW 或刪除 sibling cache 來掩蓋問題。禁止在未獲准時操作真實用戶資料。

## 已知證據邊界

- `production-smoke` 在 PR CI 中檢查**當前正式 main** 的唯讀狀態，不是候選已上線的證據。
- #43 的 STAGING ONLY 已通過 13/13 真實 iPhone 新安裝版，但那是 `sd-v138`，不包含新的背景失敗處理。
- PR #45 的 Chromium 回歸屬於合成網路／模擬資料，不能推論已接通真正正式 Notion、Worker integrations 或公開 iPhone v139 安裝。
- #38 的 Notion 合成筆記／正式 Worker 權限是另一條工作線；不與本前端 V2 gate 混成一個布林 PASS。
