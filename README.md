# NTPC AI SEAG-逐字稿整理工具

前台：https://use5566.github.io/ntpc.ai.seag/
API：https://ntpc-ai-seag.onrender.com

## 流程
1. 匯入逐字稿，選填日期、資料類型、主題及背景。
2. 同意傳送尚未去識別的內容，輸入工具存取碼，開始 AI 整理。
3. AI 同時產生正文、metadata、捨棄清單、待確認問題、去識別建議及來源去向。使用者決定遮蔽或保留、回答問題、手動修改或交給 AI 修訂。
4. 所有項目確認後按「確認送出並儲存」，TXT 存入指定共用雲端硬碟，紀錄寫入 Google 試算表。另可下載 TXT 備份。正式稿同時寫入 Firestore；向量化由管理者另行手動啟動。

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

## Google 儲存（0.4.0）
- Render Secret Files：`google-service-account.json`；環境變數 `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/google-service-account.json`。
- Google Cloud 啟用 Drive API、Sheets API。服務帳戶只取得指定資料夾與試算表的寫入權限；不需要專案 Editor，也不使用網域委派。
- 目的地固定於後端 storage.mjs，不能由前台指定：資料夾 `1_JvYzPgw25KdYCP0fT_ajpm4sdBwHZJe`；試算表 `1lvZLaRW6ULLGXASGBhvIoOOEPsk3nq6iiK0sxUnl77o` 的 gid 0。
- 首次設定：在 Render Shell 執行 `node --input-type=module -e 'import {createStorage} from "./storage.mjs";console.log(await createStorage().initialize());'`。只在空白工作表建立欄位；既有欄位不符時拒絕改寫。
- 21 個紀錄欄位及欄位說明見 storage.mjs 的 COLUMNS；標題列附有說明註記。
- 檔名：`活動日期YYYYMMDD_中性標題_內容SHA256前12碼.txt`。日期不明用 `日期未確認`，標題最多 50 字元；檔案 UTF-8 含 BOM。
- POST `/api/archive`：只接受 `{title,body,metadata,sourceCount,confirmed:true}`；沿用 Origin 與工具存取碼驗證。無法指定 Google 憑證、目的地、模型或檔案 ID。
- 不儲存原始逐字稿、完整捨棄文字、問答歷程、單位／參與者角色欄位、使用者姓名、email、IP、原始檔名或金鑰。
- 相同內容的正式稿對應相同完整指紋；時間不參與內容去重。修改正文／metadata／來源段落數會建立新版本紀錄。預設不覆寫先前版本。
- 先登記「處理中」並保留 Drive 檔案 ID，再上傳 TXT、核對 checksum、更新為「已儲存」。0.5.0 起須完成 TXT、Firestore 與試算表才回報成功。中斷時保留紀錄，重送會恢復；不自動刪除資料。
- 必須保持單一 Render 實例，不可部署多個寫入者到同一張表；試算表沒有跨程序交易鎖。超大量紀錄應遷移到具唯一約束與交易的資料庫。
- 「僅下載 TXT 備份」不會呼叫儲存 API。分享範圍繼承 Google 原有權限；程式不建立公開分享。
- 系統驗收資料使用 `createStorage().save(data,{systemTest:true})` 標記為「系統測試」；此選項不接受前台傳入。

## Firestore（0.5.0）
- 固定專案 ntpc-ai-seag、資料庫 (default)。沿用 Render 的 google-service-account.json；服務帳戶需在此專案具有 roles/datastore.user。
- 後端 OAuth 增加 datastore scope。前台不直連資料庫、不接收憑證、不提供任意集合或查詢端點。
- documents/{SEAG-完整指紋}：schemaVersion、recordId、contentSha256、title、body、metadata、sourceCount、format、driveFileId、createdAt、toolVersion、humanConfirmed、recordType。
- ingestionJobs/{相同編號}：schemaVersion、documentId、contentSha256、status、attempts、createdAt、updatedAt。初始狀態 awaiting_vectorization；目前沒有背景向量工作者，不會自動呼叫 Embedding API。
- 以 Firestore atomic commit 同時建立正式稿及工作紀錄，使用 exists:false 防止覆寫。重送核對內容與工作紀錄，不重設已完成的向量處理進度。
- Google Drive、Sheets、Firestore 並非跨服務交易。TXT 先保存，Firestore 完成後才將試算表標記已儲存；失敗標記待重試，可由相同內容重送恢復。
- 0.4.0 舊紀錄不會自動回填；重送相同正式稿可以補建 Firestore 資料。舊版已儲存狀態只代表 Drive 與 Sheets。
- 系統測試使用 systemChecks、systemCheckJobs，狀態 excluded_system_test；不得用於知識檢索。此模式只能由伺服器依既有紀錄類型判定，前台無法指定。
- firestore.rules 是用戶端拒絕所有讀寫的規則範本；後端權限仍由 IAM 管理。規則檔存在不等於已部署，正式環境需確認為正式版模式。

## 手動向量化（0.6.0）
- 管理頁：admin.html。Render 設定 SEAG_ADMIN_TOKEN（32–256 字元，與 Gemini Key、SEAG_ACCESS_TOKEN 不同）。沒有管理碼或碼值重複時管理端點停用，投稿整理仍可使用。
- 管理碼只在分頁輸入欄位／請求期間使用，不存 localStorage、sessionStorage 或 cookie；提供清除按鈕，離頁清除。
- POST /api/vector/list、/api/vector/preview 為查詢，不啟動模型；POST /api/vector/run 需 documentId、planHash、confirmed:true。
- 沒有排程、背景工作者或啟動觸發。每次明確按下開始只處理一份稿件最多 3 段；剩餘段落必須手動再次確認。
- Unicode 每段最多 1800 個 code point、相鄰重疊 150 個；優先在句末或換行切分，保留 start/end 位置與完整文字，不讓 AI 重新摘要。
- 模型 gemini-embedding-2、1536 維；獨立 TXT 範本 prompt-embedding-document.txt。將模型、維度、分段規則、範本內容納入設定指紋，變更後拒絕與既有進度混用。
- chunks/{稿件ID_設定指紋前16碼_段序} 保存正文片段、位置、來源ID、模型、設定指紋及 Firestore 原生 vector 欄位 embedding。
- ingestionJobs 保存 completedChunks、totalChunks、embeddingRequests、configHash、leaseOwner、leaseUntil。Firestore updateTime 條件防止同時取得工作，租期五分鐘，程序中斷後可由管理者手動重試。
- 每段向量與進度同次原子提交；提交回覆遺失時讀回進度，已存妥的段落不重做。若模型回覆在入庫前中斷，重試可能再次計費。embeddingRequests 是請求嘗試數，不是 Google 帳務用量。
- 管理查詢每小時最多 120 次；執行沿用服務每小時／每日上限。這些程序計數在重啟後重設，不是帳務硬上限。
- 系統驗收可在伺服器建立 createVectorizer({... ,testOnly:true})，固定使用 systemChecks/systemCheckJobs/systemCheckChunks；HTTP 不接受 testOnly 或自訂集合。
- 本版完成向量產生與儲存，尚未提供語意查詢、向量索引部署或問答。後續檢索必須只選 knowledge、相同設定版本且 job 狀態 ready 的資料。

## v0.7.0：同頁整合與知識問答
首頁以 #import、#vector、#chat 切換匯入、手動向量化、知識問答，切換不清除稿件。舊 admin.html 導向 #vector。
問答 POST /api/chat 使用 SEAG_ACCESS_TOKEN；向量管理仍使用 SEAG_ADMIN_TOKEN。無需新增環境變數。問題最多 2000 字元，歷史最多 6 則，僅記憶體保存。
檢索只使用 humanConfirmed、knowledge、工作 ready 且模型設定相同的段落，核對正文指紋及段落位置。問題使用 Gemini Embedding 2，回答使用 Gemini 3.5 Flash-Lite；來源可展開核對。查詢不寫入資料庫，也不觸發稿件向量化。
0.7.0 舊版限制（0.8.0 已移除）：後端讀取 chunks，計算正規化向量餘弦相似度，選前 5 段。總段落上限 500（含尚未完成工作已產生的段落），超過明確拒絕，不會只查部分資料。每次問題會產生 Firestore 讀取與模型用量；擴大前需升級 Firestore 原生向量索引檢索。
問答指令：prompt-chat.txt；查詢向量範本：prompt-embedding-query.txt。所有來源與歷史視為不可信資料，來源編號由後端核對；引用存在不等於語意必然正確，使用者仍應核對。


## v0.8.0：Firestore 原生向量搜尋
問答使用 documents:runQuery 的 findNearest，COSINE、1536 維、取最相關 5 段；前置篩選 recordType、configHash、searchReady。沒有 500 段總量上限，也不回退全量掃描。問題向量仍需一次 Embedding 請求；無結果不呼叫回答模型。
分批向量化先寫 searchReady=false；全稿完成後以原子提交開放所有段落及 job.searchPublished。若登錄中斷，可在管理頁預覽後按「完成搜尋登錄」，不重做向量。既有 ready 稿件可以透過 createVectorizer().publishExisting({documentId}) 補登；不需重新產生向量。這個方法不接受前台任意呼叫。
部署前以有索引管理權限的帳號執行 setup-vector-index.sh；等索引 READY 再啟用此版。不需擴大日常 Render 服務帳戶 IAM 權限。索引檔 firestore.indexes.json 供 Firebase CLI 使用；shell 腳本含正式 chunks 及隔離 systemCheckChunks 索引。建立索引不呼叫 Gemini。

已完成舊稿的一次性補登：Render Shell 執行 `node migrate-search-ready.mjs`；隔離測試使用 `node migrate-search-ready.mjs --system-test`。只補上搜尋旗標，不呼叫模型、不更動既有向量，且可安全重跑。未完成稿件不補登。


## v0.9.0：兩層內容、來源對照、版本、核心 metadata、混合搜尋
本節取代前面版本對「僅保存正式稿」、「21 欄」及「純向量前 5 段」的描述。
- 使用者確認後，單一 TXT 分別保存正式整理稿、去識別詳細底稿及來源對照；Firestore v2 documents 保存兩層。底稿不自動向量化、不加入問答上下文；未去識別原稿與編輯歷程不永久保存。
- 原稿段落為 P 編號，整理稿空白行段落為 S 編號。sourceMap 每筆包含 sectionId、sourceIds、kind；事後補充用 supplement，不偽造逐字來源。修改正文後，變動段落的對照清空，須重新核對。來源對照完整不等於語意已驗證。
- lineage.documentId 是固定 DOC UUID，version 是整數，previousRecordId 指前版，changeNote 記錄修訂原因。recordId 仍是不可變的內容指紋。documentHeads 保存目前版本；Firestore CAS 與原子提交避免同時覆寫。新版本確認保存時舊版 chunks 退出搜尋；新版需手動向量化。舊版 TXT／documents 不刪除；重送舊版不回退 head。
- 首頁可輸入任一版本紀錄編號及工具存取碼，載入該文件最新版本修訂。載入、草稿不寫入資料庫；只有確認儲存會建立版本。舊 v1 資料缺少底稿，不會捏造回填；需重新匯入建立完整資料。
- Metadata v2：eventDate（空白／年／年月／完整日期）、contentType、topics、summary、limitations、domains、gradeBands、usageLicense、visibility、schemaVersion。未知值留空或 []。usageLicense 由使用者確認 internal_knowledge；visibility 僅支援 token_holders，並非個別帳號授權。備份依 Drive／Sheets 共用權限。hostOrganization、participantRoles 仍禁止保存。
- Sheets 原有 21 欄後追加 10 欄（V:AE）：文件 ID、版本、取代紀錄、修訂說明、領域、年段、授權、可見範圍、metadata 版本、底稿指紋。部署後明確執行 createStorage().initialize()；只接受已知的舊表頭後追加，不覆寫舊列。
- 混合搜尋：Firestore 原生 COSINE 取 20 段；以 NFKC 小寫拉丁詞／代碼及中文字雙字詞建立雜湊 token 陣列，ARRAY_CONTAINS_ANY 查詢最多 30 個詞，取得最多 100 個關鍵詞候選。候選內以命中詞數排序，再用 RRF (k=60) 融合去重，核對有效版本及原文完整性後選 5 段。這是有候選上限的關鍵詞混合搜尋，不是 BM25，也不保證從全庫取到最佳字詞排名；無全庫掃描或 500 段總量限制。詳細底稿不建關鍵詞索引。
- 問答來源增加版本及 P 來源編號。引用範圍仍為正式整理稿；不宣稱已驗證論述正確。
- 部署先建立 setup-hybrid-index.sh 的兩個複合索引並等 READY。既有已完成向量可明確執行 migrate-search-ready.mjs 補建關鍵詞欄位，不呼叫 Embedding；沒有自動觸發或排程。
- 手動隔離驗收：node verify-v09.mjs --run。只建立 systemChecks 系統測試資料、兩份 TXT 及測試紀錄；會明確呼叫測試 Embedding／回答模型，不進正式搜尋。此指令不在啟動或部署腳本中。


## 四頁籤審閱與雙欄修訂

審閱僅保留去識別建議、自動捨去清單、待確認問題、整理稿及原稿對照。匯入時已填寫的核心 metadata 優先保留，無需再填；使用授權與版本修訂說明仍在審閱頁下方確認。

整理稿逐段與去識別底稿並排，已知來源編號不混入正文。左欄文字框編輯，下方即時呈現原位置的紅字刪除線及綠字新增；手機改為上下排列。每段不設確認按鈕，最後統一確認並預覽純文字正式稿，再明確送出雲端。來源關聯保留，整段事後補充必須標記，不宣稱文字變更已通過語意驗證。修訂顯示留在本機記憶體；編輯紀錄可另存，雲端維持原有正式版本與兩層來源保存方式。
