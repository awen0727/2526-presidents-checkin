# 2526會長聯誼會活動報名與 LINE 簽到系統

這是獨立的新專案，不共用原有簽到系統的程式、LIFF、Apps Script、試算表或部署設定。

## 目前進度

- 已建立獨立專案目錄。
- 已匯入 114 個分會的簽到名冊。
- 前端名冊不包含電話與地址。
- 每筆資料都有獨立且固定的系統編號。

## 名冊格式

名冊位於 `data/members.json`，每筆包含：

- `id`：系統人員編號
- `zone`：專區
- `division`：分區
- `club`：會名
- `name`：會長姓名
- `needsReview`：資料是否仍需補充

## 尚未設定

- LINE LIFF 應用程式
- Google Apps Script 後端
- 簽到紀錄試算表
- 正式部署網址

## 系統流程

1. 會長由 LINE 開啟 `index.html`。
2. 第一次使用時選擇專區、分區及分會，輸入手機末四碼。
3. 末四碼符合時自動綁定 LINE；不符合時建立待審申請。
4. 管理者由 `admin.html` 確認身分、修正電話並核准綁定。
5. 已綁定的會長可以在「報名開放」期間完成報名或取消報名；報名會在活動時間前 1.5 小時截止。
6. 已綁定的會長可以在管理者開放簽到後立即簽到；未報名者仍可簽到。
7. 若已設定 LINE 官方帳號權杖，系統可推播報名通知、活動提醒與簽到提醒。

## 管理中心

`admin.html` 提供：

- 目前活動與即時簽到人數
- 現場代為簽到與撤銷誤簽
- 簽到名單 Excel 匯出
- 活動建立、活動時間、報名開關、簽到開關
- 活動報名名單查詢
- LINE 官方帳號推播：報名通知、活動提醒、簽到提醒
- 手機末四碼異常的身分審核
- 會長電話修正與 LINE 綁定解除
- 區分並篩選「今年參加／今年未參加」
- 即時出席看板：`dashboard.html`
- 單場與年度出席查詢：`attendance.html`

「今年未參加」的會長仍保留在 `Members`，但不會出現在首次綁定名冊、現場代簽名單、即時看板總人數或年度出席率分母中。

## 後端設定順序

1. 從既有的「獅子會300A-2區_25-26年度會長通訊錄」開啟 Apps Script。
2. 將 `apps-script/` 內的檔案加入該 Apps Script 專案。
3. 執行 `setupSystem()`，讓後端記住這份試算表；既有系統分頁與資料不會被清除。
4. 在指令碼屬性設定 `LINE_CHANNEL_ID` 與 `ADMIN_TOKEN`。
5. 若要啟用 LINE 官方帳號推播，設定 `LINE_CHANNEL_ACCESS_TOKEN`。
6. 可選填 `CHECKIN_URL`，預設使用 `https://liff.line.me/2010452724-MvUou0rS`。
7. `Members` 已有 114 位會長，不需要再次匯入；日後原名冊更新時，才設定 `ROSTER_SPREADSHEET_ID` 為同一份試算表 ID 並執行 `importMembersFromSource()`。
8. 執行 `createFirstEvent()` 建立第一場活動。
9. 將 Apps Script 部署為網頁應用程式，再把網址與 LIFF ID 填入 `config.js`。

`ADMIN_TOKEN` 請使用不易猜測的長字串。完整電話不會出現在 `data/members.json` 或公開前端回應中。

## LINE 官方帳號

官方帳號推播使用 LINE Messaging API。需在 Apps Script 指令碼屬性設定：

- `LINE_CHANNEL_ACCESS_TOKEN`：Messaging API channel access token
- `CHECKIN_URL`：會長端入口，可填 LIFF URL；未填時使用系統預設 LIFF URL
- `ADMIN_LINE_USER_IDS`：選填，管理者 LINE userId，多位用逗號分隔；用於待審、報名、取消報名通知

注意事項：

- LIFF/Login channel 與 Messaging API channel 建議放在同一個 LINE Developers provider。
- 會長必須加入或解除封鎖官方帳號，才收得到推播。
- 報名與取消報名成功時，系統會嘗試發送個人確認訊息；若未設定權杖或對方未加入官方帳號，不會阻擋報名流程。
- 後台活動管理可推播「報名通知」給所有已綁定會長、「活動提醒」給已報名者、「簽到提醒」給已報名但尚未簽到者。
- 報名與簽到是獨立狀態：可先開放報名，簽到由管理者開放後立即生效；刪除活動前需先關閉報名與簽到。
- 舊活動會自動關閉：活動前 1.5 小時截止報名，活動日 23:59 後關閉簽到。
- 官方帳號 Webhook 可使用同一個 Apps Script 網頁應用程式網址；使用者輸入「報名、簽到、出席、活動、查詢」時會回覆會長端入口。
- 可在 Apps Script 觸發條件新增時間驅動：
  - `sendTomorrowEventReminders()`：活動前一天提醒已報名者
  - `sendTodayCheckinReminders()`：活動當天提醒已報名但尚未簽到者

## 本機預覽

在 localhost 開啟 `index.html?preview=1`，可在尚未設定 LIFF 前檢查首次綁定介面。此模式只允許 localhost 使用。
