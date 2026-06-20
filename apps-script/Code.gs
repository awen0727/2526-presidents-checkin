const SHEETS = Object.freeze({
  MEMBERS: "Members",
  BINDINGS: "BindingRequests",
  EVENTS: "Events",
  ATTENDANCE: "Attendance",
  AUDIT: "AuditLogs"
});

const API_VERSION = "2526-presidents-2026-06-20-attendance-6";

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
    getRoster: getRoster_,
    dashboard: dashboard_,
    requestBinding: requestBinding_,
    checkIn: checkIn_
  };
  const adminActions = {
    adminOverview: adminOverview_,
    adminApproveBinding: adminApproveBinding_,
    adminRejectBinding: adminRejectBinding_,
    adminCreateEvent: adminCreateEvent_,
    adminSetEventStatus: adminSetEventStatus_,
    adminManualCheckIn: adminManualCheckIn_,
    adminRemoveAttendance: adminRemoveAttendance_,
    adminUpdateMemberPhone: adminUpdateMemberPhone_,
    adminUnbindMember: adminUnbindMember_,
    adminSetParticipation: adminSetParticipation_,
    adminAttendanceReport: adminAttendanceReport_
  };
  if (publicActions[action]) return publicActions[action](payload);
  if (adminActions[action]) {
    requireAdmin_(payload.adminToken);
    return adminActions[action](payload);
  }
  throw new Error("不支援的操作");
}

function getSession_(payload) {
  const line = verifyLineIdentity_(payload);
  const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
  const participating = Boolean(member && isParticipating_(member));
  const pending = findRows_(SHEETS.BINDINGS, row => row.line_user_id === line.sub && row.status === "pending").length > 0;
  const event = getOpenEvent_();
  const alreadyCheckedIn = Boolean(participating && event && findRows_(SHEETS.ATTENDANCE, row =>
    row.event_id === event.event_id && row.member_id === member.member_id
  ).length);
  return {
    member: member ? publicMember_(member) : null,
    event: participating && event ? publicEvent_(event) : null,
    bindingPending: pending,
    participationInactive: Boolean(member && !participating),
    alreadyCheckedIn
  };
}

function getRoster_() {
  return {
    members: rows_(SHEETS.MEMBERS)
      .filter(isParticipating_)
      .map(publicMember_)
  };
}

function dashboard_() {
  const event = getOpenEvent_();
  const members = rows_(SHEETS.MEMBERS).filter(isParticipating_);
  if (!event) {
    return { event: null, totalCount: members.length, attendedCount: 0, absentCount: members.length, attendanceRate: 0, list: [] };
  }
  const memberById = {};
  members.forEach(member => { memberById[member.member_id] = member; });
  const records = findRows_(SHEETS.ATTENDANCE, row => row.event_id === event.event_id && memberById[row.member_id]);
  const seen = {};
  const list = records.filter(record => {
    if (seen[record.member_id]) return false;
    seen[record.member_id] = true;
    return true;
  }).map(record => ({
    member_id: record.member_id,
    name: record.name_snapshot,
    club: record.club_snapshot,
    checkin_at: record.checkin_at,
    source: record.source
  })).sort((a, b) => String(a.checkin_at).localeCompare(String(b.checkin_at)));
  const attendedCount = list.length;
  return {
    event: publicEvent_(event),
    totalCount: members.length,
    attendedCount,
    absentCount: Math.max(0, members.length - attendedCount),
    attendanceRate: members.length ? Math.round(attendedCount / members.length * 1000) / 10 : 0,
    list
  };
}

function requestBinding_(payload) {
  const line = verifyLineIdentity_(payload);
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const phoneLast4 = String(payload.phoneLast4 || "").replace(/\D/g, "");
  if (!/^\d{4}$/.test(phoneLast4)) throw new Error("手機末四碼格式不正確");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (findOne_(SHEETS.MEMBERS, "line_user_id", line.sub)) throw new Error("此 LINE 帳號已綁定會長資料");
    const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
    if (!member || !isParticipating_(member)) throw new Error("此會長未列入今年參加名單");
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
  const line = verifyLineIdentity_(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || !isParticipating_(member)) throw new Error("您未列入今年參加名單");
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
  const events = rows_(SHEETS.EVENTS);
  const openEvent = getOpenEvent_();
  const attendance = openEvent
    ? findRows_(SHEETS.ATTENDANCE, row => row.event_id === openEvent.event_id)
    : [];
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
    memberCount: members.filter(isParticipating_).length,
    totalMemberCount: members.length,
    notParticipatingCount: members.filter(member => !isParticipating_(member)).length,
    boundCount: members.filter(member => isParticipating_(member) && member.line_user_id).length,
    currentEvent: openEvent ? publicEvent_(openEvent) : null,
    events: events.map(event => ({
      event_id: event.event_id,
      event_date: event.event_date,
      name: event.name,
      status: event.status
    })),
    attendance: attendance.map(row => ({
      attendance_id: row.attendance_id,
      member_id: row.member_id,
      name: row.name_snapshot,
      club: row.club_snapshot,
      checkin_at: row.checkin_at,
      source: row.source
    })),
    members: members.map(member => ({
      member_id: member.member_id,
      zone: member.zone,
      division: member.division,
      club: member.club,
      name: member.name,
      masked_phone: maskPhone_(member.phone),
      participating: isParticipating_(member),
      bound: Boolean(member.line_user_id),
      line_display_name: member.line_display_name || ""
    }))
  };
}

function adminApproveBinding_(payload) {
  const requestId = cleanText_(payload.requestId, 40, "申請編號");
  const request = findOne_(SHEETS.BINDINGS, "request_id", requestId);
  if (!request || request.status !== "pending") throw new Error("找不到待確認申請");
  const member = findOne_(SHEETS.MEMBERS, "member_id", request.member_id);
  if (!member || !isParticipating_(member)) throw new Error("此會長未列入今年參加名單");
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

function adminCreateEvent_(payload) {
  const name = cleanText_(payload.name, 100, "活動名稱");
  const eventDate = cleanText_(payload.eventDate, 10, "活動日期");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error("活動日期格式不正確");
  const shouldOpen = payload.open !== false;
  if (shouldOpen) closeOpenEvents_();
  const eventId = id_("EV");
  append_(SHEETS.EVENTS, {
    event_id: eventId,
    event_date: eventDate,
    name,
    status: shouldOpen ? "open" : "closed",
    created_at: now_()
  });
  audit_("event_created", "admin", eventId, `${eventDate} ${name}`);
  return { message: shouldOpen ? "活動已建立並開放簽到" : "活動已建立" };
}

function adminSetEventStatus_(payload) {
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const status = String(payload.status || "");
  if (!["open", "closed"].includes(status)) throw new Error("活動狀態不正確");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  if (status === "open") closeOpenEvents_();
  updateRow_(SHEETS.EVENTS, event._row, { status });
  audit_("event_status_changed", "admin", eventId, status);
  return { message: status === "open" ? "活動已開放簽到" : "活動已關閉" };
}

function adminManualCheckIn_(payload) {
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const event = getOpenEvent_();
  if (!event) throw new Error("目前沒有開放簽到的活動");
  const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
  if (!member || !isParticipating_(member)) throw new Error("此會長未列入今年參加名單");
  const duplicate = findRows_(SHEETS.ATTENDANCE, row =>
    row.event_id === event.event_id && row.member_id === member.member_id
  )[0];
  if (duplicate) throw new Error("此會長已完成本場簽到");
  const attendanceId = id_("AT");
  append_(SHEETS.ATTENDANCE, {
    attendance_id: attendanceId,
    event_id: event.event_id,
    member_id: member.member_id,
    name_snapshot: member.name,
    club_snapshot: member.club,
    checkin_at: now_(),
    source: "ADMIN"
  });
  audit_("manual_check_in", "admin", member.member_id, event.event_id);
  return { message: `${member.name || member.club + "會會長"}，已由管理者完成簽到` };
}

function adminRemoveAttendance_(payload) {
  const attendanceId = cleanText_(payload.attendanceId, 80, "簽到編號");
  const attendance = findOne_(SHEETS.ATTENDANCE, "attendance_id", attendanceId);
  if (!attendance) throw new Error("找不到簽到紀錄");
  sheet_(SHEETS.ATTENDANCE).deleteRow(attendance._row);
  audit_("attendance_removed", "admin", attendance.member_id, attendanceId);
  return { message: "簽到紀錄已撤銷" };
}

function adminUpdateMemberPhone_(payload) {
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const phone = normalizePhone_(payload.phone);
  if (phone.length < 8 || phone.length > 15) throw new Error("完整電話格式不正確");
  const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
  if (!member) throw new Error("找不到會長資料");
  updateRow_(SHEETS.MEMBERS, member._row, { phone, updated_at: now_() });
  audit_("member_phone_updated", "admin", memberId, "phone updated");
  return { message: "電話已更新" };
}

function adminUnbindMember_(payload) {
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
  if (!member) throw new Error("找不到會長資料");
  if (!member.line_user_id) throw new Error("此會長尚未綁定 LINE");
  updateRow_(SHEETS.MEMBERS, member._row, {
    line_user_id: "",
    line_display_name: "",
    updated_at: now_()
  });
  audit_("member_unbound", "admin", memberId, member.line_user_id);
  return { message: "LINE 綁定已解除" };
}

function adminSetParticipation_(payload) {
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const participating = payload.participating === true;
  const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
  if (!member) throw new Error("找不到會長資料");
  updateRow_(SHEETS.MEMBERS, member._row, {
    status: participating ? "participating" : "not_participating",
    updated_at: now_()
  });
  audit_("participation_changed", "admin", memberId, participating ? "participating" : "not_participating");
  return { message: participating ? "已列為今年參加" : "已列為今年未參加" };
}

function adminAttendanceReport_(payload) {
  const members = rows_(SHEETS.MEMBERS).filter(isParticipating_);
  const events = rows_(SHEETS.EVENTS).sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const allAttendance = rows_(SHEETS.ATTENDANCE);
  const requestedEventId = String(payload.eventId || "");
  const selectedEvent = events.find(event => event.event_id === requestedEventId)
    || events.find(event => event.status === "open")
    || events[events.length - 1]
    || null;
  const selectedRecords = selectedEvent
    ? allAttendance.filter(record => record.event_id === selectedEvent.event_id)
    : [];
  const selectedByMember = {};
  selectedRecords.forEach(record => {
    if (!selectedByMember[record.member_id]) selectedByMember[record.member_id] = record;
  });
  const selectedEventMembers = members.map(member => {
    const record = selectedByMember[member.member_id];
    return {
      member_id: member.member_id,
      zone: member.zone,
      division: member.division,
      club: member.club,
      name: member.name,
      attended: Boolean(record),
      checkin_at: record ? record.checkin_at : "",
      source: record ? record.source : ""
    };
  });
  const eventIds = events.map(event => event.event_id);
  const uniqueAttendance = {};
  allAttendance.forEach(record => { uniqueAttendance[`${record.event_id}|${record.member_id}`] = true; });
  const memberSummary = members.map(member => {
    const attendedCount = eventIds.filter(eventId => uniqueAttendance[`${eventId}|${member.member_id}`]).length;
    const absentCount = Math.max(0, events.length - attendedCount);
    return {
      member_id: member.member_id,
      zone: member.zone,
      division: member.division,
      club: member.club,
      name: member.name,
      attended_count: attendedCount,
      absent_count: absentCount,
      attendance_rate: events.length ? Math.round(attendedCount / events.length * 1000) / 10 : 0,
      records: events.map(event => {
        const record = allAttendance.find(item => item.event_id === event.event_id && item.member_id === member.member_id);
        return {
          event_id: event.event_id,
          event_date: event.event_date,
          event_name: event.name,
          attended: Boolean(record),
          checkin_at: record ? record.checkin_at : "",
          source: record ? record.source : ""
        };
      })
    };
  });
  const attendanceCount = Object.keys(uniqueAttendance).filter(key => eventIds.includes(key.split("|")[0])).length;
  return {
    events: events.map(publicEvent_),
    selectedEvent: selectedEvent ? publicEvent_(selectedEvent) : null,
    selectedEventMembers,
    members: memberSummary,
    summary: {
      event_count: events.length,
      member_count: members.length,
      attendance_count: attendanceCount,
      average_attendance: events.length ? Math.round(attendanceCount / events.length * 10) / 10 : 0
    }
  };
}

function closeOpenEvents_() {
  findRows_(SHEETS.EVENTS, row => row.status === "open").forEach(event => {
    updateRow_(SHEETS.EVENTS, event._row, { status: "closed" });
  });
}

function expireStaleOpenEvents_() {
  const today = today_();
  findRows_(SHEETS.EVENTS, row => row.status === "open" && String(row.event_date || "") < today).forEach(event => {
    updateRow_(SHEETS.EVENTS, event._row, { status: "closed" });
    audit_("event_auto_closed", "system", event.event_id, `expired on ${today}`);
  });
}

function verifyLineIdentity_(payload) {
  const idToken = String((payload && payload.idToken) || "").trim();
  const accessToken = String((payload && payload.accessToken) || "").trim();
  if (idToken) {
    try {
      return verifyLineToken_(idToken);
    } catch (error) {
      if (String(error && error.message) !== "LINE 登入憑證無效或已過期" || !accessToken) throw error;
    }
  }
  if (accessToken) return verifyLineAccessToken_(accessToken);
  throw new Error("LINE 登入憑證無效或已過期，請重新開啟 LINE 簽到頁面");
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

function verifyLineAccessToken_(accessToken) {
  const token = cleanText_(accessToken, 3000, "LINE Access Token");
  const response = UrlFetchApp.fetch("https://api.line.me/v2/profile", {
    method: "get",
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error("LINE 登入憑證無效或已過期");
  const result = JSON.parse(response.getContentText());
  if (!result.userId) throw new Error("LINE 登入憑證驗證失敗");
  return {
    sub: result.userId,
    name: result.displayName || ""
  };
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

function isParticipating_(member) {
  const status = String((member && member.status) || "").trim();
  return status === "active" || status === "participating" || status === "";
}

function publicEvent_(event) {
  return { event_id: event.event_id, event_date: event.event_date, name: event.name };
}

function getOpenEvent_() {
  expireStaleOpenEvents_();
  const today = today_();
  return findRows_(SHEETS.EVENTS, row => row.status === "open" && row.event_date === today)[0] || null;
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

function today_() {
  return Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
