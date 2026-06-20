const SHEETS = Object.freeze({
  MEMBERS: "Members",
  BINDINGS: "BindingRequests",
  EVENTS: "Events",
  ATTENDANCE: "Attendance",
  AUDIT: "AuditLogs"
});

const API_VERSION = "2526-presidents-2026-06-19-1";

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action !== "health") throw new Error("不支援的 GET 操作");
    return json_({ ok: true, apiVersion: API_VERSION, spreadsheetConfigured: Boolean(spreadsheetId_()) });
  } catch (error) {
    return json_({ ok: false, apiVersion: API_VERSION, error: error.message });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    return json_({ ok: true, apiVersion: API_VERSION, ...route_(payload) });
  } catch (error) {
    return json_({ ok: false, apiVersion: API_VERSION, error: error.message });
  }
}

function route_(payload) {
  const action = String(payload.action || "");
  const publicActions = {
    getSession: getSession_,
    requestBinding: requestBinding_,
    checkIn: checkIn_
  };
  const adminActions = {
    adminOverview: adminOverview_,
    adminApproveBinding: adminApproveBinding_,
    adminRejectBinding: adminRejectBinding_
  };
  if (publicActions[action]) return publicActions[action](payload);
  if (adminActions[action]) {
    requireAdmin_(payload.adminToken);
    return adminActions[action](payload);
  }
  throw new Error("不支援的操作");
}

function getSession_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
  const pending = findRows_(SHEETS.BINDINGS, row => row.line_user_id === line.sub && row.status === "pending").length > 0;
  const event = getOpenEvent_();
  const alreadyCheckedIn = Boolean(member && event && findRows_(SHEETS.ATTENDANCE, row =>
    row.event_id === event.event_id && row.member_id === member.member_id
  ).length);
  return {
    member: member ? publicMember_(member) : null,
    event: event ? publicEvent_(event) : null,
    bindingPending: pending,
    alreadyCheckedIn
  };
}

function requestBinding_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const phoneLast4 = String(payload.phoneLast4 || "").replace(/\D/g, "");
  if (!/^\d{4}$/.test(phoneLast4)) throw new Error("手機末四碼格式不正確");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (findOne_(SHEETS.MEMBERS, "line_user_id", line.sub)) throw new Error("此 LINE 帳號已綁定會長資料");
    const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
    if (!member || member.status !== "active") throw new Error("找不到有效的會長資料");
    if (member.line_user_id) throw new Error("此會長資料已綁定其他 LINE 帳號，請聯絡管理者");
    const existing = findRows_(SHEETS.BINDINGS, row => row.line_user_id === line.sub && row.status === "pending")[0];
    if (existing) return { status: "pending", message: "申請已送出，請等待管理者確認" };

    const storedPhone = normalizePhone_(member.phone);
    if (storedPhone.length >= 4 && storedPhone.slice(-4) === phoneLast4) {
      updateRow_(SHEETS.MEMBERS, member._row, {
        line_user_id: line.sub,
        line_display_name: cleanText_(line.name || "", 80),
        updated_at: now_()
      });
      audit_("binding_auto_approved", line.sub, member.member_id, "last4 matched");
      return { status: "approved", message: "身分核對成功，LINE 已完成綁定" };
    }

    append_(SHEETS.BINDINGS, {
      request_id: id_("BR"),
      member_id: member.member_id,
      line_user_id: line.sub,
      line_display_name: cleanText_(line.name || "", 80),
      provided_last4: phoneLast4,
      status: "pending",
      created_at: now_(),
      resolved_at: "",
      resolved_by: ""
    });
    audit_("binding_requested", line.sub, member.member_id, "last4 mismatch");
    return { status: "pending", message: "末四碼未能核對，已交由管理者確認" };
  } finally {
    lock.releaseLock();
  }
}

function checkIn_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || member.status !== "active") throw new Error("尚未完成有效的 LINE 身分綁定");
    const event = getOpenEvent_();
    if (!event) throw new Error("目前沒有開放簽到的活動");
    const duplicate = findRows_(SHEETS.ATTENDANCE, row =>
      row.event_id === event.event_id && row.member_id === member.member_id
    )[0];
    if (duplicate) throw new Error("您已完成本次活動簽到");
    append_(SHEETS.ATTENDANCE, {
      attendance_id: id_("AT"),
      event_id: event.event_id,
      member_id: member.member_id,
      name_snapshot: member.name,
      club_snapshot: member.club,
      checkin_at: now_(),
      source: "LINE"
    });
    audit_("check_in", member.member_id, event.event_id, "LINE");
    return { message: `${member.name || member.club + "會會長"}，簽到成功！` };
  } finally {
    lock.releaseLock();
  }
}

function adminOverview_() {
  const members = rows_(SHEETS.MEMBERS);
  const requests = findRows_(SHEETS.BINDINGS, row => row.status === "pending").map(request => {
    const member = members.find(item => item.member_id === request.member_id) || {};
    return {
      request_id: request.request_id,
      member_id: request.member_id,
      member_name: member.name || "",
      zone: member.zone || "",
      division: member.division || "",
      club: member.club || "",
      line_display_name: request.line_display_name || "",
      provided_last4: request.provided_last4 || "",
      masked_phone: maskPhone_(member.phone),
      created_at: request.created_at
    };
  });
  return {
    requests,
    memberCount: members.filter(member => member.status === "active").length,
    boundCount: members.filter(member => member.status === "active" && member.line_user_id).length
  };
}

function adminApproveBinding_(payload) {
  const requestId = cleanText_(payload.requestId, 40, "申請編號");
  const request = findOne_(SHEETS.BINDINGS, "request_id", requestId);
  if (!request || request.status !== "pending") throw new Error("找不到待確認申請");
  const member = findOne_(SHEETS.MEMBERS, "member_id", request.member_id);
  if (!member || member.status !== "active") throw new Error("找不到有效會長資料");
  if (member.line_user_id && member.line_user_id !== request.line_user_id) throw new Error("此會長已綁定其他 LINE 帳號");
  const lineOwner = findOne_(SHEETS.MEMBERS, "line_user_id", request.line_user_id);
  if (lineOwner && lineOwner.member_id !== member.member_id) throw new Error("此 LINE 帳號已綁定其他會長");

  const phone = normalizePhone_(payload.phone);
  if (phone && (phone.length < 8 || phone.length > 15)) throw new Error("完整電話格式不正確");
  updateRow_(SHEETS.MEMBERS, member._row, {
    phone: phone || member.phone,
    line_user_id: request.line_user_id,
    line_display_name: request.line_display_name,
    updated_at: now_()
  });
  updateRow_(SHEETS.BINDINGS, request._row, {
    status: "approved",
    resolved_at: now_(),
    resolved_by: "admin"
  });
  audit_("binding_admin_approved", "admin", member.member_id, phone ? "phone updated" : "phone unchanged");
  return { message: "LINE 綁定已核准" };
}

function adminRejectBinding_(payload) {
  const requestId = cleanText_(payload.requestId, 40, "申請編號");
  const request = findOne_(SHEETS.BINDINGS, "request_id", requestId);
  if (!request || request.status !== "pending") throw new Error("找不到待確認申請");
  updateRow_(SHEETS.BINDINGS, request._row, {
    status: "rejected",
    resolved_at: now_(),
    resolved_by: "admin"
  });
  audit_("binding_rejected", "admin", request.member_id, request.line_user_id);
  return { message: "申請已拒絕" };
}

function verifyLineToken_(idToken) {
  const token = cleanText_(idToken, 3000, "LINE 登入憑證");
  const channelId = PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ID");
  if (!channelId) throw new Error("後端尚未設定 LINE_CHANNEL_ID");
  const response = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: token, client_id: channelId },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error("LINE 登入憑證無效或已過期");
  const result = JSON.parse(response.getContentText());
  if (String(result.aud) !== String(channelId) || !result.sub) throw new Error("LINE 登入憑證驗證失敗");
  return result;
}

function requireAdmin_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty("ADMIN_TOKEN");
  if (!expected) throw new Error("後端尚未設定 ADMIN_TOKEN");
  if (String(token || "") !== expected) throw new Error("管理密鑰不正確");
}

function publicMember_(member) {
  return {
    member_id: member.member_id,
    zone: member.zone,
    division: member.division,
    club: member.club,
    name: member.name
  };
}

function publicEvent_(event) {
  return { event_id: event.event_id, event_date: event.event_date, name: event.name };
}

function getOpenEvent_() {
  return findRows_(SHEETS.EVENTS, row => row.status === "open")[0] || null;
}

function maskPhone_(value) {
  const phone = normalizePhone_(value);
  if (phone.length < 4) return "";
  return `${"*".repeat(Math.max(4, phone.length - 4))}${phone.slice(-4)}`;
}

function normalizePhone_(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

function cleanText_(value, maxLength, label) {
  const text = String(value == null ? "" : value).trim();
  if (label && !text) throw new Error(`${label}不可空白`);
  if (text.length > maxLength) throw new Error(`${label || "文字"}過長`);
  return text;
}

function spreadsheetId_() {
  return PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "";
}

function spreadsheet_() {
  const id = spreadsheetId_();
  if (!id) throw new Error("尚未執行 setupSystem");
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error(`找不到資料表：${name}`);
  return sheet;
}

function rows_(name) {
  const sheet = sheet_(name);
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(row => row.some(value => value !== "")).map((row, index) => {
    const item = { _row: index + 2 };
    headers.forEach((header, column) => { item[header] = row[column]; });
    return item;
  });
}

function findRows_(name, predicate) {
  return rows_(name).filter(predicate);
}

function findOne_(name, key, value) {
  return rows_(name).find(row => String(row[key]) === String(value)) || null;
}

function append_(name, data) {
  const headers = SCHEMA[name];
  if (!headers) throw new Error(`未定義資料表：${name}`);
  sheet_(name).appendRow(headers.map(header => data[header] == null ? "" : data[header]));
}

function updateRow_(name, rowNumber, changes) {
  const sheet = sheet_(name);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  Object.keys(changes).forEach(key => {
    const column = headers.indexOf(key);
    if (column < 0) throw new Error(`資料表 ${name} 缺少欄位：${key}`);
    sheet.getRange(rowNumber, column + 1).setValue(changes[key]);
  });
}

function audit_(action, actor, target, details) {
  append_(SHEETS.AUDIT, {
    log_id: id_("LG"), action, actor, target, details, created_at: now_()
  });
}

function id_(prefix) {
  return `${prefix}-${Date.now()}-${Utilities.getUuid().slice(0, 8)}`;
}

function now_() {
  return new Date().toISOString();
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
