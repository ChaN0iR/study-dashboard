# PR #29 測試證據（本機）

以下檔案來自隔離 clone 的 PR 分支 `feature/desktop-cards-exclusive`，修正測試的程式碼 commit 為 `58722448e6007308e5e97caa9efee6dfeff5bbdc`。這些是本機執行結果，不是 GitHub Actions 或其他 GitHub CI 結果；該 commit 當時沒有 GitHub check runs 或 status contexts。

## 證據檔案

- `desktop-cards.tap.txt`：`node --test docs/desktop-cards.test.mjs` 的完整 TAP 輸出，3 PASS／0 FAIL／0 SKIP。
- `browser-results.json`：瀏覽器測試的去敏結果，27 筆紀錄；mobile 視覺比較 18 筆，涵蓋 6 個 viewport/theme 組合 × 3 個 tabs。數量由實際收集的結果計算；測試另核對完整 18 組的唯一組合。
- `all-docs-serial.tap.txt`：`node --test --test-concurrency=1 docs/*.test.mjs` 的完整 TAP 輸出，119 tests：118 PASS／1 FAIL／0 SKIP。
- `base-rest-day-policy.tap.txt`：在乾淨 `main` base `ec6ed83f96e4210c1ee4c611950e43651342f069` 的 `docs/rest-day-policy.test.mjs` 完整輸出，10 tests：9 PASS／1 FAIL／0 SKIP。失敗同為 `TypeError: context.widgetTaskModel is not a function`，與 PR 的桌面卡片變更無關；該失敗在 PR 分支全套輸出中也獨立出現。

## 執行環境與限制

- Node.js `v24.19.0`、Google Chrome for Testing `151.0.7922.34`、Python `3.12.3`、Playwright for Python 與 Pillow `12.3.0`。
- 瀏覽器測試使用 localhost 與合成測試資料；API 失敗情境由本機 mock 攔截，沒有呼叫 Worker 或正式服務。
- Worker 專屬測試未執行（SKIP；本 PR 沒有 Worker/API 變更）。真實手機、已安裝 PWA、正式網站及部署後的人工驗收未驗證；本 PR 未部署。
