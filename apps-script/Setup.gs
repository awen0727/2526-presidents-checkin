const SCHEMA = Object.freeze({
  Members: ["member_id", "zone", "division", "club", "name", "birthday", "phone", "role", "status", "line_user_id", "line_display_name", "updated_at"],
  BindingRequests: ["request_id", "member_id", "line_user_id", "line_display_name", "provided_birthday", "provided_last4", "status", "created_at", "resolved_at", "resolved_by"],
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

  const sourceBook = SpreadsheetApp.openById(sourceId);
  const importedRows = sourceBook.getSheets()
    .map(sheet => sourceRowsFromSheet_(sheet))
    .reduce((all, rows) => all.concat(rows), []);
  if (!importedRows.length) throw new Error("來源名冊沒有可匯入的人員資料，請確認至少有專區、會名、姓名、生日欄位");

  ensureSheet_("Members");
  const membersSheet = sheet_("Members");
  const existing = rows_("Members");
  const existingByKey = {};
  existing.forEach(row => { existingByKey[memberKey_(row)] = row; });

  const output = importedRows.map((sourceRow, index) => {
    const previous = existingByKey[memberKey_(sourceRow)] || {};
    return [
      previous.member_id || `P2526-${String(index + 1).padStart(3, "0")}`,
      sourceRow.zone,
      sourceRow.division,
      sourceRow.club,
      sourceRow.name,
      normalizeBirthday_(sourceRow.birthday) || birthdayForMember_(sourceRow),
      normalizePhone_(sourceRow.phone),
      sourceRow.role || previous.role || "president",
      sourceRow.status || previous.status || "participating",
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
  SpreadsheetApp.getUi().alert(`已匯入 ${output.length} 位人員。生日已寫入 Members 分頁，顧問也可登入報名與簽到。`);
}

function sourceRowsFromSheet_(sourceSheet) {
  const values = sourceSheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const headers = values[0].map(header => String(header || "").trim());
  const zoneColumn = findHeader_(headers, ["專區", "所屬專區"]);
  const divisionColumn = findHeader_(headers, ["分區", "所屬分區"]);
  const clubColumn = findHeader_(headers, ["會名", "分會", "社名", "單位"]);
  const nameColumn = findHeader_(headers, ["會長姓名", "姓名", "人員姓名", "顧問姓名"]);
  const birthdayColumn = findHeader_(headers, ["生日", "生日日期", "出生日期", "生日(月/日)", "生日月日"]);
  const phoneColumn = findHeader_(headers, ["電話", "手機", "手機號碼", "聯絡電話"]);
  const statusColumn = findHeader_(headers, ["今年參加", "今年有參加", "今年是否參加", "是否參加", "參加與否", "參加狀態", "2526參加", "2526是否參加", "狀態"]);
  const roleColumn = findHeader_(headers, ["身分", "身份", "角色", "類別"]);
  if (zoneColumn < 0 || clubColumn < 0 || nameColumn < 0) return [];
  const defaultRole = /顧問/.test(sourceSheet.getName()) ? "advisor" : "president";
  return values.slice(1).map(row => {
    const name = String(row[nameColumn] || "").trim();
    const club = String(row[clubColumn] || "").trim();
    if (!name && !club) return null;
    const roleText = roleColumn >= 0 ? String(row[roleColumn] || "").trim() : "";
    return {
      zone: String(row[zoneColumn] || "").trim(),
      division: divisionColumn >= 0 ? String(row[divisionColumn] || "").trim() : "",
      club,
      name,
      birthday: birthdayColumn >= 0 ? row[birthdayColumn] : "",
      phone: phoneColumn >= 0 ? row[phoneColumn] : "",
      role: roleFromText_(roleText) || defaultRole,
      status: statusColumn >= 0 ? participationStatusFromText_(row[statusColumn]) : "participating"
    };
  }).filter(Boolean);
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

function roleFromText_(value) {
  const text = String(value || "").trim();
  if (/顧問|advisor/i.test(text)) return "advisor";
  if (/會長|president/i.test(text)) return "president";
  return "";
}

function memberKey_(member) {
  return [
    String((member && member.club) || "").trim(),
    String((member && member.name) || "").trim()
  ].join("|");
}

function normalizeBirthday_(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  const text = raw
    .replace(/[．.。]/g, "")
    .replace(/[年月]/g, "/")
    .replace(/日/g, "")
    .replace(/／/g, "/")
    .replace(/\s+/g, "");
  let match = text.match(/^(?:\d{4}\/)?(\d{1,2})\/(\d{1,2})$/);
  if (!match) match = text.match(/^(\d{1,2})(\d{2})$/);
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${month}/${day}`;
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
