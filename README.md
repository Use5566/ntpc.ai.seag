# NTPC AI SEAG-逐字稿整理工具

前台：https://use5566.github.io/ntpc.ai.seag/
API：https://ntpc-ai-seag.onrender.com

## 流程
1. 匯入逐字稿，選填日期、資料類型、主題及背景。
2. 同意傳送尚未去識別的內容，輸入工具存取碼，開始 AI 整理。
3. AI 同時產生正文、metadata、捨棄清單、待確認問題、去識別建議及來源去向。使用者決定遮蔽或保留、回答問題、手動修改或交給 AI 修訂。
4. 所有項目確認後匯出 TXT。尚不寫入 Firebase 或向量化。

模型固定為 gemini-3.5-flash-lite。

## Render 部署
- Web Service；Node 22 以上；main 分支；Root Directory 留空。
- Build Command：`npm install`。
- Start Command：`node server.mjs`。
- Health Check Path：`/health`。
- 必填環境變數：`GEMINI_API_KEY`、`SEAG_ACCESS_TOKEN`（32–256 字元，獨立隨機值，不可與 Gemini Key 相同）。
- 可選：`ALLOWED_ORIGIN=https://use5566.github.io`（不含路徑）。
- 可選：`MAX_REQUESTS_PER_HOUR=20`、`MAX_REQUESTS_PER_DAY=100`。
- 保持單一實例。程序限額在重啟後歸零，不是帳務硬上限。

真實憑證只填入 Render 環境變數，不放入程式碼、TXT 或 GitHub。api-config.js 只含公開網址，變更網域時需同步 HTML CSP。

## 提示詞與開發
模型指令全部放在獨立 TXT：prompt-system.txt、prompt-analyze.txt、prompt-revise.txt、prompt-output-schema.txt。後端讀取自己的部署版本，不接受前台指定模型或系統指令。修改 schema 時同步 core.js。

- `npm run dev`：本機前台預覽，127.0.0.1:4173。
- `npm start`：API 伺服器，需要環境變數。
- `npm test`：虛構資料及模擬上游測試，不需要真實金鑰。

安全設計與限制詳見 SECURITY.md。共享存取碼只適合封閉測試；正式多人服務應使用個別帳號及持久化限額。AI 的去識別及語意正確性仍需人工核對。
