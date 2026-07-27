const SHEETS = Object.freeze({
  MEMBERS: "Members",
  BINDINGS: "BindingRequests",
  EVENTS: "Events",
  REGISTRATIONS: "EventRegistrations",
  ATTENDANCE: "Attendance",
  LINE_GROUPS: "LineGroups",
  AUDIT: "AuditLogs"
});

const CODE_SCHEMA = Object.freeze({
  Members: ["member_id", "zone", "division", "club", "name", "birthday", "phone", "role", "status", "line_user_id", "line_display_name", "updated_at"],
  BindingRequests: ["request_id", "member_id", "line_user_id", "line_display_name", "provided_birthday", "provided_last4", "status", "created_at", "resolved_at", "resolved_by"],
  Events: ["event_id", "event_date", "event_time", "name", "status", "registration_status", "checkin_status", "created_at"],
  EventRegistrations: ["registration_id", "event_id", "member_id", "name_snapshot", "club_snapshot", "status", "registered_at", "canceled_at", "source"],
  Attendance: ["attendance_id", "event_id", "member_id", "name_snapshot", "club_snapshot", "checkin_at", "source"],
  LineGroups: ["group_id", "group_name", "group_type", "status", "bound_by_user_id", "created_at", "updated_at"],
  AuditLogs: ["log_id", "action", "actor", "target", "details", "created_at"]
});

const PRESIDENTS_API_VERSION = "2526-presidents-2026-07-28-target-line-groups-29";

const DEFAULT_EVENT_TIME = "18:00";
const REGISTRATION_CUTOFF_MINUTES = 90;
const CHECKIN_OPEN_MINUTES = 60;

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action !== "health") throw new Error("不支援的 GET 操作");
    return json_({ ok: true, apiVersion: PRESIDENTS_API_VERSION, spreadsheetConfigured: Boolean(spreadsheetId_()) });
  } catch (error) {
    return json_({ ok: false, apiVersion: PRESIDENTS_API_VERSION, error: error.message });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (Array.isArray(payload.events)) return json_({ ok: true, apiVersion: PRESIDENTS_API_VERSION, ...handleLineWebhook_(payload) });
    return json_({ ok: true, apiVersion: PRESIDENTS_API_VERSION, ...route_(payload) });
  } catch (error) {
    return json_({ ok: false, apiVersion: PRESIDENTS_API_VERSION, error: error.message });
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
      const command = parseLineCommand_(text);
      if (!command) return;
      if (/^綁定群組(?:\s+(.+))?$/i.test(command)) {
        replyLineTextSafe_(event.replyToken, bindLineGroupFromEvent_(event, command));
        return;
      }
      if (/^解除群組$/i.test(command)) {
        replyLineTextSafe_(event.replyToken, disableLineGroupFromEvent_(event));
        return;
      }
      if (/^本月壽星$/.test(command)) {
        replyLineTextSafe_(event.replyToken, monthlyBirthdayText_());
        return;
      }
      if (/^功能$/i.test(command)) {
        replyLineTextSafe_(event.replyToken, officialCommandListText_());
        return;
      }
      if (/^活動$/i.test(command)) {
        replyLineTextSafe_(event.replyToken, officialAccountHelpText_());
      }
    }
  });
  return { message: "webhook accepted" };
}

function parseLineCommand_(text) {
  const raw = String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!/^[＠@]/.test(raw)) return "";
  const direct = raw.replace(/^[＠@]\s*/, "").trim();
  const withoutMention = direct.replace(/^[^\s　]+[\s　]+/, "").trim();
  const candidates = [direct, withoutMention].filter(Boolean);
  const exactPatterns = [
    /^綁定群組(?:\s+(.+))?$/i,
    /^解除群組$/i,
    /^本月壽星$/,
    /^功能$/i,
    /^活動$/i
  ];
  return candidates.find(command => exactPatterns.some(pattern => pattern.test(command))) || "";
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
    adminBackfillAttendance: adminBackfillAttendance_,
    adminManualCheckIn: adminManualCheckIn_,
    adminRemoveAttendance: adminRemoveAttendance_,
    adminUpdateMemberPhone: adminUpdateMemberPhone_,
    adminUnbindMember: adminUnbindMember_,
    adminSetParticipation: adminSetParticipation_,
    adminSetBulkParticipation: adminSetBulkParticipation_,
    adminRegistrationReport: adminRegistrationReport_,
    adminLineStatus: adminLineStatus_,
    adminSendGroupRegistrationInvite: adminSendGroupRegistrationInvite_,
    adminSendGroupEventReminder: adminSendGroupEventReminder_,
    adminSendGroupCheckinReminder: adminSendGroupCheckinReminder_,
    adminSetLineGroupStatus: adminSetLineGroupStatus_,
    adminDeleteLineGroup: adminDeleteLineGroup_,
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
  const auth = memberAuthFromPayload_(payload, { allowMissing: true });
  const member = auth.member;
  const participating = Boolean(member && isParticipating_(member));
  const pending = Boolean(auth.line && findRows_(SHEETS.BINDINGS, row => row.line_user_id === auth.line.sub && row.status === "pending").length > 0);
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
    alreadyCheckedIn,
    authMode: auth.source || ""
  };
}

function getRoster_() {
  return {
    members: memberRows_()
      .filter(isParticipating_)
      .map(publicMember_)
  };
}

function dashboard_() {
  expireStaleOpenEvents_();
  const event = getOpenEvent_();
  const members = memberRows_().filter(isParticipating_);
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
  ensureSheet_(SHEETS.BINDINGS);
  const line = verifyLineIdentity_(payload);
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const birthday = normalizeBirthday_(payload.birthday);
  if (!birthday) throw new Error("生日格式不正確，請輸入月日，例如 7/27 或 0727");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (findMemberByLineUserId_(line.sub)) throw new Error("此 LINE 帳號已綁定人員資料");
    const member = findMemberById_(memberId);
    if (!member || !isParticipating_(member)) throw new Error("此人員未列入今年參加名單");
    if (member.line_user_id) throw new Error("此人員資料已綁定其他 LINE 帳號，請聯絡管理者");
    const existing = findRows_(SHEETS.BINDINGS, row => row.line_user_id === line.sub && row.status === "pending")[0];
    if (existing) return { status: "pending", message: "申請已送出，請等待管理者確認" };

    if (birthdayMatchesMember_(member, birthday)) {
      updateRow_(SHEETS.MEMBERS, member._row, {
        line_user_id: line.sub,
        line_display_name: cleanText_(line.name || "", 80),
        updated_at: now_()
      });
      audit_("binding_auto_approved", line.sub, member.member_id, "birthday matched");
      return { status: "approved", message: "身分核對成功，LINE 已完成綁定" };
    }

    append_(SHEETS.BINDINGS, {
      request_id: id_("BR"),
      member_id: member.member_id,
      line_user_id: line.sub,
      line_display_name: cleanText_(line.name || "", 80),
      provided_birthday: birthday,
      provided_last4: "",
      status: "pending",
      created_at: now_(),
      resolved_at: "",
      resolved_by: ""
    });
    audit_("binding_requested", line.sub, member.member_id, "birthday mismatch");
    notifyAdminsSafe_(`2526會長聯誼會待審核\n${member.club}｜${member.name || "姓名待補"}\n生日核對不符，請至後台身分審核。`);
    return { status: "pending", message: "生日未能核對，已交由管理者確認" };
  } finally {
    lock.releaseLock();
  }
}

function registerEvent_(payload) {
  const auth = memberAuthFromPayload_(payload);
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = auth.member;
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
        source: auth.source
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
        source: auth.source
      });
    }
    audit_("event_registered", member.member_id, event.event_id, auth.source);
    pushLineTextSafe_(member.line_user_id, registrationConfirmationText_(event, member));
    notifyAdminsSafe_(`活動報名通知\n${event.event_date} ${event.name}\n${member.club}｜${member.name || "姓名待補"} 已報名。`);
    return { message: `${event.name} 報名成功` };
  } finally {
    lock.releaseLock();
  }
}

function cancelRegistration_(payload) {
  const auth = memberAuthFromPayload_(payload);
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = auth.member;
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
    audit_("event_registration_canceled", member.member_id, event.event_id, auth.source);
    pushLineTextSafe_(member.line_user_id, registrationCanceledText_(event, member));
    notifyAdminsSafe_(`活動報名取消\n${event.event_date} ${event.name}\n${member.club}｜${member.name || "姓名待補"} 已取消報名。`);
    return { message: `${event.name} 已取消報名` };
  } finally {
    lock.releaseLock();
  }
}

function checkIn_(payload) {
  const auth = memberAuthFromPayload_(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const member = auth.member;
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
      source: auth.source
    });
    audit_("check_in", member.member_id, event.event_id, auth.source);
    return { message: `${member.name || member.club + "會會長"}，簽到成功！` };
  } finally {
    lock.releaseLock();
  }
}

function adminOverview_() {
  expireStaleOpenEvents_();
  ensureSheet_(SHEETS.BINDINGS);
  const members = memberRows_();
  const events = eventRows_();
  const registrationCounts = eventRegistrationCounts_(registrationRows_());
  const attendanceCounts = eventAttendanceCounts_(rows_(SHEETS.ATTENDANCE));
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
      provided_birthday: request.provided_birthday || request.provided_last4 || "",
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
      registration_count: registrationCounts[event.event_id] || 0,
      attendance_count: attendanceCounts[event.event_id] || 0
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
      birthday: birthdayForMember_(member),
      role: memberRole_(member),
      masked_phone: maskPhone_(member.phone),
      participating: isParticipating_(member),
      bound: Boolean(member.line_user_id),
      line_user_id: member.line_user_id || "",
      line_display_name: member.line_display_name || ""
    }))
  };
}

function adminApproveBinding_(payload) {
  ensureSheet_(SHEETS.BINDINGS);
  const requestId = cleanText_(payload.requestId, 40, "申請編號");
  const request = findOne_(SHEETS.BINDINGS, "request_id", requestId);
  if (!request || request.status !== "pending") throw new Error("找不到待確認申請");
  const member = findMemberById_(request.member_id);
  if (!member || !isParticipating_(member)) throw new Error("此人員未列入今年參加名單");
  if (member.line_user_id && member.line_user_id !== request.line_user_id) throw new Error("此人員已綁定其他 LINE 帳號");
  const lineOwner = findMemberByLineUserId_(request.line_user_id);
  if (lineOwner && lineOwner.member_id !== member.member_id) throw new Error("此 LINE 帳號已綁定其他人員");

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
  ensureSheet_(SHEETS.BINDINGS);
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
  const member = findMemberById_(memberId);
  if (!member || !isParticipating_(member)) throw new Error("此人員未列入今年參加名單");
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

function adminBackfillAttendance_(payload) {
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const memberId = cleanText_(payload.memberId, 30, "人員編號");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  const member = findMemberById_(memberId);
  if (!member || !isParticipating_(member)) throw new Error("此人員未列入今年參加名單");
  const duplicate = findRows_(SHEETS.ATTENDANCE, row =>
    row.event_id === event.event_id && row.member_id === member.member_id
  )[0];
  if (duplicate) throw new Error("此人員已完成該活動簽到，無法重複補登");
  const checkinAt = cleanBackfillCheckinAt_(payload.checkinAt, event);
  append_(SHEETS.ATTENDANCE, {
    attendance_id: id_("AT"),
    event_id: event.event_id,
    member_id: member.member_id,
    name_snapshot: member.name,
    club_snapshot: member.club,
    checkin_at: checkinAt,
    source: "ADMIN_BACKFILL"
  });
  audit_("attendance_backfilled", "admin", member.member_id, `${event.event_id}; ${checkinAt}`);
  return { message: `${event.name} 已補登 ${member.club}｜${member.name || "姓名待補"} 出席紀錄` };
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
  const member = findMemberById_(memberId);
  if (!member) throw new Error("找不到人員資料");
  updateRow_(SHEETS.MEMBERS, member._row, { phone, updated_at: now_() });
  audit_("member_phone_updated", "admin", memberId, "phone updated");
  return { message: "電話已更新" };
}

function adminUnbindMember_(payload) {
  const memberId = cleanText_(payload.memberId, 30, "會長編號");
  const member = findMemberById_(memberId);
  if (!member) throw new Error("找不到人員資料");
  if (!member.line_user_id) throw new Error("此人員尚未綁定 LINE");
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
  const member = findMemberById_(memberId);
  if (!member) throw new Error("找不到人員資料");
  updateRow_(SHEETS.MEMBERS, member._row, {
    status: participating ? "participating" : "not_participating",
    updated_at: now_()
  });
  audit_("participation_changed", "admin", memberId, participating ? "participating" : "not_participating");
  return { message: participating ? "已列為今年參加" : "已列為今年未參加" };
}

function adminSetBulkParticipation_(payload) {
  const memberIds = Array.isArray(payload.memberIds) ? payload.memberIds : [];
  const participating = payload.participating === true;
  const uniqueIds = Array.from(new Set(memberIds.map(id => cleanText_(id, 30, "會長編號")).filter(Boolean)));
  if (!uniqueIds.length) throw new Error("請先選擇會長");
  const members = memberRows_();
  const memberById = {};
  members.forEach(member => { memberById[member.member_id] = member; });
  let updated = 0;
  uniqueIds.forEach(memberId => {
    const member = memberById[memberId];
    if (!member) return;
    updateRow_(SHEETS.MEMBERS, member._row, {
      status: participating ? "participating" : "not_participating",
      updated_at: now_()
    });
    updated += 1;
  });
  audit_("bulk_participation_changed", "admin", `${updated} members`, participating ? "participating" : "not_participating");
  return { message: `已批次更新 ${updated} 位會長為${participating ? "今年參加" : "今年未參加"}` };
}

function adminRegistrationReport_(payload) {
  const eventId = cleanText_(payload.eventId, 60, "活動編號");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到活動");
  const memberById = {};
  memberRows_().forEach(member => { memberById[member.member_id] = member; });
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
  const members = memberRows_().filter(isParticipating_);
  return lineStatusFromMembers_(members);
}

function lineStatusFromMembers_(members) {
  const groups = lineGroupRows_();
  return {
    configured: Boolean(lineChannelAccessToken_()),
    boundCount: members.filter(member => member.line_user_id).length,
    groups: groups.map(publicLineGroup_),
    enabledGroupCount: groups.filter(group => lineGroupStatus_(group) === "enabled").length,
    checkinUrl: checkinUrl_(),
    note: "官方帳號推播需設定 LINE_CHANNEL_ACCESS_TOKEN。活動推播僅發送至已啟用的 LINE 群組；群組需先加入官方帳號並完成綁定。"
  };
}

function adminSendGroupRegistrationInvite_(payload) {
  const event = requireEvent_(payload.eventId);
  if (!isEventRegisterable_(event)) throw new Error("此活動已過期，無法推播報名通知");
  const result = pushLineGroupsText_(targetLineGroupIds_(payload), registrationInviteText_(event));
  audit_("line_group_registration_invite", "admin", event.event_id, `${result.sent} groups; ${result.skipped} skipped`);
  return { message: `已送出群組報名通知：${result.sent} 個群組，略過 ${result.skipped} 個` };
}

function adminSendGroupEventReminder_(payload) {
  const event = requireEvent_(payload.eventId);
  const result = pushLineGroupsText_(targetLineGroupIds_(payload), groupEventReminderText_(event));
  audit_("line_group_event_reminder", "admin", event.event_id, `${result.sent} groups; ${result.skipped} skipped`);
  return { message: `已送出群組活動提醒：${result.sent} 個群組，略過 ${result.skipped} 個` };
}

function adminSendGroupCheckinReminder_(payload) {
  const event = requireEvent_(payload.eventId);
  const result = pushLineGroupsText_(targetLineGroupIds_(payload), groupCheckinReminderText_(event));
  audit_("line_group_checkin_reminder", "admin", event.event_id, `${result.sent} groups; ${result.skipped} skipped`);
  return { message: `已送出群組簽到提醒：${result.sent} 個群組，略過 ${result.skipped} 個` };
}

function adminSetLineGroupStatus_(payload) {
  ensureLineGroupsSheet_();
  const groupId = cleanText_(payload.groupId, 120, "群組 ID");
  const status = String(payload.status || "");
  if (!["enabled", "disabled"].includes(status)) throw new Error("群組狀態不正確");
  const group = findOne_(SHEETS.LINE_GROUPS, "group_id", groupId);
  if (!group) throw new Error("找不到 LINE 群組");
  updateRow_(SHEETS.LINE_GROUPS, group._row, { status, updated_at: now_() });
  audit_("line_group_status_changed", "admin", groupId, status);
  return { message: status === "enabled" ? "群組已啟用" : "群組已停用" };
}

function adminDeleteLineGroup_(payload) {
  ensureLineGroupsSheet_();
  const groupId = cleanText_(payload.groupId, 120, "群組 ID");
  const group = findOne_(SHEETS.LINE_GROUPS, "group_id", groupId);
  if (!group) throw new Error("找不到 LINE 群組");
  sheet_(SHEETS.LINE_GROUPS).deleteRow(group._row);
  audit_("line_group_deleted", "admin", groupId, group.group_name || "");
  return { message: "群組已刪除" };
}

function sendTomorrowEventReminders() {
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 24 * 60 * 60 * 1000), "Asia/Taipei", "yyyy-MM-dd");
  const events = rows_(SHEETS.EVENTS).filter(event => event.event_date === tomorrow);
  let sent = 0;
  events.forEach(event => {
    const result = pushLineGroupsText_(enabledLineGroupIds_(), groupEventReminderText_(event));
    sent += result.sent;
    audit_("line_group_tomorrow_event_reminder", "trigger", event.event_id, `${result.sent} groups; ${result.skipped} skipped`);
  });
  return { events: events.length, sent };
}

function sendTodayCheckinReminders() {
  const event = getOpenEvent_();
  if (!event) return { event: null, sent: 0 };
  const result = pushLineGroupsText_(enabledLineGroupIds_(), groupCheckinReminderText_(event));
  audit_("line_group_today_checkin_reminder", "trigger", event.event_id, `${result.sent} groups; ${result.skipped} skipped`);
  return { event: publicEvent_(event), sent: result.sent };
}

function adminAttendanceReport_(payload) {
  const members = memberRows_().filter(isParticipating_);
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
  const headers = CODE_SCHEMA[SHEETS.REGISTRATIONS];
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

function lineGroupRows_() {
  ensureLineGroupsSheet_();
  return rows_(SHEETS.LINE_GROUPS);
}

function ensureLineGroupsSheet_() {
  ensureSheet_(SHEETS.LINE_GROUPS);
}

function memberRows_() {
  ensureSheet_(SHEETS.MEMBERS);
  return rows_(SHEETS.MEMBERS);
}

function findMemberById_(memberId) {
  const id = String(memberId || "");
  return memberRows_().find(row => String(row.member_id) === id) || null;
}

function findMemberByLineUserId_(lineUserId) {
  const id = String(lineUserId || "");
  if (!id) return null;
  return memberRows_().find(row => String(row.line_user_id) === id) || null;
}

function ensureSheet_(name) {
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(name);
  const headers = CODE_SCHEMA[name];
  if (!headers) throw new Error(`未定義資料表：${name}`);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setFontColor("#ffffff")
      .setBackground("#163f73");
    sheet.autoResizeColumns(1, headers.length);
    return sheet;
  }
  const existingHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0].map(String);
  let lastColumn = sheet.getLastColumn();
  headers.forEach(header => {
    if (existingHeaders.includes(header)) return;
    lastColumn += 1;
    sheet.getRange(1, lastColumn).setValue(header);
    sheet.getRange(1, lastColumn).setFontWeight("bold").setFontColor("#ffffff").setBackground("#163f73");
  });
  return sheet;
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

function cleanBackfillCheckinAt_(value, event) {
  const text = String(value == null ? "" : value).trim();
  const fallback = eventStart_(event);
  if (!text) return fallback.toISOString();
  const normalized = text.replace(" ", "T");
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error("補登簽到時間格式不正確");
  const parsed = new Date(`${match[1]}T${match[2]}:${match[3]}:00+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("補登簽到時間格式不正確");
  return parsed.toISOString();
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

function eventAttendanceCounts_(attendanceRows) {
  const seen = {};
  const counts = {};
  attendanceRows.forEach(row => {
    const key = `${row.event_id}|${row.member_id}`;
    if (!row.event_id || !row.member_id || seen[key]) return;
    seen[key] = true;
    counts[row.event_id] = (counts[row.event_id] || 0) + 1;
  });
  return counts;
}

function registeredMembersForEvent_(eventId) {
  const memberById = {};
  memberRows_().filter(isParticipating_).forEach(member => {
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

function bindLineGroupFromEvent_(event, text) {
  const source = (event && event.source) || {};
  const groupId = source.groupId || source.roomId || "";
  const groupType = source.type || "";
  if (!groupId || !["group", "room"].includes(groupType)) {
    return "請在要綁定的 LINE 群組裡輸入：＠綁定群組 群組名稱";
  }
  const match = String(text || "").trim().match(/^綁定群組(?:\s+(.+))?$/i);
  const providedName = match && match[1] ? cleanText_(match[1], 80, "群組名稱") : "";
  const summary = lineGroupSummarySafe_(groupId, groupType);
  const groupName = providedName || summary.name || (groupType === "room" ? "未命名多人聊天室" : "未命名群組");
  upsertLineGroup_(groupId, groupName, groupType, source.userId || "");
  return [
    "LINE 群組已綁定",
    `名稱：${groupName}`,
    `用途：活動報名、活動提醒、簽到提醒群組推播`,
    "",
    "之後可在後台「活動管理」查看、停用或刪除這個群組。"
  ].join("\n");
}

function disableLineGroupFromEvent_(event) {
  const source = (event && event.source) || {};
  const groupId = source.groupId || source.roomId || "";
  if (!groupId) return "請在已綁定的 LINE 群組裡輸入：＠解除群組";
  ensureLineGroupsSheet_();
  const group = findOne_(SHEETS.LINE_GROUPS, "group_id", groupId);
  if (!group) return "這個群組尚未綁定。";
  updateRow_(SHEETS.LINE_GROUPS, group._row, { status: "disabled", updated_at: now_() });
  audit_("line_group_disabled_by_command", source.userId || "group", groupId, group.group_name || "");
  return "此 LINE 群組已停用，後台不會再推播到這個群組。";
}

function upsertLineGroup_(groupId, groupName, groupType, boundByUserId) {
  ensureLineGroupsSheet_();
  const existing = findOne_(SHEETS.LINE_GROUPS, "group_id", groupId);
  const values = {
    group_name: groupName,
    group_type: groupType,
    status: "enabled",
    bound_by_user_id: boundByUserId || "",
    updated_at: now_()
  };
  if (existing) {
    updateRow_(SHEETS.LINE_GROUPS, existing._row, values);
    audit_("line_group_rebound", boundByUserId || "group", groupId, groupName);
    return;
  }
  append_(SHEETS.LINE_GROUPS, {
    group_id: groupId,
    ...values,
    created_at: now_()
  });
  audit_("line_group_bound", boundByUserId || "group", groupId, groupName);
}

function lineGroupSummarySafe_(groupId, groupType) {
  try {
    if (!lineChannelAccessToken_() || groupType !== "group") return {};
    const response = lineGet_(`/v2/bot/group/${encodeURIComponent(groupId)}/summary`);
    const summary = JSON.parse(response.getContentText());
    return { name: summary.groupName || "", pictureUrl: summary.pictureUrl || "" };
  } catch (error) {
    audit_("line_group_summary_failed", "system", groupId, error.message);
    return {};
  }
}

function publicLineGroup_(group) {
  return {
    group_id: group.group_id,
    group_name: group.group_name || "未命名群組",
    group_type: group.group_type || "group",
    status: lineGroupStatus_(group),
    bound_by_user_id: group.bound_by_user_id || "",
    created_at: group.created_at || "",
    updated_at: group.updated_at || ""
  };
}

function lineGroupStatus_(group) {
  return String((group && group.status) || "enabled");
}

function enabledLineGroupIds_() {
  const groups = lineGroupRows_().filter(group => lineGroupStatus_(group) === "enabled");
  if (!groups.length) throw new Error("尚未綁定任何啟用中的 LINE 群組");
  return groups.map(group => group.group_id);
}

function targetLineGroupIds_(payload) {
  const selectedIds = Array.isArray(payload.groupIds)
    ? payload.groupIds.map(id => String(id || "").trim()).filter(Boolean)
    : [];
  if (!selectedIds.length) return enabledLineGroupIds_();
  const enabledGroups = lineGroupRows_().filter(group => lineGroupStatus_(group) === "enabled" && group.group_id);
  if (!enabledGroups.length) throw new Error("尚未綁定任何啟用中的 LINE 群組");
  const enabledById = {};
  enabledGroups.forEach(group => {
    enabledById[group.group_id] = true;
  });
  const uniqueIds = Array.from(new Set(selectedIds));
  const invalidIds = uniqueIds.filter(id => !enabledById[id]);
  if (invalidIds.length) throw new Error("選取的 LINE 群組不存在或未啟用");
  return uniqueIds;
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

function groupEventReminderText_(event) {
  return [
    "2526會長聯誼會活動提醒",
    `${event.event_date} ${event.name}`,
    "提醒已報名會長準時出席。活動當天可由下方連結完成簽到：",
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

function groupCheckinReminderText_(event) {
  return [
    "2526會長聯誼會簽到提醒",
    `${event.event_date} ${event.name}`,
    "本場活動已可簽到，請尚未完成簽到的會長點下方連結操作：",
    checkinUrl_()
  ].join("\n");
}

function monthlyBirthdayText_() {
  const month = Number(Utilities.formatDate(new Date(), "Asia/Taipei", "M"));
  const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
  const birthdays = monthlyBirthdayRows_(month);
  if (!birthdays.length) return `${monthNames[month - 1]}本月尚無壽星資料。`;
  const lines = birthdays
    .slice()
    .sort((a, b) => a.day - b.day || String(a.club || "").localeCompare(String(b.club || ""), "zh-Hant", { numeric: true }))
    .map(person => {
      const club = person.club ? `${person.club}｜` : "";
      return `• ${person.month}/${person.day} ${club}${person.name}`;
    });
  return [
    `🎂 ${monthNames[month - 1]}壽星名單`,
    ...lines,
    "",
    "祝福本月壽星生日快樂，健康順心！"
  ].join("\n");
}

function monthlyBirthdayRows_(month) {
  try {
    const rows = memberRows_()
      .filter(isParticipating_)
      .map(member => {
        const birthday = normalizeBirthday_(member.birthday);
        if (!birthday) return null;
        const parts = birthday.split("/").map(Number);
        return {
          club: member.club || "",
          name: member.name || "",
          month: parts[0],
          day: parts[1]
        };
      })
      .filter(item => item && item.month === month && item.name);
    if (rows.length) return rows;
  } catch (_error) {
    // Webhook help should still work before the spreadsheet schema is fully upgraded.
  }
  return monthlyBirthdays_()[month] || [];
}

function monthlyBirthdays_() {
  return {
    1: [
      { club: "崇愛", name: "林宏寬", month: 1, day: 19 },
      { club: "菁鑽", name: "張智翔", month: 1, day: 20 },
      { club: "北區", name: "黃文生", month: 1, day: 4 },
      { club: "松鶴", name: "涂鴻明", month: 1, day: 10 },
      { club: "愛馨", name: "林伶恩", month: 1, day: 5 },
      { club: "圓山", name: "陳致鵬", month: 1, day: 15 },
      { club: "菁彩", name: "沈秀嫻", month: 1, day: 28 },
      { club: "造夢者", name: "徐湘筑", month: 1, day: 12 },
      { club: "顧問", name: "鄒玉露", month: 1, day: 5 }
    ],
    2: [
      { club: "百齡", name: "郭顯彰", month: 2, day: 23 },
      { club: "建國", name: "鄭騰娥", month: 2, day: 28 },
      { club: "信德", name: "莊雨真", month: 2, day: 28 },
      { club: "吉達", name: "簡長春", month: 2, day: 25 },
      { club: "吉翔", name: "梁凱鈞", month: 2, day: 23 },
      { club: "卓越國際", name: "李德豪", month: 2, day: 24 },
      { club: "顧問", name: "葉信志", month: 2, day: 1 }
    ],
    3: [
      { club: "愛華", name: "許秋月", month: 3, day: 10 },
      { club: "中北", name: "林熙悅", month: 3, day: 6 },
      { club: "南門", name: "陳怡伶", month: 3, day: 5 },
      { club: "德馨", name: "楊素瑾", month: 3, day: 12 },
      { club: "世界商務", name: "孫志財", month: 3, day: 15 },
      { club: "顧問", name: "邱琇惠", month: 3, day: 9 },
      { club: "顧問", name: "王志成", month: 3, day: 30 }
    ],
    4: [
      { club: "銀河", name: "蔡滄洲", month: 4, day: 24 },
      { club: "菁麗景", name: "簡丞佐", month: 4, day: 11 },
      { club: "翔贊", name: "陳柏勳", month: 4, day: 24 },
      { club: "雙園", name: "鄭月鳳", month: 4, day: 1 },
      { club: "菁英", name: "許桂英", month: 4, day: 10 },
      { club: "景美", name: "張克誌", month: 4, day: 6 },
      { club: "友聲", name: "顏呈芬", month: 4, day: 1 },
      { club: "太平", name: "周念暉", month: 4, day: 15 },
      { club: "雙子星", name: "李芯媛", month: 4, day: 22 },
      { club: "長虹", name: "黃偉瑜", month: 4, day: 9 },
      { club: "祥和", name: "傅木從", month: 4, day: 20 },
      { club: "顧問", name: "林詩涵", month: 4, day: 9 },
      { club: "顧問", name: "鄭俊雄", month: 4, day: 17 },
      { club: "顧問", name: "曹雅蘭", month: 4, day: 5 },
      { club: "顧問", name: "曾柏勝", month: 4, day: 10 }
    ],
    5: [
      { club: "長春", name: "楊存育", month: 5, day: 10 },
      { club: "力行", name: "林友清", month: 5, day: 25 },
      { club: "長江", name: "簡立其", month: 5, day: 21 },
      { club: "菁緻", name: "謝耀德", month: 5, day: 21 },
      { club: "", name: "顏洋洋總監", month: 5, day: 25 },
      { club: "顧問", name: "柯季宏", month: 5, day: 24 }
    ],
    6: [
      { club: "西區女", name: "李正美", month: 6, day: 22 },
      { club: "皇家騎士", name: "曾彬雄", month: 6, day: 15 },
      { club: "民權", name: "陳政新", month: 6, day: 16 },
      { club: "仁德", name: "吳銘峰", month: 6, day: 12 },
      { club: "仁愛", name: "鄧凱文", month: 6, day: 16 },
      { club: "同心", name: "曾妍蓉", month: 6, day: 2 },
      { club: "自強", name: "曾世豪", month: 6, day: 30 },
      { club: "黃埔", name: "江偉佑", month: 6, day: 20 }
    ],
    7: [
      { club: "周遊", name: "洪淑芬", month: 7, day: 10 },
      { club: "萬華", name: "嚴之唯", month: 7, day: 19 },
      { club: "西門", name: "洪永守", month: 7, day: 29 },
      { club: "菁鐸", name: "陳正德", month: 7, day: 4 },
      { club: "群愛", name: "王立文", month: 7, day: 27 },
      { club: "龍鳳", name: "丁程揚", month: 7, day: 15 },
      { club: "大稻埕", name: "鄧麗華", month: 7, day: 15 },
      { club: "華山", name: "謝尚軒", month: 7, day: 11 },
      { club: "丰勝", name: "簡漪凌", month: 7, day: 2 },
      { club: "南區", name: "陳幼梅", month: 7, day: 1 },
      { club: "永安", name: "王鐘輝", month: 7, day: 23 },
      { club: "顧問", name: "羅賢俐總監", month: 7, day: 16 }
    ],
    8: [
      { club: "太陽", name: "郭文龍", month: 8, day: 1 },
      { club: "西區", name: "林士哲", month: 8, day: 1 },
      { club: "翔賀", name: "許聖楷", month: 8, day: 5 },
      { club: "建成", name: "程柏華", month: 8, day: 14 },
      { club: "太極藝術美學", name: "林逸菁", month: 8, day: 30 },
      { club: "東門", name: "廖虹蕙", month: 8, day: 5 },
      { club: "大同", name: "葉又睿", month: 8, day: 12 },
      { club: "仕貿", name: "黃湘吟", month: 8, day: 17 },
      { club: "日月光", name: "吳秋玲", month: 8, day: 29 },
      { club: "菁誠", name: "陳朝夫", month: 8, day: 19 },
      { club: "鉅星匯", name: "張聖芬", month: 8, day: 8 }
    ],
    9: [
      { club: "臺灣科大EMBA", name: "呂建明", month: 9, day: 7 },
      { club: "目倍果", name: "林宏展", month: 9, day: 6 },
      { club: "青山", name: "徐銘燦", month: 9, day: 30 },
      { club: "一交", name: "陳景貽", month: 9, day: 4 },
      { club: "顧問", name: "賴秀香秘書長", month: 9, day: 24 },
      { club: "顧問", name: "陳昱齊", month: 9, day: 15 }
    ],
    10: [
      { club: "明星", name: "柯如憶", month: 10, day: 7 },
      { club: "千禧", name: "王又禾", month: 10, day: 6 },
      { club: "京華", name: "周素慧", month: 10, day: 26 },
      { club: "東南", name: "陳吉隆", month: 10, day: 1 },
      { club: "大安", name: "李俊賢", month: 10, day: 15 },
      { club: "中原", name: "曾郁儒", month: 10, day: 24 },
      { club: "新台北", name: "孫國文", month: 10, day: 29 },
      { club: "老松", name: "何俊達", month: 10, day: 13 },
      { club: "顧問", name: "鐘朝建", month: 10, day: 29 },
      { club: "顧問", name: "邱秋鎮", month: 10, day: 2 },
      { club: "顧問", name: "黃美麗前總監", month: 10, day: 8 },
      { club: "顧問", name: "黃秀榕前總監", month: 10, day: 10 }
    ],
    11: [
      { club: "建華", name: "吳忠德", month: 11, day: 8 },
      { club: "翔順", name: "劉俊宏", month: 11, day: 18 },
      { club: "春暉", name: "黃金輝", month: 11, day: 12 },
      { club: "中區", name: "陳品安", month: 11, day: 25 },
      { club: "莊敬", name: "林介中", month: 11, day: 17 },
      { club: "榮華", name: "江慧蓮", month: 11, day: 30 },
      { club: "愛國", name: "陳科成", month: 11, day: 12 },
      { club: "慶華", name: "蕭炎明", month: 11, day: 27 },
      { club: "東北", name: "鍾武村", month: 11, day: 20 },
      { club: "華興", name: "黃秀美", month: 11, day: 28 },
      { club: "金國", name: "湯善亦", month: 11, day: 19 },
      { club: "安和", name: "賴英蘭", month: 11, day: 6 }
    ],
    12: [
      { club: "尪公", name: "高靚怡", month: 12, day: 17 },
      { club: "鳳凰藝術美學", name: "洪玉來", month: 12, day: 7 },
      { club: "上贏", name: "范文祥", month: 12, day: 15 },
      { club: "世代", name: "蔡旺盛", month: 12, day: 14 },
      { club: "至善", name: "張欽堯", month: 12, day: 14 },
      { club: "波麗士", name: "陳嘉偉", month: 12, day: 10 },
      { club: "至誠", name: "古富翔", month: 12, day: 15 },
      { club: "顧問", name: "楊孟峰", month: 12, day: 8 },
      { club: "顧問", name: "黃惠珍", month: 12, day: 6 }
    ]
  };
}

function birthdayForMember_(member) {
  const sheetBirthday = normalizeBirthday_(member && member.birthday);
  if (sheetBirthday) return sheetBirthday;
  const club = String((member && member.club) || "").trim();
  const name = String((member && member.name) || "").trim();
  if (!name) return "";
  const birthdays = Object.keys(monthlyBirthdays_())
    .reduce((items, month) => items.concat(monthlyBirthdays_()[month]), []);
  const normalizedName = normalizeBirthdayKey_(name);
  const normalizedClub = normalizeBirthdayKey_(club);
  const matched = birthdays.find(person =>
    normalizeBirthdayKey_(person.name) === normalizedName
    && normalizeBirthdayKey_(person.club) === normalizedClub
  ) || birthdays.find(person =>
    normalizeBirthdayKey_(person.name) === normalizedName
    && !normalizeBirthdayKey_(person.club)
  ) || uniqueBirthdayByClub_(birthdays, normalizedClub);
  return matched ? `${matched.month}/${matched.day}` : "";
}

function uniqueBirthdayByClub_(birthdays, normalizedClub) {
  if (!normalizedClub) return null;
  const matched = birthdays.filter(person => normalizeBirthdayKey_(person.club) === normalizedClub);
  return matched.length === 1 ? matched[0] : null;
}

function normalizeBirthdayKey_(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[　｜|]/g, "")
    .replace(/會長$/g, "")
    .trim();
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
  if (!match) {
    match = text.match(/^(\d{1,2})(\d{2})$/);
  }
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${month}/${day}`;
}

function birthdayMatchesMember_(member, value) {
  const expected = normalizeBirthday_(birthdayForMember_(member));
  const actual = normalizeBirthday_(value);
  return Boolean(expected && actual && expected === actual);
}

function memberRole_(member) {
  const role = String((member && member.role) || "").trim();
  if (/顧問|advisor/i.test(role)) return "advisor";
  return "president";
}

function officialCommandListText_() {
  return [
    "2526會長聯誼會 LINE 指令",
    "＠活動：活動報名、取消報名與當日簽到連結",
    "＠本月壽星：列出本月壽星名單",
    "＠綁定群組 群組名稱：將目前 LINE 群組設為推播群組",
    "＠解除群組：停用目前 LINE 群組推播"
  ].join("\n");
}

function officialAccountHelpText_() {
  return [
    "2526會長聯誼會服務中心",
    "可由下方連結進行活動報名、取消報名與當日簽到：",
    checkinUrl_(),
    "",
    "首次使用請先完成 LINE 身分綁定。",
    "查詢本月壽星，請輸入「＠本月壽星」。",
    "查詢指令清單，請輸入「＠功能」。",
    "如需綁定群組推播，請在群組輸入「＠綁定群組 群組名稱」。"
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

function pushLineGroupsText_(groupIds, text) {
  const uniqueIds = Array.from(new Set(groupIds.filter(Boolean)));
  if (!lineChannelAccessToken_()) throw new Error("尚未設定 LINE_CHANNEL_ACCESS_TOKEN");
  const skipped = groupIds.length - uniqueIds.length;
  let sent = 0;
  uniqueIds.forEach(groupId => {
    pushLineText_(groupId, text);
    sent += 1;
  });
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

function lineGet_(path) {
  const response = UrlFetchApp.fetch(`https://api.line.me${path}`, {
    method: "get",
    headers: { Authorization: `Bearer ${lineChannelAccessToken_()}` },
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`LINE API 讀取失敗 (${code})：${response.getContentText()}`);
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

function memberAuthFromPayload_(payload, options) {
  const allowMissing = Boolean(options && options.allowMissing);
  const memberId = String((payload && payload.memberId) || "").trim();
  const birthday = normalizeBirthday_(payload && payload.birthday);
  if (memberId && birthday) {
    const member = findMemberById_(memberId);
    if (!member) throw new Error("找不到人員資料");
    if (!birthdayMatchesMember_(member, birthday)) throw new Error("生日核對不符，請重新確認");
    return { member, line: null, source: "BIRTHDAY" };
  }
  try {
    const line = verifyLineIdentity_(payload);
    return { member: findMemberByLineUserId_(line.sub), line, source: "LINE" };
  } catch (error) {
    if (allowMissing && String(error && error.message).includes("LINE 登入憑證")) {
      return { member: null, line: null, source: "" };
    }
    throw error;
  }
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
    name: member.name,
    role: memberRole_(member)
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
  const fallbackHeaders = CODE_SCHEMA[name];
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
