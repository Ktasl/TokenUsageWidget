# TokenUsageWidget

## 20261106.1 測試版

本版整理目前 macOS 13 Intel 測試分支的選單列顯示、背景更新、用量統計與匯出改動。安裝檔採本機臨時簽署，需手動安裝；它不使用 OpenUsage 的自動更新或正式版發布流程。實際帳戶、睡眠恢復及選單列操作仍須在目標電腦確認。

This is a separate test edition of the macOS 13 multi-provider menu bar app. Build it with `scripts/build-test.sh`; its Tauri overrides are in `src-tauri/tauri.test.conf.json`. The build script sets `VITE_TOKEN_USAGE_TEST_BUILD=1` for the frontend. A regular build without this flag keeps the original OpenUsage behavior.

The independent edition is named TokenUsageWidget. It retains the existing `io.github.ktasl.tokenusagewidget.test` identity and configuration path to preserve settings from earlier Test builds, and can be kept alongside OpenUsage. It does not check, download or install upstream app updates, send frontend analytics, or show the upstream retirement reminder. Settings explains that app updates are disabled; install a newly built version manually when needed.

On the first launch, all provider plugins are disabled. Open Settings and enable only the providers you want to test. Usage refresh is separate from app updates and works for providers you enable. Plugin style shows every enabled provider with valid quota data, including real 0%; opening the tray item returns to a unified Token and quota overview.

App settings are separate, but provider accounts are not copied or sandboxed. After you enable a provider, its existing adapter can still read the same CLI login files, browser/keychain credentials or other provider sources as OpenUsage. The test edition does not create separate provider accounts. Do not enable a provider if you do not want it to access those existing sources.

Building the edition does not launch it, overwrite an existing app, or verify real-account behavior. The original upstream license and copyright notices remain in place.

## 繁體中文與統一總覽

點開選單列後預設回到總覽，所有已啟用服務集中顯示 Token 用量、有效額度與重設時間。來源沒有 Token 數據時會明示，不從百分比反推，也不跨期間加總；月費與金額不放在總覽，詳細頁仍保留來源資訊。

設定分為「顯示與外觀」「服務與模型」「更新與系統」。每個服務可以指定選單列使用的模型／額度；預設自動選擇有效資料。指定項暫時沒有資料時會使用其他有效額度，但保留原選擇。模型選擇控制選單列，總覽保留該服務所有可用額度。介面與時間使用繁體中文；品牌、原始來源錯誤及上游更新內容保留原文。

沿用相同的測試版 App ID，因此升級會保留原測試版已啟用的服務與設定；不重設帳戶或複製原版資料。使用新版前先結束正在執行的舊測試版，再手動開啟新版。

2026-10-22 起 App 與 ZIP 名稱不再帶 Test。頁尾與關於畫面增加建置號，這次為 `20261022.1`，可直接辨識正在執行的版本。新 ZIP 名稱含日期與建置號，避免與第一版英文封裝混淆。若曾為舊名稱開啟登入時啟動，請在新版檢查該選項，並於 macOS 登入項目移除不再使用的舊版；此次建置不操作系統登入項目。

2026-10-23 的 `20261023.1` 修正啟動時各服務資料先後到齊的顯示問題：資料更新提交後會再次同步選單列，避免總覽已出現 Claude 額度、選單列仍停在只有其他服務的畫面。此更新不重設服務、模型或帳戶設定。

`20261023.2` 對本機 Token 統計加上整次查詢最多 8 秒的共用預算，並保留至少 2 秒回傳額度。工具探測不再執行額外命令，子程序與輸出管線等待也受預算限制。Claude 已取得額度時，Token 統計逾時、缺工具或失敗會保留額度，Token 區塊顯示原因，不假造 0 Token。

Claude 查詢分為登入讀取、線上額度及本機 Token 三段。錯誤紀錄只包含固定階段、數字識別碼與毫秒耗時，不包含帳號、Token、網址或回應內容；登入讀取與線上額度本身失敗仍會顯示錯誤，不會假裝已有可用額度。這版沒有操作真實帳戶或驗證重開機自啟動。

開發工具位於 `artifacts/development-tooling/`，從原始碼目錄執行 `source ../artifacts/development-tooling/environment.sh` 後再建置。此為必要工具，不是舊版 App，清理封裝時需保留。

`20261023.3` 修正首次登入環境讀取：只有第一次需要時啟動一次登入終端，同時讀取既有允許清單中的設定；所有服務共用結果，成功時連缺值也一併快取。整次最多等待 5 秒，也不超過本次更新剩餘時間。環境值只留在記憶體，不寫入檔案或紀錄；不在停用服務時額外預讀登入環境。

若讀取失敗，會明示登入環境初始化失敗，30 秒內共用失敗狀態，之後重新整理可重試；不把失敗當成沒有自訂帳號設定，也不因此改讀另一個 Claude／Codex 帳號或 MiniMax 金鑰／區域。前一版的 Token 統計期限及保留額度行為維持。實際帳戶及重新開機自啟動仍需安裝後確認。

`20261023.3` 已由使用者實測發現退步：5 秒上限會擋住 Claude 及 Codex。`20261023.4` 以實際終端固定標記量到首次約 13.4 秒才進入命令，修正為共用最多 20 秒的初始化時間，仍受原本整次更新 30 秒限制；額度及可選 Token 統計不另加無界等待。

完整設定資料到齊即可返回，不再等待終端退出或背景程序關閉輸出；成功與失敗都會清理本次擷取的子程序。另修正啟用遇錯即停的終端設定時，缺少環境變數會提前結束的問題。帳號選擇仍只使用已確認的匯出環境設定，不把未知設定當成空值，也不改用其他帳號。

固定錯誤分類與耗時改記在預設可見的錯誤層級；不記錄終端內容或設定值。這版的實際終端量測沒有查詢帳戶或讀取憑證內容；真實帳戶額度及重開機仍待安裝後驗證。

`20261024.1` 修復更新停止後一直顯示舊額度的流程。每批查詢會追蹤各服務是否收到結果；逾時、啟動失敗、或批次已完成卻少了服務結果，都會解除該服務的讀取狀態並允許重試，不再被後續自動更新永久跳過。查詢期限依原生最多四個服務並行、每個 30 秒計算，加 15 秒收尾時間；目前三個服務為 45 秒，較多服務會保留排隊時間。

睡眠後使用實際經過時間判斷過期；重新打開選單列面板、視窗取得焦點或恢復可見時，會結束超期查詢，並在自動更新已到期時立即補查。重試後只接受較新的請求結果，舊結果、重複結果及晚到的啟動失敗不會覆蓋新資料。這不會強制取消已卡住的原生系統呼叫，最初未返回的呼叫仍可能需要另外定位。

後端查詢意外中止也會送出服務失敗結果；傳送失敗只記錄固定錯誤，不記錄回應內容。卡片保留舊數值時會標示「上次成功資料」與成功時間；更新失敗會提示資料可能已過期。「正在更新用量」只代表整個服務正在更新，不再暗示卡在 Token 統計。失敗後可立即重試，不受上一次成功手動更新的冷卻時間阻擋。此次未調整登入環境預算、帳號或憑證。

## 20261025.1：持續更新、本機統計與浮窗

使用者對 20261024.1 的實測仍顯示 Claude/Codex 沒有持續更新，所以上述畫面恢復不代表來源已恢復。新版將原生 keychain、SQLite、程序與連接埠檢查的子程序及輸出等待納入既有查詢期限，逾時後清理本次程序，不延長登入或整次查詢上限。較舊查詢不得蓋過較新查詢的快取。

原生較舊批次也不再發布結果。前景與背景更新交疊時，批次結束先解除等待，再於 2 秒內取回較新的背景快照並保留原始成功時間；快照逾時仍可下一次重試。

面板關閉時由原生排程接續已啟用服務的更新，沿用設定的 5／15／30／60 分鐘間隔；睡眠後補一次到期查詢，不重播每個錯過的間隔。重新開面板會讀取本次執行中的最新成功快照，讀取最多等待 2 秒，再繼續到期更新。快照保留實際成功時間，不把舊磁碟快取當新資料。前端期限備援檢查由每秒改為每 15 秒，每批精確逾時計時與取得焦點時的恢復仍保留；這是喚醒次數調整，未宣稱量到實機電力改善。

Claude/Codex 另列「本機 Token 統計」：以 Asia/Taipei、週一開始，顯示本週、上週、最近 7 天、每日趨勢與來源可提供的模型分項。只加來源明示的每日總量；快取可能已含於輸入，不再相加。缺紀錄是未知，明確的零才是 0，未來日期不補零。本週未結束或涵蓋不同時不顯示不合理增減百分比。

首次最多回查含今天的 31 天。每日來源無法可靠拆回專案、對話或子代理，本版不顯示推測歸因。Codex 舊統計工具 18.0.11 有重複計數風險時不提供累計；工具缺少、來源無紀錄、無效資料及逾時分開顯示，不妨礙已取得的額度。Antigravity 沒有實際 Token 來源時維持無資料。

每日歷史在本機保留 180 日，以服務、匿名來源識別及時區分開；重查同一天採最新快照取代，不累加。匿名識別代表本機紀錄目錄，並非已核實的登入帳號；同一目錄可能包含多個帳號的資料，不能當作帳號帳單。來源改變後只顯示目前來源的歷史，不混加其他來源。月度比較附已知天數，缺日期仍未知，啟用前的完整月份無法保證回補。

CSV／唯讀 JSON 從總覽匯出到「下載／TokenUsageWidget」，檔名含時間避免覆寫。內容只有必要統計與來源狀態，不包含登入秘密、完整對話、私有路徑或原始錯誤。每檔限 2 MB；儲存失敗會提示，不會假裝已下載。不建立 HTTP 埠或外部上傳。

「釘選為浮窗」沿用同一面板和資料；滑鼠穿透需先釘選。右鍵點選選單列可恢復互動或取消釘選；左鍵與快捷鍵也可恢復互動。每次重新啟動預設關閉浮窗與穿透，不另存互相矛盾的用量資料。

過期超過 10 分鐘、來源失敗、週期未知或資料不足時停止預測。跨服務提示只列已啟用、有新鮮有效額度的選項；不假設服務能力等價，不自動轉移工作或呼叫付費模型。

具體耗盡時間需同一服務、來源、額度及重設週期的兩次成功觀測，兩筆相隔 30 秒至 10 分鐘且用量有增加。第一筆、用量不變或下降、間隔過久或來源改變都不顯示具體預測；保留清楚標為「週期平均」的狀態及時間刻度，避免把閒置前的平均速度當作目前消耗速度。近期樣本只留在目前卡片的記憶體，不跨啟動保存。

建置與合成測試不會啟動真實帳戶 App。本版的實際帳戶持續更新、實機睡眠／重新開機、浮窗穿透與電力效果未因此獲得實測確認；驗證紀錄須另外列明。

## 20261025.2：選單列雙額度與倒數

在「設定 → 顯示與外觀 → 選單列顯示」選擇「雙額度與倒數」。全新 TokenUsageWidget 預設使用此樣式；升級保留先前服務圖示／圓環／長條的選擇，不改寫使用者設定，需手動選新樣式。

### 20261026.1：新增預設「圖示大字」

全新設定改以「圖示大字」為預設，已保存的主題仍保留。升級使用者可在同一設定頁選擇新主題，也可隨時切回「雙額度與倒數」、服務圖示、圓環或長條。

圖示大字以品牌圖示及單排大字剩餘百分比呈現，不顯示重設時間或倒數。Claude／Codex 圖示後各列 S（Session）、W（Weekly）；Antigravity 圖示後，同時列 Gemini 圖示與其百分比、Claude 圖示與其百分比。兩種模型不混加，不拿一種模型補另一種的資料。Gemini 的 Pro／Flash 選擇沿用前版。

此主題與詳細主題共用同一來源、成功時間與過期規則。來源未提供、失敗、過期時顯示 `--`，有效的零顯示 `0%`；隱藏時間不代表忽略重設期限。舊主題及面板的額度、倒數、Token、費用與匯出行為保持各自原有設定。

- Claude 與 Codex 各顯示兩行：S 是 Session，W 是 Weekly；數字固定代表剩餘百分比，旁邊是該欄位自己的重設倒數。倒數依來源時間，沒有把兩個週期互相替代。
- Antigravity 顯示兩行並列資訊：G 是 Gemini，C 是 Claude。預設用 Gemini Pro，缺少時可用 Gemini Flash；「服務與模型」選 Gemini Flash 時以 Flash 為準。Gemini 不使用 Claude 的額度補值，Claude 也不使用 Gemini。兩個模型不相加。
- 其他已啟用服務沿用其可用額度及既有模型選擇；舊三種樣式與選單列主要入口保留。內容多時可回到較簡潔的舊樣式。
- 缺額度、查詢失敗、超過10分鐘或重設已過時顯示待更新；明確的零和100%仍照實顯示。只有重設時間缺少時保留已知百分比，倒數顯示 `--`。Antigravity 來源缺欄位不再當成剩餘零。

新樣式由原生程式畫兩行文字，沿用既有15秒背景檢查、每分鐘更新倒數；取得新資料或來源失敗時立即更新。關閉面板不依賴WebView計時器。切換樣式會先完成原生與前端繪圖的交接，避免舊圖晚到覆蓋新圖。沒有啟用服務時保留可點選的入口。

點開後仍是三服務統一總覽。每張卡的「額外資訊」分開顯示 Cost 與 Extra Usage：Cost 是本機紀錄依API定價估算，附實際日期與有金額紀錄天數；不是訂閱月費或帳單。Extra Usage 僅顯示供應商提供的本月額外用量，不拿Codex剩餘點數推算支出，也不與估算費用相加。未提供時明示未知；來源明確回傳零才顯示零。Usage Trend 沿用上方同一份本機Token日趨勢與期間選擇，不複製另一份不同口徑的圖。

安裝封裝仍為Intel macOS13獨立版，保留相同App ID及設定；不自動安裝或啟動真實帳戶App。來源資料真實性、實際menu bar可讀性、系統睡眠與帳戶更新仍須與合成測試分開回報。選了新樣式後退回舊版，舊版不認得quota設定值時可能使用舊預設；服務與帳號設定不會因此被重設。
