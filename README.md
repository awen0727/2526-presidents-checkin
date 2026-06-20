# 2526會長聯誼會 LINE 簽到系統

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
5. 已綁定的會長可以在活動開放期間完成簽到。

## 管理中心

`admin.html` 提供：

- 目前活動與即時簽到人數
- 現場代為簽到與撤銷誤簽
- 簽到名單 CSV 匯出
- 活動建立、開放與關閉
- 手機末四碼異常的身分審核
- 會長電話修正與 LINE 綁定解除

## 後端設定順序

1. 從既有的「獅子會300A-2區_25-26年度會長通訊錄」開啟 Apps Script。
2. 將 `apps-script/` 內的檔案加入該 Apps Script 專案。
3. 執行 `setupSystem()`，讓後端記住這份試算表；既有系統分頁與資料不會被清除。
4. 在指令碼屬性設定 `LINE_CHANNEL_ID` 與 `ADMIN_TOKEN`。
5. `Members` 已有 114 位會長，不需要再次匯入；日後原名冊更新時，才設定 `ROSTER_SPREADSHEET_ID` 為同一份試算表 ID 並執行 `importMembersFromSource()`。
6. 執行 `createFirstEvent()` 建立第一場活動。
7. 將 Apps Script 部署為網頁應用程式，再把網址與 LIFF ID 填入 `config.js`。

`ADMIN_TOKEN` 請使用不易猜測的長字串。完整電話不會出現在 `data/members.json` 或公開前端回應中。

## 本機預覽

在 localhost 開啟 `index.html?preview=1`，可在尚未設定 LIFF 前檢查首次綁定介面。此模式只允許 localhost 使用。
