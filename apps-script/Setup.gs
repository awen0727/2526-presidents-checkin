const SCHEMA = Object.freeze({
  Members: ["member_id", "zone", "division", "club", "name", "phone", "status", "line_user_id", "line_display_name", "updated_at"],
  BindingRequests: ["request_id", "member_id", "line_user_id", "line_display_name", "provided_last4", "status", "created_at", "resolved_at", "resolved_by"],
  Events: ["event_id", "event_date", "event_time", "name", "status", "registration_status", "checkin_status", "created_at"],
  EventRegistrations: ["registration_id", "event_id", "member_id", "name_snapshot", "club_snapshot", "status", "registered_at", "canceled_at", "source"],
  Attendance: ["attendance_id", "event_id", "member_id", "name_snapshot", "club_snapshot", "checkin_at", "source"],
  LineGroups: ["group_id", "group_name", "group_type", "status", "bound_by_user_id", "created_at", "updated_at"],
  AuditLogs: ["log_id", "action", "actor", "target", "details", "created_at"]
});

function setupSystem() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("請從新的 2526 會長聯誼會試算表內執行 setupSystem");

  Object.keys(SCHEMA).forEach(name => {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    const headers = SCHEMA[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setFontColor("#ffffff")
      .setBackground("#163f73");
    sheet.autoResizeColumns(1, headers.length);
  });

  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", spreadsheet.getId());
  SpreadsheetApp.getUi().alert(
    "獨立資料表已建立。\n\n接著請到「專案設定 → 指令碼屬性」設定：\n" +
    "LINE_CHANNEL_ID、ADMIN_TOKEN、ROSTER_SPREADSHEET_ID。\n\n" +
    "若要啟用 LINE 官方帳號推播，請再設定 LINE_CHANNEL_ACCESS_TOKEN；" +
    "CHECKIN_URL 可選填，預設使用目前 LIFF 簽到網址。\n\n" +
    "群組推播：將官方帳號加入 LINE 群組後，在群組輸入「＠綁定群組 群組名稱」。"
  );
}

function importMembersFromSource() {
  const sourceId = PropertiesService.getScriptProperties().getProperty("ROSTER_SPREADSHEET_ID");
  if (!sourceId) throw new Error("尚未設定 ROSTER_SPREADSHEET_ID");

  const sourceSheet = SpreadsheetApp.openById(sourceId).getSheets()[0];
  const values = sourceSheet.getDataRange().getDisplayValues();
  if (values.length < 2) throw new Error("來源名冊沒有資料");
  const headers = values[0].map(String);
  const required = ["專區", "分區", "會名", "會長姓名", "電話"];
  required.forEach(header => {
    if (!headers.includes(header)) throw new Error(`來源名冊缺少欄位：${header}`);
  });

  const membersSheet = sheet_("Members");
  const existing = rows_("Members");
  const existingByClub = {};
  existing.forEach(row => { existingByClub[row.club] = row; });
  const statusColumn = findHeader_(headers, ["今年參加", "今年有參加", "今年是否參加", "是否參加", "參加與否", "參加狀態", "2526參加", "2526是否參加", "狀態"]);
  const memberRows = values.slice(1).filter(row => String(row[headers.indexOf("會名")] || "").trim());

  const output = memberRows.map((sourceRow, index) => {
    const club = String(sourceRow[headers.indexOf("會名")] || "").trim();
    const previous = existingByClub[club] || {};
    const sourceStatus = statusColumn >= 0 ? participationStatusFromText_(sourceRow[statusColumn]) : "";
    return [
      previous.member_id || `P2526-${String(index + 1).padStart(3, "0")}`,
      String(sourceRow[headers.indexOf("專區")] || "").trim(),
      String(sourceRow[headers.indexOf("分區")] || "").trim(),
      club,
      String(sourceRow[headers.indexOf("會長姓名")] || "").trim(),
      normalizePhone_(sourceRow[headers.indexOf("電話")]),
      sourceStatus || previous.status || "not_participating",
      previous.line_user_id || "",
      previous.line_display_name || "",
      now_()
    ];
  });

  if (membersSheet.getLastRow() > 1) {
    membersSheet.getRange(2, 1, membersSheet.getLastRow() - 1, SCHEMA.Members.length).clearContent();
  }
  if (output.length) membersSheet.getRange(2, 1, output.length, SCHEMA.Members.length).setValues(output);
  membersSheet.autoResizeColumns(1, SCHEMA.Members.length);
  audit_("import_members", "setup", "Members", `${output.length} members`);
  SpreadsheetApp.getUi().alert(`已匯入 ${output.length} 位會長。完整電話只保存在 Members 分頁。`);
}

function findHeader_(headers, candidates) {
  return candidates.map(header => headers.indexOf(header)).find(index => index >= 0) ?? -1;
}

function participationStatusFromText_(value) {
  const text = String(value || "").trim().replace(/\s+/g, "");
  if (!text) return "";
  if (/^(是|有|參加|今年參加|Y|YES|TRUE|1|V|✓|✔)$/i.test(text)) return "participating";
  if (/^(否|無|未參加|不參加|今年未參加|N|NO|FALSE|0|X)$/i.test(text)) return "not_participating";
  if (/未參加|不參加|無參加/.test(text)) return "not_participating";
  if (/參加/.test(text)) return "participating";
  return "";
}

function createFirstEvent() {
  const ui = SpreadsheetApp.getUi();
  const name = ui.prompt("建立第一場活動", "請輸入活動名稱", ui.ButtonSet.OK_CANCEL);
  if (name.getSelectedButton() !== ui.Button.OK) return;
  const eventName = name.getResponseText().trim();
  if (!eventName) throw new Error("活動名稱不可空白");
  append_("Events", {
    event_id: id_("EV"),
    event_date: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd"),
    event_time: "18:00",
    name: eventName,
    status: "open",
    registration_status: "open",
    checkin_status: "open",
    created_at: now_()
  });
  ui.alert("活動已建立並開放簽到。日期可直接在 Events 分頁修改。");
}
