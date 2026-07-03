const SHEETS = Object.freeze({
  MEMBERS: "Members",
  BINDINGS: "BindingRequests",
  EVENTS: "Events",
  REGISTRATIONS: "EventRegistrations",
  ATTENDANCE: "Attendance",
  AUDIT: "AuditLogs"
});

const API_VERSION = "2526-presidents-2026-07-04-manual-checkin-open-12";

const DEFAULT_EVENT_TIME = "18:00";
const REGISTRATION_CUTOFF_MINUTES = 90;
const CHECKIN_OPEN_MINUTES = 60;

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
    if (Array.isArray(payload.events)) return json_({ ok: true, apiVersion: API_VERSION, ...handleLineWebhook_(payload) });
    return json_({ ok: true, apiVersion: API_VERSION, ...route_(payload) });
  } catch (error) {
    return json_({ ok: false, apiVersion: API_VERSION, error: error.message });
  }
}

function handleLineWebhook_(payload) {
  (payload.events || []).forEach(event => {
    if (!event.replyToken) return;
    if (event.type === "follow") {
      replyLineTextSafe_(event.replyToken, officialAccountHelpText_());
      return;
    }
    if (event.type === "message" && event.message && event.message.type === "text") {
      const text = String(event.message.text || "").trim();
      if (/報名|簽到|出席|活動|查詢|help|menu/i.test(text)) {
        replyLineTextSafe_(event.replyToken, officialAccountHelpText_());
      }
    }
  });
  return { message: "webhook accepted" };
}

function route_(payload) {
  const action = String(payload.action || "");
  const publicActions = {
    getSession: getSession_,
    getRoster: getRoster_,
    dashboard: dashboard_,
    requestBinding: requestBinding_,
    registerEvent: registerEvent_,
    cancelRegistration: cancelRegistration_,
    checkIn: checkIn_
  };
  const adminActions = {
    adminOverview: adminOverview_,
    adminApproveBinding: adminApproveBinding_,
    adminRejectBinding: adminRejectBinding_,
    adminCreateEvent: adminCreateEvent_,
    adminSetEventStatus: adminSetEventStatus_,
    adminSetEventGate: adminSetEventGate_,
    adminDeleteEvent: adminDeleteEvent_,
    adminManualCheckIn: adminManualCheckIn_,
    adminRemoveAttendance: adminRemoveAttendance_,
    adminUpdateMemberPhone: adminUpdateMemberPhone_,
    adminUnbindMember: adminUnbindMember_,
    adminSetParticipation: adminSetParticipation_,
    adminRegistrationReport: adminRegistrationReport_,
    adminLineStatus: adminLineStatus_,
    adminSendRegistrationInvite: adminSendRegistrationInvite_,
    adminSendEventReminder: adminSendEventReminder_,
    adminSendCheckinReminder: adminSendCheckinReminder_,
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
  expireStaleOpenEvents_();
  const line = verifyLineIdentity_(payload);
  const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
  const participating = Boolean(member && isParticipating_(member));
  const pending = findRows_(SHEETS.BINDINGS, row => row.line_user_id === line.sub && row.status === "pending").length > 0;
  const event = getOpenEvent_();
  const registrations = participating ? registrationRows_().filter(row =>
    row.member_id === member.member_id && row.status === "registered"
  ) : [];
  const registeredEventIds = {};
  registrations.forEach(row => { registeredEventIds[row.event_id] = true; });
  const alreadyCheckedIn = Boolean(participating && event && findRows_(SHEETS.ATTENDANCE, row =>
    row.event_id === event.event_id && row.member_id === member.member_id
  ).length);
  return {
    member: member ? publicMember_(member) : null,
    event: participating && event ? publicEvent_(event) : null,
    registrationEvents: participating ? getRegisterableEvents_().map(item => ({
      ...publicEvent_(item),
      registered: Boolean(registeredEventIds[item.event_id])
    })) : [],
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
  expireStaleOpenEvents_();
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
    notifyAdminsSafe_(`2526會長聯誼會待審核\n${member.club}｜${member.name || "姓名待補"}\n手機末四碼不符，請至後台身分審核。`);
    return { status: "pending", message: "末四碼未能核對，已交由管理者確認" };
  } finally {
    lock.releaseLock();
  }
}

function registerEvent_(payload) {
  const line = verifyLineIdentity_(payload);
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || !isParticipating_(member)) throw new Error("您未列入今年參加名單");
    const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
    if (!event) throw new Error("找不到活動");
    if (!isEventRegisterable_(event)) throw new Error("此活動已截止報名");
    const existing = registrationRows_().find(row =>
      row.event_id === eventId && row.member_id === member.member_id
    );
    if (existing && existing.status === "registered") throw new Error("您已完成此活動報名");
    if (existing) {
      updateRow_(SHEETS.REGISTRATIONS, existing._row, {
        name_snapshot: member.name,
        club_snapshot: member.club,
        status: "registered",
        registered_at: now_(),
        canceled_at: "",
        source: "LINE"
      });
    } else {
      append_(SHEETS.REGISTRATIONS, {
        registration_id: id_("RG"),
        event_id: event.event_id,
        member_id: member.member_id,
        name_snapshot: member.name,
        club_snapshot: member.club,
        status: "registered",
        registered_at: now_(),
        canceled_at: "",
        source: "LINE"
      });
    }
    audit_("event_registered", member.member_id, event.event_id, "LINE");
    pushLineTextSafe_(member.line_user_id, registrationConfirmationText_(event, member));
    notifyAdminsSafe_(`活動報名通知\n${event.event_date} ${event.name}\n${member.club}｜${member.name || "姓名待補"} 已報名。`);
    return { message: `${event.name} 報名成功` };
  } finally {
    lock.releaseLock();
  }
}

function cancelRegistration_(payload) {
  const line = verifyLineIdentity_(payload);
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || !isParticipating_(member)) throw new Error("您未列入今年參加名單");
    const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
    if (!event) throw new Error("找不到活動");
    if (!isEventRegisterable_(event)) throw new Error("此活動已截止取消報名");
    const existing = registrationRows_().find(row =>
      row.event_id === eventId && row.member_id === member.member_id && row.status === "registered"
    );
    if (!existing) throw new Error("尚未報名此活動");
    updateRow_(SHEETS.REGISTRATIONS, existing._row, {
      status: "canceled",
      canceled_at: now_()
    });
    audit_("event_registration_canceled", member.member_id, event.event_id, "LINE");
    pushLineTextSafe_(member.line_user_id, registrationCanceledText_(event, member));
    notifyAdminsSafe_(`活動報名取消\n${event.event_date} ${event.name}\n${member.club}｜${member.name || "姓名待補"} 已取消報名。`);
    return { message: `${event.name} 已取消報名` };
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
  expireStaleOpenEvents_();
  const members = rows_(SHEETS.MEMBERS);
  const events = eventRows_();
  const registrationCounts = eventRegistrationCounts_(registrationRows_());
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
    lineOfficial: lineStatusFromMembers_(members.filter(isParticipating_)),
    currentEvent: openEvent ? publicEvent_(openEvent) : null,
    events: events.map(event => ({
      event_id: event.event_id,
      event_date: event.event_date,
      event_time: eventTime_(event),
      name: event.name,
      status: event.status,
      registration_status: eventRegistrationStatus_(event),
      checkin_status: eventCheckinStatus_(event),
      registration_count: registrationCounts[event.event_id] || 0
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
  ensureEventColumns_();
  const name = cleanText_(payload.name, 100, "活動名稱");
  const eventDate = cleanText_(payload.eventDate, 10, "活動日期");
  const eventTime = cleanEventTime_(payload.eventTime || DEFAULT_EVENT_TIME);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error("活動日期格式不正確");
  const eventForTiming = { event_date: eventDate, event_time: eventTime };
  const shouldOpenRegistration = payload.registrationOpen !== false
    && nowDate_().getTime() < registrationDeadline_(eventForTiming).getTime();
  const shouldOpenCheckin = payload.checkinOpen !== false
    && nowDate_().getTime() <= eventCloseAt_(eventForTiming).getTime();
  if (shouldOpenCheckin) closeOpenEvents_();
  const eventId = id_("EV");
  append_(SHEETS.EVENTS, {
    event_id: eventId,
    event_date: eventDate,
    event_time: eventTime,
    name,
    status: shouldOpenCheckin ? "open" : "closed",
    registration_status: shouldOpenRegistration ? "open" : "closed",
    checkin_status: shouldOpenCheckin ? "open" : "closed",
    created_at: now_()
  });
  audit_("event_created", "admin", eventId, `${eventDate} ${eventTime} ${name}`);
  return { message: shouldOpenCheckin ? "活動已建立並開放簽到" : "活動已建立" };
}

function adminSetEventStatus_(payload) {
  ensureEventColumns_();
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const status = String(payload.status || "");
  if (!["open", "closed"].includes(status)) throw new Error("活動狀態不正確");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  if (status === "open") closeOpenEvents_();
  updateRow_(SHEETS.EVENTS, event._row, { status, checkin_status: status });
  audit_("event_status_changed", "admin", eventId, status);
  return { message: status === "open" ? "活動已開放簽到" : "活動已關閉" };
}

function adminSetEventGate_(payload) {
  ensureEventColumns_();
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const gate = String(payload.gate || "");
  const status = String(payload.status || "");
  if (!["registration", "checkin"].includes(gate)) throw new Error("活動開關類型不正確");
  if (!["open", "closed"].includes(status)) throw new Error("活動狀態不正確");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  if (gate === "registration" && status === "open" && nowDate_().getTime() >= registrationDeadline_(event).getTime()) {
    throw new Error("此活動已超過報名截止時間，無法重新開放報名");
  }
  if (gate === "checkin" && status === "open" && nowDate_().getTime() > eventCloseAt_(event).getTime()) {
    throw new Error("此活動已過期，無法重新開放簽到");
  }
  if (gate === "checkin" && status === "open") closeOpenEvents_();
  const changes = gate === "registration"
    ? { registration_status: status }
    : { checkin_status: status, status };
  updateRow_(SHEETS.EVENTS, event._row, changes);
  audit_("event_gate_changed", "admin", eventId, `${gate}:${status}`);
  if (gate === "registration") return { message: status === "open" ? "活動已開放報名" : "活動已關閉報名" };
  return { message: status === "open" ? "活動已開放簽到" : "活動已關閉簽到" };
}

function adminDeleteEvent_(payload) {
  ensureEventColumns_();
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  if (eventRegistrationStatus_(event) === "open" || eventCheckinStatus_(event) === "open") {
    throw new Error("請先關閉報名與簽到，再進行刪除");
  }

  const attendanceRows = findRows_(SHEETS.ATTENDANCE, row => row.event_id === eventId)
    .map(row => row._row)
    .sort((a, b) => b - a);
  const registrationRows = registrationRows_().filter(row => row.event_id === eventId)
    .map(row => row._row)
    .sort((a, b) => b - a);
  const registrationSheet = sheet_(SHEETS.REGISTRATIONS);
  const attendanceSheet = sheet_(SHEETS.ATTENDANCE);
  registrationRows.forEach(rowNumber => registrationSheet.deleteRow(rowNumber));
  attendanceRows.forEach(rowNumber => attendanceSheet.deleteRow(rowNumber));
  sheet_(SHEETS.EVENTS).deleteRow(event._row);
  audit_("event_deleted", "admin", eventId, `${event.event_date} ${event.name}; attendance=${attendanceRows.length}; registrations=${registrationRows.length}`);
  return { message: `活動已刪除，並移除 ${attendanceRows.length} 筆簽到紀錄、${registrationRows.length} 筆報名紀錄` };
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

function adminRegistrationReport_(payload) {
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  const memberById = {};
  rows_(SHEETS.MEMBERS).forEach(member => { memberById[member.member_id] = member; });
  const registrants = registrationRows_()
    .filter(row => row.event_id === eventId && row.status === "registered")
    .map(row => {
      const member = memberById[row.member_id] || {};
      return {
        registration_id: row.registration_id,
        member_id: row.member_id,
        zone: member.zone || "",
        division: member.division || "",
        club: row.club_snapshot || member.club || "",
        name: row.name_snapshot || member.name || "",
        registered_at: row.registered_at,
        source: row.source || "LINE"
      };
    })
    .sort((a, b) => compareMemberOrder_(a, b) || String(a.registered_at).localeCompare(String(b.registered_at)));
  return {
    event: publicEvent_(event),
    registrants,
    total: registrants.length
  };
}

function adminLineStatus_() {
  const members = rows_(SHEETS.MEMBERS).filter(isParticipating_);
  return lineStatusFromMembers_(members);
}

function lineStatusFromMembers_(members) {
  return {
    configured: Boolean(lineChannelAccessToken_()),
    boundCount: members.filter(member => member.line_user_id).length,
    checkinUrl: checkinUrl_(),
    note: "官方帳號推播需設定 LINE_CHANNEL_ACCESS_TOKEN，且會長需加入官方帳號。"
  };
}

function adminSendRegistrationInvite_(payload) {
  const event = requireEvent_(payload.eventId);
  if (!isEventRegisterable_(event)) throw new Error("此活動已過期，無法推播報名通知");
  const members = rows_(SHEETS.MEMBERS).filter(member => isParticipating_(member) && member.line_user_id);
  const message = registrationInviteText_(event);
  const result = multicastLineText_(members.map(member => member.line_user_id), message);
  audit_("line_registration_invite", "admin", event.event_id, `${result.sent} sent; ${result.skipped} skipped`);
  return { message: `已送出報名通知：${result.sent} 位，略過 ${result.skipped} 位` };
}

function adminSendEventReminder_(payload) {
  const event = requireEvent_(payload.eventId);
  const members = registeredMembersForEvent_(event.event_id);
  const result = multicastLineText_(members.map(member => member.line_user_id), eventReminderText_(event));
  audit_("line_event_reminder", "admin", event.event_id, `${result.sent} sent; ${result.skipped} skipped`);
  return { message: `已提醒已報名者：${result.sent} 位，略過 ${result.skipped} 位` };
}

function adminSendCheckinReminder_(payload) {
  const event = requireEvent_(payload.eventId);
  const attendanceIds = {};
  findRows_(SHEETS.ATTENDANCE, row => row.event_id === event.event_id)
    .forEach(row => { attendanceIds[row.member_id] = true; });
  const members = registeredMembersForEvent_(event.event_id)
    .filter(member => !attendanceIds[member.member_id]);
  const result = multicastLineText_(members.map(member => member.line_user_id), checkinReminderText_(event));
  audit_("line_checkin_reminder", "admin", event.event_id, `${result.sent} sent; ${result.skipped} skipped`);
  return { message: `已提醒未簽到者：${result.sent} 位，略過 ${result.skipped} 位` };
}

function sendTomorrowEventReminders() {
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 24 * 60 * 60 * 1000), "Asia/Taipei", "yyyy-MM-dd");
  const events = rows_(SHEETS.EVENTS).filter(event => event.event_date === tomorrow);
  let sent = 0;
  events.forEach(event => {
    const members = registeredMembersForEvent_(event.event_id);
    const result = multicastLineText_(members.map(member => member.line_user_id), eventReminderText_(event));
    sent += result.sent;
    audit_("line_tomorrow_event_reminder", "trigger", event.event_id, `${result.sent} sent; ${result.skipped} skipped`);
  });
  return { events: events.length, sent };
}

function sendTodayCheckinReminders() {
  const event = getOpenEvent_();
  if (!event) return { event: null, sent: 0 };
  const attendanceIds = {};
  findRows_(SHEETS.ATTENDANCE, row => row.event_id === event.event_id)
    .forEach(row => { attendanceIds[row.member_id] = true; });
  const members = registeredMembersForEvent_(event.event_id)
    .filter(member => !attendanceIds[member.member_id]);
  const result = multicastLineText_(members.map(member => member.line_user_id), checkinReminderText_(event));
  audit_("line_today_checkin_reminder", "trigger", event.event_id, `${result.sent} sent; ${result.skipped} skipped`);
  return { event: publicEvent_(event), sent: result.sent };
}

function adminAttendanceReport_(payload) {
  const members = rows_(SHEETS.MEMBERS).filter(isParticipating_);
  const events = eventRows_().sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
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
  eventRows_().filter(row => eventCheckinStatus_(row) === "open").forEach(event => {
    updateRow_(SHEETS.EVENTS, event._row, { status: "closed", checkin_status: "closed" });
  });
}

function eventRows_() {
  ensureEventColumns_();
  return rows_(SHEETS.EVENTS);
}

function ensureEventColumns_() {
  const sheet = sheet_(SHEETS.EVENTS);
  const required = ["event_time", "registration_status", "checkin_status"];
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0].map(String);
  let lastColumn = sheet.getLastColumn();
  required.forEach(header => {
    if (headers.includes(header)) return;
    lastColumn += 1;
    sheet.getRange(1, lastColumn).setValue(header);
    sheet.getRange(1, lastColumn).setFontWeight("bold").setFontColor("#ffffff").setBackground("#163f73");
  });
}

function registrationRows_() {
  ensureRegistrationSheet_();
  return rows_(SHEETS.REGISTRATIONS);
}

function ensureRegistrationSheet_() {
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(SHEETS.REGISTRATIONS);
  if (sheet) return;
  const headers = SCHEMA[SHEETS.REGISTRATIONS];
  if (!headers) throw new Error(`未定義資料表：${SHEETS.REGISTRATIONS}`);
  sheet = spreadsheet.insertSheet(SHEETS.REGISTRATIONS);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight("bold")
    .setFontColor("#ffffff")
    .setBackground("#163f73");
  sheet.autoResizeColumns(1, headers.length);
}

function getRegisterableEvents_() {
  expireStaleOpenEvents_();
  return eventRows_()
    .filter(isEventRegisterable_)
    .sort((a, b) => eventStart_(a).getTime() - eventStart_(b).getTime());
}

function isEventRegisterable_(event) {
  if (!event || !event.event_date) return false;
  if (eventRegistrationStatus_(event) !== "open") return false;
  return nowDate_().getTime() < registrationDeadline_(event).getTime();
}

function eventRegistrationStatus_(event) {
  return String(event.registration_status || "open");
}

function eventCheckinStatus_(event) {
  return String(event.checkin_status || event.status || "closed");
}

function eventTime_(event) {
  return cleanEventTime_((event && event.event_time) || DEFAULT_EVENT_TIME);
}

function cleanEventTime_(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return DEFAULT_EVENT_TIME;
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error("活動時間格式不正確，請使用 HH:mm");
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function eventStart_(event) {
  const date = String((event && event.event_date) || "");
  const time = eventTime_(event);
  const parsed = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("活動日期或時間格式不正確");
  return parsed;
}

function registrationDeadline_(event) {
  return new Date(eventStart_(event).getTime() - REGISTRATION_CUTOFF_MINUTES * 60 * 1000);
}

function checkinOpenAt_(event) {
  return new Date(eventStart_(event).getTime() - CHECKIN_OPEN_MINUTES * 60 * 1000);
}

function eventCloseAt_(event) {
  const parsed = new Date(`${event.event_date}T23:59:59+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("活動日期格式不正確");
  return parsed;
}

function nowDate_() {
  return new Date();
}

function isCheckinAvailable_(event) {
  if (!event || !event.event_date) return false;
  if (eventCheckinStatus_(event) !== "open") return false;
  const now = nowDate_().getTime();
  return now <= eventCloseAt_(event).getTime();
}

function eventRegistrationCounts_(registrations) {
  const counts = {};
  registrations.forEach(row => {
    if (row.status !== "registered") return;
    counts[row.event_id] = (counts[row.event_id] || 0) + 1;
  });
  return counts;
}

function registeredMembersForEvent_(eventId) {
  const memberById = {};
  rows_(SHEETS.MEMBERS).filter(isParticipating_).forEach(member => {
    if (member.line_user_id) memberById[member.member_id] = member;
  });
  const seen = {};
  return registrationRows_()
    .filter(row => row.event_id === eventId && row.status === "registered" && memberById[row.member_id])
    .filter(row => {
      if (seen[row.member_id]) return false;
      seen[row.member_id] = true;
      return true;
    })
    .map(row => memberById[row.member_id]);
}

function requireEvent_(eventId) {
  const event = findOne_(SHEETS.EVENTS, "event_id", cleanText_(eventId, 60, "活動編號"));
  if (!event) throw new Error("找不到活動");
  return event;
}

function compareMemberOrder_(a, b) {
  return String(a.zone || "").localeCompare(String(b.zone || ""), "zh-Hant", { numeric: true })
    || String(a.division || "").localeCompare(String(b.division || ""), "zh-Hant", { numeric: true })
    || String(a.club || "").localeCompare(String(b.club || ""), "zh-Hant", { numeric: true })
    || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant", { numeric: true });
}

function lineChannelAccessToken_() {
  return PropertiesService.getScriptProperties().getProperty("LINE_CHANNEL_ACCESS_TOKEN") || "";
}

function checkinUrl_() {
  return PropertiesService.getScriptProperties().getProperty("CHECKIN_URL") || "https://liff.line.me/2010452724-MvUou0rS";
}

function adminLineUserIds_() {
  return String(PropertiesService.getScriptProperties().getProperty("ADMIN_LINE_USER_IDS") || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function registrationInviteText_(event) {
  return [
    "2526會長聯誼會活動報名",
    `${event.event_date} ${event.name}`,
    "活動已開放報名，請點下方連結完成報名或取消報名：",
    checkinUrl_()
  ].join("\n");
}

function registrationConfirmationText_(event, member) {
  return [
    `${member.name || member.club + "會會長"}您好，您已完成活動報名。`,
    `${event.event_date} ${event.name}`,
    "如需取消報名，請回到活動頁操作：",
    checkinUrl_()
  ].join("\n");
}

function registrationCanceledText_(event, member) {
  return [
    `${member.name || member.club + "會會長"}您好，您已取消活動報名。`,
    `${event.event_date} ${event.name}`,
    "如需重新報名，請回到活動頁操作：",
    checkinUrl_()
  ].join("\n");
}

function eventReminderText_(event) {
  return [
    "2526會長聯誼會活動提醒",
    `您已報名：${event.event_date} ${event.name}`,
    "請記得準時出席。活動當天可由下方連結完成簽到：",
    checkinUrl_()
  ].join("\n");
}

function checkinReminderText_(event) {
  return [
    "2526會長聯誼會簽到提醒",
    `${event.event_date} ${event.name}`,
    "系統尚未看到您的簽到紀錄，請點下方連結完成簽到：",
    checkinUrl_()
  ].join("\n");
}

function officialAccountHelpText_() {
  return [
    "2526會長聯誼會服務中心",
    "可由下方連結進行活動報名、取消報名與當日簽到：",
    checkinUrl_(),
    "",
    "首次使用請先完成 LINE 身分綁定。"
  ].join("\n");
}

function pushLineTextSafe_(lineUserId, text) {
  try {
    if (!lineUserId || !lineChannelAccessToken_()) return;
    pushLineText_(lineUserId, text);
  } catch (error) {
    audit_("line_push_failed", "system", lineUserId || "", error.message);
  }
}

function replyLineTextSafe_(replyToken, text) {
  try {
    if (!replyToken || !lineChannelAccessToken_()) return;
    lineFetch_("/v2/bot/message/reply", {
      replyToken,
      messages: [{ type: "text", text: cleanText_(text, 5000, "訊息內容") }]
    });
  } catch (error) {
    audit_("line_reply_failed", "system", replyToken || "", error.message);
  }
}

function notifyAdminsSafe_(text) {
  const ids = adminLineUserIds_();
  if (!ids.length || !lineChannelAccessToken_()) return;
  try {
    multicastLineText_(ids, text);
  } catch (error) {
    audit_("line_admin_notify_failed", "system", "ADMIN_LINE_USER_IDS", error.message);
  }
}

function pushLineText_(lineUserId, text) {
  return lineFetch_("/v2/bot/message/push", {
    to: lineUserId,
    messages: [{ type: "text", text: cleanText_(text, 5000, "訊息內容") }]
  });
}

function multicastLineText_(lineUserIds, text) {
  const uniqueIds = Array.from(new Set(lineUserIds.filter(Boolean)));
  if (!lineChannelAccessToken_()) throw new Error("尚未設定 LINE_CHANNEL_ACCESS_TOKEN");
  const skipped = lineUserIds.length - uniqueIds.length;
  let sent = 0;
  for (let index = 0; index < uniqueIds.length; index += 500) {
    const chunk = uniqueIds.slice(index, index + 500);
    if (!chunk.length) continue;
    lineFetch_("/v2/bot/message/multicast", {
      to: chunk,
      messages: [{ type: "text", text: cleanText_(text, 5000, "訊息內容") }]
    });
    sent += chunk.length;
  }
  return { sent, skipped };
}

function lineFetch_(path, payload) {
  const response = UrlFetchApp.fetch(`https://api.line.me${path}`, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${lineChannelAccessToken_()}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`LINE 推播失敗 (${code})：${response.getContentText()}`);
  }
  return response;
}

function expireStaleOpenEvents_() {
  ensureEventColumns_();
  const now = nowDate_().getTime();
  rows_(SHEETS.EVENTS).forEach(event => {
    if (!event.event_id || !event.event_date) return;
    const changes = {};
    if (eventRegistrationStatus_(event) === "open" && now >= registrationDeadline_(event).getTime()) {
      changes.registration_status = "closed";
    }
    if (eventCheckinStatus_(event) === "open" && now > eventCloseAt_(event).getTime()) {
      changes.status = "closed";
      changes.checkin_status = "closed";
    }
    if (!Object.keys(changes).length) return;
    updateRow_(SHEETS.EVENTS, event._row, changes);
    audit_("event_auto_closed", "system", event.event_id, JSON.stringify(changes));
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
  return { event_id: event.event_id, event_date: event.event_date, event_time: eventTime_(event), name: event.name };
}

function getOpenEvent_() {
  expireStaleOpenEvents_();
  return eventRows_()
    .filter(isCheckinAvailable_)
    .sort((a, b) => eventStart_(a).getTime() - eventStart_(b).getTime())[0] || null;
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
  const sheet = sheet_(name);
  const fallbackHeaders = SCHEMA[name];
  if (!fallbackHeaders) throw new Error(`未定義資料表：${name}`);
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), fallbackHeaders.length)).getDisplayValues()[0]
    .map(String)
    .filter(Boolean);
  if (!headers) throw new Error(`未定義資料表：${name}`);
  sheet.appendRow(headers.map(header => data[header] == null ? "" : data[header]));
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
