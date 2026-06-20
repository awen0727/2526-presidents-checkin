const SCHEMA = Object.freeze({
  Members: ["member_id", "zone", "division", "club", "name", "phone", "status", "line_user_id", "line_display_name", "updated_at"],
  BindingRequests: ["request_id", "member_id", "line_user_id", "line_display_name", "provided_last4", "status", "created_at", "resolved_at", "resolved_by"],
  Events: ["event_id", "event_date", "name", "status", "created_at"],
  Attendance: ["attendance_id", "event_id", "member_id", "name_snapshot", "club_snapshot", "checkin_at", "source"],
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
    "LINE_CHANNEL_ID、ADMIN_TOKEN、ROSTER_SPREADSHEET_ID。"
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
  const memberRows = values.slice(1).filter(row => String(row[headers.indexOf("會名")] || "").trim());

  const output = memberRows.map((sourceRow, index) => {
    const club = String(sourceRow[headers.indexOf("會名")] || "").trim();
    const previous = existingByClub[club] || {};
    return [
      previous.member_id || `P2526-${String(index + 1).padStart(3, "0")}`,
      String(sourceRow[headers.indexOf("專區")] || "").trim(),
      String(sourceRow[headers.indexOf("分區")] || "").trim(),
      club,
      String(sourceRow[headers.indexOf("會長姓名")] || "").trim(),
      normalizePhone_(sourceRow[headers.indexOf("電話")]),
      previous.status || "participating",
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

function createFirstEvent() {
  const ui = SpreadsheetApp.getUi();
  const name = ui.prompt("建立第一場活動", "請輸入活動名稱", ui.ButtonSet.OK_CANCEL);
  if (name.getSelectedButton() !== ui.Button.OK) return;
  const eventName = name.getResponseText().trim();
  if (!eventName) throw new Error("活動名稱不可空白");
  append_("Events", {
    event_id: id_("EV"),
    event_date: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd"),
    name: eventName,
    status: "open",
    created_at: now_()
  });
  ui.alert("活動已建立並開放簽到。日期可直接在 Events 分頁修改。");
}
