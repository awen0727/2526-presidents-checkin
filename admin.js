(function () {
  "use strict";

  const { post, showMessage, compareLabels } = window.PresidentsCheckin;
  const tokenInput = document.getElementById("adminToken");
  const loginMessage = document.getElementById("loginMessage");
  const adminMessage = document.getElementById("adminMessage");
  const reportMessage = document.getElementById("reportMessage");
  const memberDetailDialog = document.getElementById("memberDetailDialog");
  const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
    && new URLSearchParams(location.search).get("preview") === "1";
  let state = { requests: [], members: [], events: [], attendance: [], currentEvent: null, notParticipatingCount: 0, registrationReports: {}, lineOfficial: null };
  const selectedMemberIds = new Set();
  let report = {
    events: [],
    selectedEvent: null,
    selectedEventMembers: [],
    members: [],
    summary: { event_count: 0, member_count: 0, attendance_count: 0, average_attendance: 0 }
  };

  tokenInput.value = sessionStorage.getItem("presidentsAdminToken") || "";

  const today = new Date();
  document.getElementById("eventDate").value = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");

  function adminToken() {
    const token = tokenInput.value.trim();
    if (!token) throw new Error("請輸入管理密鑰");
    sessionStorage.setItem("presidentsAdminToken", token);
    return token;
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function makeButton(label, className, handler) {
    const button = makeElement("button", className, label);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function showReportView(view) {
    document.querySelectorAll(".report-subtab").forEach(tab => tab.classList.toggle("active", tab.dataset.reportView === view));
    document.getElementById("reportRecentPanel").classList.toggle("hidden", view !== "recent");
    document.getElementById("reportMemberPanel").classList.toggle("hidden", view !== "member");
  }

  function showAdminTab(tabName) {
    document.querySelectorAll(".admin-tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === tabName));
    document.querySelectorAll(".admin-tab-panel").forEach(panel => panel.classList.add("hidden"));
    document.getElementById(`${tabName}Tab`).classList.remove("hidden");
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))].sort(compareLabels);
  }

  function fillSelect(select, values, placeholder, disabled) {
    select.replaceChildren(new Option(placeholder, ""));
    values.forEach(value => select.appendChild(new Option(value, value)));
    select.disabled = Boolean(disabled || values.length === 0);
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function eventRegistrationStatus(event) {
    return String((event && event.registration_status) || "open");
  }

  function eventCheckinStatus(event) {
    return String((event && event.checkin_status) || (event && event.status) || "closed");
  }

  function gateLabel(status) {
    return status === "open" ? "開放中" : "已關閉";
  }

  function gateShortLabel(status) {
    return status === "open" ? "開放" : "關閉";
  }

  function eventMeta(event) {
    return [event.event_date, event.event_time].filter(Boolean).join(" ");
  }

  function toDatetimeLocalValue(event) {
    if (!event || !event.event_date) return "";
    return `${event.event_date}T${event.event_time || "18:00"}`;
  }

  async function runAction(payload, confirmation) {
    if (confirmation && !window.confirm(confirmation)) return;
    showMessage(adminMessage, "處理中...", "");
    const result = await post({ ...payload, adminToken: adminToken() });
    await load();
    showMessage(adminMessage, result.message || "資料已更新", "success");
  }

  function renderOverview() {
    document.getElementById("pendingCount").textContent = state.requests.length;
    document.getElementById("boundCount").textContent = state.boundCount;
    document.getElementById("memberCount").textContent = state.memberCount;
    document.getElementById("notParticipatingCount").textContent = state.notParticipatingCount || 0;
    document.getElementById("attendanceCount").textContent = state.attendance.length;

    const currentName = document.getElementById("currentEventName");
    const currentMeta = document.getElementById("currentEventMeta");
    const badge = document.getElementById("eventStatusBadge");
    const toggle = document.getElementById("toggleEventButton");
    if (state.currentEvent) {
      currentName.textContent = state.currentEvent.name;
      currentMeta.textContent = eventMeta(state.currentEvent);
      badge.textContent = "簽到開放中";
      badge.className = "badge success-badge";
      toggle.classList.remove("hidden");
    } else {
      currentName.textContent = "目前沒有開放活動";
      currentMeta.textContent = "請到活動管理建立或開放活動。";
      badge.textContent = "尚未開放";
      badge.className = "badge";
      toggle.classList.add("hidden");
    }
  }

  function renderLineOfficial() {
    const status = state.lineOfficial || {};
    const badge = document.getElementById("lineOfficialBadge");
    const text = document.getElementById("lineOfficialStatus");
    if (!badge || !text) return;
    badge.textContent = status.configured ? "推播可用" : "尚未設定";
    badge.className = status.configured ? "badge success-badge" : "badge warning-badge";
    text.textContent = status.configured
      ? `已設定 LINE_CHANNEL_ACCESS_TOKEN；活動推播僅發送至 LINE 群組，目前已啟用群組 ${status.enabledGroupCount || 0} 個。`
      : "尚未設定 LINE_CHANNEL_ACCESS_TOKEN；報名功能可用，但官方帳號推播按鈕會失敗。";
    renderLineGroups(status.groups || []);
  }

  function renderLineGroups(groups) {
    const list = document.getElementById("lineGroupList");
    const empty = document.getElementById("noLineGroups");
    if (!list || !empty) return;
    list.replaceChildren();
    empty.classList.toggle("hidden", groups.length > 0);
    groups.forEach(group => {
      const card = makeElement("article", "manage-card line-group-card");
      const info = makeElement("div", "manage-card-info");
      const enabled = group.status !== "disabled";
      info.append(
        makeElement("strong", "", group.group_name || "未命名群組"),
        makeElement("span", enabled ? "status-open" : "status-closed", enabled ? "啟用中" : "已停用"),
        makeElement("span", "line-user-id", group.group_id || ""),
        makeElement("span", "muted", `類型：${group.group_type || "group"} · 更新：${formatDateTime(group.updated_at || group.created_at) || "未記錄"}`)
      );
      const actions = makeElement("div", "button-row");
      const toggle = makeButton(enabled ? "停用" : "啟用", "secondary compact-button", () => {
        runAction(
          { action: "adminSetLineGroupStatus", groupId: group.group_id, status: enabled ? "disabled" : "enabled" },
          `確定${enabled ? "停用" : "啟用"}「${group.group_name || "此群組"}」嗎？`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const remove = makeButton("刪除", "danger secondary compact-button", () => {
        runAction(
          { action: "adminDeleteLineGroup", groupId: group.group_id },
          `確定刪除「${group.group_name || "此群組"}」嗎？\n\n刪除後需重新在群組輸入綁定指令。`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      actions.append(toggle, remove);
      card.append(info, actions);
      list.appendChild(card);
    });
  }

  function renderManualMembers() {
    const attendedIds = new Set(state.attendance.map(row => row.member_id));
    const select = document.getElementById("manualMember");
    select.replaceChildren(new Option("請選擇尚未簽到的會長", ""));
    state.members
      .filter(member => member.participating && !attendedIds.has(member.member_id))
      .sort((a, b) => compareLabels(a.zone, b.zone)
        || compareLabels(a.division, b.division)
        || compareLabels(a.club, b.club))
      .forEach(member => select.appendChild(new Option(`${member.club}｜${member.name || "姓名待補"}`, member.member_id)));
    select.disabled = !state.currentEvent;
    document.getElementById("manualCheckinButton").disabled = !state.currentEvent;
  }

  function renderAttendance() {
    const list = document.getElementById("attendanceList");
    list.replaceChildren();
    document.getElementById("noAttendance").classList.toggle("hidden", state.attendance.length > 0);
    document.getElementById("exportAttendanceButton").disabled = state.attendance.length === 0;
    state.attendance.forEach(record => {
      const card = makeElement("article", "manage-card");
      const info = makeElement("div", "manage-card-info");
      info.append(
        makeElement("strong", "", record.name || "姓名待補"),
        makeElement("span", "muted", `${record.club}會 · ${formatDateTime(record.checkin_at)} · ${record.source}`)
      );
      const remove = makeButton("撤銷", "danger secondary compact-button", () => {
        runAction(
          { action: "adminRemoveAttendance", attendanceId: record.attendance_id },
          `確定撤銷「${record.name || record.club}」的本場簽到嗎？`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      card.append(info, remove);
      list.appendChild(card);
    });
  }

  function renderEvents() {
    const list = document.getElementById("eventList");
    list.replaceChildren();
    document.getElementById("noEvents").classList.toggle("hidden", state.events.length > 0);
    [...state.events].reverse().forEach(event => {
      const card = makeElement("article", "manage-card");
      const info = makeElement("div", "manage-card-info");
      const eventStats = makeElement("div", "event-status-grid");
      const attendanceCount = event.attendance_count == null ? "待更新" : event.attendance_count;
      eventStats.append(
        makeElement("span", "", `報名人數：${event.registration_count || 0}`),
        makeElement("span", "", `已簽到人數：${attendanceCount}`),
        makeElement("span", eventRegistrationStatus(event) === "open" ? "status-open" : "status-closed", `報名：${gateShortLabel(eventRegistrationStatus(event))}`),
        makeElement("span", eventCheckinStatus(event) === "open" ? "status-open" : "status-closed", `簽到：${gateShortLabel(eventCheckinStatus(event))}`)
      );
      info.append(
        makeElement("strong", "", event.name),
        makeElement("span", "muted", eventMeta(event)),
        eventStats
      );
      const nextRegistrationStatus = eventRegistrationStatus(event) === "open" ? "closed" : "open";
      const nextCheckinStatus = eventCheckinStatus(event) === "open" ? "closed" : "open";
      const actions = makeElement("div", "button-row");
      const registrationButton = makeButton("查看報名", "secondary compact-button", () => {
        openEventRegistrations(event).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const attendanceButton = makeButton("查看出席人員", "secondary compact-button", () => {
        openEventAttendance(event).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const groupInviteButton = makeButton("推播報名", "secondary compact-button", () => {
        sendLineAction(event, "adminSendGroupRegistrationInvite", `確定推播報名通知到所有啟用中的 LINE 群組嗎？\n\n活動：${event.name}`)
          .catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const groupReminderButton = makeButton("活動提醒", "secondary compact-button", () => {
        sendLineAction(event, "adminSendGroupEventReminder", `確定推播活動提醒到所有啟用中的 LINE 群組嗎？\n\n活動：${event.name}`)
          .catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const groupCheckinButton = makeButton("簽到提醒", "secondary compact-button", () => {
        sendLineAction(event, "adminSendGroupCheckinReminder", `確定推播簽到提醒到所有啟用中的 LINE 群組嗎？\n\n活動：${event.name}`)
          .catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const registrationStatusButton = makeButton(
        eventRegistrationStatus(event) === "open" ? "關閉報名" : "開放報名",
        "secondary compact-button",
        () => {
          runAction(
            { action: "adminSetEventGate", eventId: event.event_id, gate: "registration", status: nextRegistrationStatus },
            `確定${nextRegistrationStatus === "open" ? "開放" : "關閉"}「${event.name}」的報名嗎？`
          ).catch(error => showMessage(adminMessage, error.message, "error"));
        }
      );
      const checkinStatusButton = makeButton(
        eventCheckinStatus(event) === "open" ? "關閉簽到" : "開放簽到",
        "secondary compact-button",
        () => {
          runAction(
            { action: "adminSetEventGate", eventId: event.event_id, gate: "checkin", status: nextCheckinStatus },
            `確定${nextCheckinStatus === "open" ? "開放" : "關閉"}「${event.name}」的簽到嗎？${nextCheckinStatus === "open" ? "\n\n其他開放中的簽到活動會自動關閉。" : ""}`
          ).catch(error => showMessage(adminMessage, error.message, "error"));
        }
      );
      const deleteButton = makeButton("刪除", "danger secondary compact-button", () => {
        runAction(
          { action: "adminDeleteEvent", eventId: event.event_id },
          `確定永久刪除「${event.name}」嗎？\n\n該活動的所有簽到紀錄也會一起刪除，且無法復原。`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      const eventHasOpenGate = eventRegistrationStatus(event) === "open" || eventCheckinStatus(event) === "open";
      deleteButton.disabled = eventHasOpenGate;
      deleteButton.title = eventHasOpenGate ? "請先關閉報名與簽到才能刪除" : "永久刪除活動及該場簽到紀錄";
      actions.append(registrationButton, attendanceButton, groupInviteButton, groupReminderButton, groupCheckinButton, registrationStatusButton, checkinStatusButton, deleteButton);
      card.append(info, actions);
      list.appendChild(card);
    });
    renderBackfillForm();
  }

  function renderBackfillForm() {
    const eventSelect = document.getElementById("backfillEvent");
    const memberSelect = document.getElementById("backfillMember");
    const timeInput = document.getElementById("backfillCheckinAt");
    const selectedEventId = eventSelect.value;
    const selectedMemberId = memberSelect.value;

    eventSelect.replaceChildren(new Option("請選擇活動", ""));
    [...state.events]
      .sort((a, b) => String(b.event_date || "").localeCompare(String(a.event_date || "")))
      .forEach(event => eventSelect.appendChild(new Option(`${eventMeta(event)}｜${event.name}`, event.event_id)));
    eventSelect.value = state.events.some(event => event.event_id === selectedEventId) ? selectedEventId : "";

    memberSelect.replaceChildren(new Option("請選擇人員", ""));
    state.members
      .filter(member => member.participating)
      .sort((a, b) => compareLabels(a.zone, b.zone)
        || compareLabels(a.division, b.division)
        || compareLabels(a.club, b.club)
        || compareLabels(a.name, b.name))
      .forEach(member => memberSelect.appendChild(new Option(`${member.club}｜${member.name || "姓名待補"}${member.role === "advisor" ? "（顧問）" : ""}`, member.member_id)));
    memberSelect.value = state.members.some(member => member.member_id === selectedMemberId) ? selectedMemberId : "";

    const event = state.events.find(item => item.event_id === eventSelect.value);
    if (!timeInput.value && event) timeInput.value = toDatetimeLocalValue(event);
    eventSelect.disabled = state.events.length === 0;
    memberSelect.disabled = state.members.filter(member => member.participating).length === 0;
    document.getElementById("backfillAttendanceButton").disabled = eventSelect.disabled || memberSelect.disabled;
  }

  function renderRequest(request) {
    const card = makeElement("article", "review-card");
    const heading = makeElement("div", "review-heading");
    const title = makeElement("div");
    title.append(
      makeElement("strong", "review-name", request.member_name || "姓名待補"),
      makeElement("span", "muted", [request.zone, request.division, `${request.club}會`].filter(Boolean).join(" · "))
    );
    heading.append(title, makeElement("span", "badge warning-badge", "生日待確認"));
    const details = makeElement("div", "review-details");
    details.append(
      makeElement("span", "", `LINE 名稱：${request.line_display_name || "未提供"}`),
      makeElement("span", "", `輸入生日：${request.provided_birthday || "未記錄"}`),
      makeElement("span", "", `目前電話：${request.masked_phone || "未設定"}`)
    );
    const phoneLabel = makeElement("label", "", "確認後的完整手機號碼");
    const phoneInput = makeElement("input");
    phoneInput.type = "tel";
    phoneInput.inputMode = "numeric";
    phoneInput.maxLength = 15;
    phoneInput.placeholder = "例如 0912345678";
    phoneLabel.appendChild(phoneInput);
    const actions = makeElement("div", "button-row");
    actions.append(
      makeButton("確認並綁定", "", () => {
        const phone = phoneInput.value.replace(/\D/g, "");
        if (phone && phone.length < 8) return showMessage(adminMessage, "完整電話格式不正確", "error");
        runAction(
          { action: "adminApproveBinding", requestId: request.request_id, phone },
          `確定將 LINE 帳號綁定給「${request.member_name || request.club}」嗎？`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      }),
      makeButton("拒絕申請", "danger secondary", () => {
        runAction(
          { action: "adminRejectBinding", requestId: request.request_id },
          "確定拒絕這筆申請嗎？"
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      })
    );
    card.append(heading, details, phoneLabel, actions);
    return card;
  }

  function renderRequests() {
    const list = document.getElementById("requestList");
    list.replaceChildren(...state.requests.map(renderRequest));
    document.getElementById("noRequests").classList.toggle("hidden", state.requests.length > 0);
  }

  function buildMemberFilters() {
    const zoneSelect = document.getElementById("memberZoneFilter");
    const selectedZone = zoneSelect.value;
    const zones = unique(state.members.map(member => member.zone));
    fillSelect(zoneSelect, zones, "全部專區", false);
    zoneSelect.value = zones.includes(selectedZone) ? selectedZone : "";
  }

  function filteredMembers() {
    const query = document.getElementById("memberSearch").value.trim().toLowerCase();
    const participation = document.getElementById("participationFilter").value;
    const zone = document.getElementById("memberZoneFilter").value;
    return state.members.filter(member => {
      const text = [member.zone, member.division, member.club, member.name, member.birthday, member.role === "advisor" ? "顧問" : "會長"].join(" ").toLowerCase();
      if (participation === "participating" && !member.participating) return false;
      if (participation === "not_participating" && member.participating) return false;
      if (zone && member.zone !== zone) return false;
      return !query || text.includes(query);
    });
  }

  function renderMembers() {
    buildMemberFilters();
    const list = document.getElementById("memberList");
    list.replaceChildren();
    const visibleMembers = filteredMembers();
    visibleMembers.forEach(member => {
      const card = makeElement("article", "member-admin-card");
      const heading = makeElement("div", "review-heading");
      const info = makeElement("div", "manage-card-info");
      const selection = makeElement("label", "member-select-check");
      const checkbox = makeElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedMemberIds.has(member.member_id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedMemberIds.add(member.member_id);
        else selectedMemberIds.delete(member.member_id);
        updateBulkSelection(visibleMembers);
      });
      selection.append(checkbox, document.createTextNode("選取"));
      info.append(
        selection,
        makeElement("strong", "", `${member.club}｜${member.name || "姓名待補"}`),
        makeElement("span", "muted", [member.zone, member.division, member.role === "advisor" ? "顧問" : "會長"].filter(Boolean).join(" · ")),
        makeElement("span", "birthday-state", member.birthday ? `生日：${member.birthday}` : "生日：未設定"),
        makeElement("span", member.participating ? "participating-state" : "not-participating-state", member.participating ? "今年參加" : "今年未參加"),
        makeElement("span", member.bound ? "bound-state" : "unbound-state", member.bound
          ? `LINE 已綁定：${member.line_display_name || "名稱未記錄"}`
          : "LINE 未綁定"),
        makeElement("span", "line-user-id", member.bound
          ? `LINE ID：${member.line_user_id || "未記錄"}`
          : "LINE ID：未綁定")
      );
      heading.append(info, makeElement("span", "masked-phone", member.masked_phone || "電話未設定"));
      const controls = makeElement("div", "member-controls");
      const phoneInput = makeElement("input");
      phoneInput.type = "tel";
      phoneInput.inputMode = "numeric";
      phoneInput.placeholder = "輸入新的完整電話";
      const savePhone = makeButton("更新電話", "secondary compact-button", () => {
        const phone = phoneInput.value.replace(/\D/g, "");
        if (phone.length < 8) return showMessage(adminMessage, "請輸入正確的完整電話", "error");
        runAction({ action: "adminUpdateMemberPhone", memberId: member.member_id, phone })
          .catch(error => showMessage(adminMessage, error.message, "error"));
      });
      controls.append(phoneInput, savePhone);
      controls.appendChild(makeButton(member.participating ? "改為今年未參加" : "改為今年參加", "secondary compact-button", () => {
        runAction(
          { action: "adminSetParticipation", memberId: member.member_id, participating: !member.participating },
          `確定將「${member.name || member.club}」改為${member.participating ? "今年未參加" : "今年參加"}嗎？`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      }));
      if (member.bound) controls.appendChild(makeButton("解除 LINE", "danger secondary compact-button", () => {
        runAction(
          { action: "adminUnbindMember", memberId: member.member_id },
          `確定解除「${member.name || member.club}」的 LINE 綁定嗎？`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      }));
      card.append(heading, controls);
      list.appendChild(card);
    });
    updateBulkSelection(visibleMembers);
  }

  function updateBulkSelection(visibleMembers) {
    const visibleIds = visibleMembers.map(member => member.member_id);
    const selectedVisibleCount = visibleIds.filter(id => selectedMemberIds.has(id)).length;
    const totalSelectedCount = selectedMemberIds.size;
    const selectAll = document.getElementById("selectAllMembers");
    if (selectAll) {
      selectAll.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
      selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
    }
    document.getElementById("selectedMembersCount").textContent = `已選 ${totalSelectedCount} 位`;
    document.getElementById("bulkParticipatingButton").disabled = totalSelectedCount === 0;
    document.getElementById("bulkNotParticipatingButton").disabled = totalSelectedCount === 0;
  }

  function setVisibleMemberSelection(checked) {
    filteredMembers().forEach(member => {
      if (checked) selectedMemberIds.add(member.member_id);
      else selectedMemberIds.delete(member.member_id);
    });
    renderMembers();
  }

  function bulkSetParticipation(participating) {
    const memberIds = Array.from(selectedMemberIds);
    if (!memberIds.length) return showMessage(adminMessage, "請先選擇會長", "error");
    runAction(
      { action: "adminSetBulkParticipation", memberIds, participating },
      `確定將已選取的 ${memberIds.length} 位會長改為${participating ? "今年參加" : "今年未參加"}嗎？`
    ).then(() => {
      selectedMemberIds.clear();
      renderMembers();
    })
      .catch(error => showMessage(adminMessage, error.message, "error"));
  }

  function personCard(person, index) {
    const card = document.createElement("article");
    card.className = "attendance-person-card";
    const order = document.createElement("span");
    order.className = "arrival-order";
    order.textContent = String(index + 1);
    const detail = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = person.name || "姓名待補";
    const meta = document.createElement("span");
    meta.textContent = `${person.club}會 · ${formatTime(person.checkin_at)}`;
    detail.append(name, meta);
    card.append(order, detail);
    return card;
  }

  function renderDashboard() {
    const event = report.selectedEvent || state.currentEvent;
    const people = (report.selectedEventMembers || []).filter(member => member.attended)
      .sort((a, b) => String(a.checkin_at).localeCompare(String(b.checkin_at)));
    const totalCount = report.summary.member_count || state.memberCount || 0;
    const attendedCount = people.length;
    const absentCount = Math.max(0, totalCount - attendedCount);
    const attendanceRate = totalCount ? Math.round(attendedCount / totalCount * 1000) / 10 : 0;

    document.getElementById("dashboardEventName").textContent = event
      ? event.name
      : "目前沒有開放簽到的活動";
    document.getElementById("dashboardEventMeta").textContent = event
      ? eventMeta(event)
      : "開放活動後，此區會自動顯示即時出席狀況。";
    document.getElementById("dashboardTotal").textContent = totalCount;
    document.getElementById("dashboardAttended").textContent = attendedCount;
    document.getElementById("dashboardAbsent").textContent = absentCount;
    document.getElementById("dashboardRate").textContent = attendanceRate;
    document.getElementById("dashboardProgressBar").style.width = `${Math.min(100, attendanceRate)}%`;
    document.getElementById("dashboardUpdatedAt").textContent = `更新 ${formatTime(new Date().toISOString())}`;
    document.getElementById("dashboardPeople").replaceChildren(...people.map(personCard));
    document.getElementById("dashboardEmpty").classList.toggle("hidden", people.length > 0);
    showMessage(document.getElementById("dashboardMessage"), "", "");
  }

  function fillEvents() {
    const select = document.getElementById("reportEventFilter");
    select.replaceChildren();
    if (!report.events.length) select.appendChild(new Option("尚無活動", ""));
    report.events.forEach(event => select.appendChild(new Option(
      `${eventMeta(event)}｜${event.name}`,
      event.event_id,
      false,
      Boolean(report.selectedEvent && event.event_id === report.selectedEvent.event_id)
    )));
  }

  function renderStats() {
    document.getElementById("reportEventCount").textContent = report.summary.event_count;
    document.getElementById("reportMemberCount").textContent = report.summary.member_count;
    document.getElementById("reportAttendanceCount").textContent = report.summary.attendance_count;
    document.getElementById("reportAverage").textContent = report.summary.average_attendance;
  }

  function addCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text == null ? "" : String(text);
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function safeFileName(value) {
    return String(value || "未命名").replace(/[\\/:*?"<>|]/g, "-");
  }

  async function downloadXlsx(rows, fileName, sheetName) {
    const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const blob = new Blob([window.PresidentsXlsx.create(rows, sheetName)], { type: mimeType });
    const file = typeof File === "function" ? new File([blob], fileName, { type: mimeType }) : null;
    let canShareFile = false;
    try {
      canShareFile = Boolean(file && navigator.canShare && navigator.canShare({ files: [file] }));
    } catch (_error) {
      canShareFile = false;
    }
    if (canShareFile) {
      try {
        await navigator.share({ files: [file], title: fileName });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 30000);
  }

  function renderEvent() {
    const event = report.selectedEvent;
    const query = document.getElementById("reportMemberSearch").value.trim().toLowerCase();
    const status = document.getElementById("reportStatusFilter").value;
    document.getElementById("reportSelectedEventName").textContent = event ? event.name : "尚無活動";
    document.getElementById("reportSelectedEventMeta").textContent = event ? eventMeta(event) : "";
    const attended = report.selectedEventMembers.filter(member => member.attended).length;
    document.getElementById("reportSelectedEventBadge").textContent = event ? `已出席 ${attended}／${report.selectedEventMembers.length}` : "";
    document.getElementById("exportReportEventAttendanceButton").disabled = !event || attended === 0;
    const rows = document.getElementById("reportEventRows");
    rows.replaceChildren();
    report.selectedEventMembers.filter(member => {
      const text = [member.zone, member.division, member.club, member.name].join(" ").toLowerCase();
      if (query && !text.includes(query)) return false;
      if (status === "attended" && !member.attended) return false;
      if (status === "absent" && member.attended) return false;
      return true;
    }).forEach(member => {
      const row = document.createElement("tr");
      addCell(row, member.attended ? "已出席" : "未出席", member.attended ? "attendance-yes" : "attendance-no");
      addCell(row, `${member.zone}／${member.division}`);
      addCell(row, member.club);
      addCell(row, member.name || "姓名待補");
      addCell(row, formatDateTime(member.checkin_at));
      addCell(row, member.source || "");
      rows.appendChild(row);
    });
  }

  function fillPersonFilters() {
    const zoneSelect = document.getElementById("reportZoneFilter");
    const selectedZone = zoneSelect.value;
    const zones = unique(report.members.map(member => member.zone));
    fillSelect(zoneSelect, zones, "全部專區", false);
    zoneSelect.value = zones.includes(selectedZone) ? selectedZone : "";
  }

  function renderPersonRecords(member) {
    const summary = document.getElementById("reportPersonSummary");
    const rows = document.getElementById("reportDetailRows");
    rows.replaceChildren();
    if (!member) {
      summary.classList.add("hidden");
      return;
    }
    document.getElementById("reportDetailName").textContent = `${member.club}｜${member.name || "姓名待補"} 出席日期`;
    document.getElementById("reportPersonStats").textContent = `出席 ${member.attended_count} 場，未出席 ${member.absent_count} 場，出席率 ${member.attendance_rate}%`;
    member.records.forEach(record => {
      const row = document.createElement("tr");
      addCell(row, record.event_date);
      addCell(row, record.event_name);
      addCell(row, record.attended ? "已出席" : "未出席", record.attended ? "attendance-yes" : "attendance-no");
      addCell(row, formatDateTime(record.checkin_at));
      addCell(row, record.source || "");
      rows.appendChild(row);
    });
    summary.classList.remove("hidden");
  }

  function filteredReportMembers() {
    const zone = document.getElementById("reportZoneFilter").value;
    return report.members.filter(member => {
      if (zone && member.zone !== zone) return false;
      return true;
    });
  }

  function openMemberDetail(member) {
    document.getElementById("memberDetailTitle").textContent = `${member.club}｜${member.name || "姓名待補"} 出席明細`;
    document.getElementById("memberDetailStats").textContent = `出席 ${member.attended_count} 場，未出席 ${member.absent_count} 場，出席率 ${member.attendance_rate}%`;
    const rows = document.getElementById("memberDetailRows");
    rows.replaceChildren();
    member.records.forEach(record => {
      const row = document.createElement("tr");
      addCell(row, record.event_date);
      addCell(row, record.event_name);
      addCell(row, record.attended ? "已出席" : "未出席", record.attended ? "attendance-yes" : "attendance-no");
      addCell(row, formatDateTime(record.checkin_at));
      addCell(row, record.source || "");
      rows.appendChild(row);
    });
    if (typeof memberDetailDialog.showModal === "function") memberDetailDialog.showModal();
    else memberDetailDialog.setAttribute("open", "open");
  }

  function renderSummary() {
    const rows = document.getElementById("reportSummaryRows");
    rows.replaceChildren();
    filteredReportMembers().forEach(member => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-link-button";
      button.textContent = member.name || "姓名待補";
      button.addEventListener("click", () => {
        showReportView("member");
        document.getElementById("reportZoneFilter").value = member.zone;
        fillPersonFilters();
        openMemberDetail(member);
      });
      nameCell.appendChild(button);
      row.appendChild(nameCell);
      addCell(row, member.club);
      addCell(row, member.attended_count);
      addCell(row, member.absent_count);
      addCell(row, `${member.attendance_rate}%`, member.attendance_rate < 50 ? "rate-low" : "rate-good");
      rows.appendChild(row);
    });
  }

  function renderSelectedPerson() {
    fillPersonFilters();
    const candidates = filteredReportMembers();
    renderSummary();
    if (candidates.length === 1) {
      renderPersonRecords(candidates[0]);
      return;
    }
    const summary = document.getElementById("reportPersonSummary");
    document.getElementById("reportDetailRows").replaceChildren();
    document.getElementById("reportDetailName").textContent = candidates.length
      ? `符合 ${candidates.length} 位會長`
      : "查無符合條件的會長";
    document.getElementById("reportPersonStats").textContent = candidates.length
      ? "請在下方年度出席統計點選姓名查看個人出席日期。"
      : "請調整篩選條件。";
    summary.classList.remove("hidden");
  }

  async function loadReport(eventId) {
    report = await post({ action: "adminAttendanceReport", adminToken: adminToken(), eventId: eventId || "" });
    fillEvents();
    renderStats();
    renderEvent();
    renderSummary();
    renderSelectedPerson();
    renderDashboard();
    showMessage(reportMessage, "", "");
  }

  async function openEventAttendance(event) {
    document.getElementById("reportStatusFilter").value = "attended";
    document.getElementById("reportMemberSearch").value = "";
    await loadReport(event.event_id);
    showAdminTab("report");
    showReportView("recent");
    renderEvent();
    const attendedCount = report.selectedEventMembers.filter(member => member.attended).length;
    showMessage(reportMessage, `${event.name}：共 ${attendedCount} 位出席`, "success");
    window.requestAnimationFrame(() => {
      document.getElementById("reportRecentPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function openEventRegistrations(event) {
    let result;
    if (localPreview) {
      result = state.registrationReports[event.event_id] || { event, registrants: [], total: 0 };
    } else {
      result = await post({ action: "adminRegistrationReport", adminToken: adminToken(), eventId: event.event_id });
    }
    const card = document.getElementById("registrationReportCard");
    const rows = document.getElementById("registrationRows");
    document.getElementById("registrationReportTitle").textContent = `${result.event.name} 報名名單`;
    document.getElementById("registrationReportMeta").textContent = eventMeta(result.event);
    document.getElementById("registrationReportBadge").textContent = `已報名 ${result.total} 人`;
    rows.replaceChildren();
    (result.registrants || []).forEach(person => {
      const row = document.createElement("tr");
      addCell(row, `${person.zone || ""}／${person.division || ""}`);
      addCell(row, person.club || "");
      addCell(row, person.name || "姓名待補");
      addCell(row, formatDateTime(person.registered_at));
      addCell(row, person.source || "");
      rows.appendChild(row);
    });
    document.getElementById("noRegistrants").classList.toggle("hidden", Boolean(result.registrants && result.registrants.length));
    card.classList.remove("hidden");
    window.requestAnimationFrame(() => {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function sendLineAction(event, action, confirmation) {
    if (localPreview) {
      showMessage(adminMessage, `${event.name}：本機預覽已模擬送出 LINE 通知`, "success");
      return;
    }
    await runAction({ action, eventId: event.event_id }, confirmation);
  }

  function render() {
    renderOverview();
    renderManualMembers();
    renderAttendance();
    renderEvents();
    renderRequests();
    renderMembers();
    renderLineOfficial();
  }

  async function load() {
    state = await post({ action: "adminOverview", adminToken: adminToken() });
    const currentMemberIds = new Set((state.members || []).map(member => member.member_id));
    Array.from(selectedMemberIds).forEach(memberId => {
      if (!currentMemberIds.has(memberId)) selectedMemberIds.delete(memberId);
    });
    render();
    await loadReport(document.getElementById("reportEventFilter").value);
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
    showMessage(loginMessage, "", "");
  }

  async function exportAttendance() {
    const event = state.currentEvent;
    if (!event || !state.attendance.length) return;
    const rows = [
      ["活動日期", "活動名稱", "分會", "姓名", "簽到時間", "來源"],
      ...state.attendance.map(record => [
        event.event_date, event.name, record.club, record.name, formatDateTime(record.checkin_at), record.source
      ])
    ];
    const fileName = `${event.event_date}-${safeFileName(event.name)}-簽到名單.xlsx`;
    await downloadXlsx(rows, fileName, "簽到名單");
  }

  async function exportReportEventAttendance() {
    const event = report.selectedEvent;
    const attendees = (report.selectedEventMembers || [])
      .filter(member => member.attended)
      .sort((a, b) => String(a.checkin_at || "").localeCompare(String(b.checkin_at || "")));
    if (!event || !attendees.length) return;
    const rows = [
      ["活動日期", "活動名稱", "專區", "分會", "姓名", "簽到時間"],
      ...attendees.map(member => [
        event.event_date,
        event.name,
        member.zone || "",
        member.club || "",
        member.name || "姓名待補",
        formatDateTime(member.checkin_at)
      ])
    ];
    const fileName = `${event.event_date}-${safeFileName(event.name)}-出席人員名單.xlsx`;
    await downloadXlsx(rows, fileName, "出席人員名單");
  }

  document.querySelectorAll(".admin-tab").forEach(button => {
    button.addEventListener("click", () => showAdminTab(button.dataset.tab));
  });
  document.querySelectorAll(".report-subtab").forEach(button => {
    button.addEventListener("click", () => showReportView(button.dataset.reportView));
  });

  document.getElementById("loginButton").addEventListener("click", () => {
    load().catch(error => showMessage(loginMessage, error.message, "error"));
  });
  document.getElementById("refreshButton").addEventListener("click", () => {
    load().then(() => showMessage(adminMessage, "資料已更新", "success"))
      .catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("toggleEventButton").addEventListener("click", () => {
    if (!state.currentEvent) return;
    runAction(
      { action: "adminSetEventGate", eventId: state.currentEvent.event_id, gate: "checkin", status: "closed" },
      `確定關閉「${state.currentEvent.name}」的簽到嗎？`
    ).catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("createEventButton").addEventListener("click", () => {
    const name = document.getElementById("eventName").value.trim();
    const eventDate = document.getElementById("eventDate").value;
    const eventTime = document.getElementById("eventTime").value || "18:00";
    const registrationOpen = document.getElementById("eventRegistrationOpen").checked;
    const checkinOpen = document.getElementById("eventCheckinOpen").checked;
    if (!name || !eventDate || !eventTime) return showMessage(adminMessage, "請填寫活動日期、時間與名稱", "error");
    runAction(
      { action: "adminCreateEvent", name, eventDate, eventTime, registrationOpen, checkinOpen },
      `建立「${name}」？${checkinOpen ? "\n\n目前開放中的簽到活動會自動關閉。" : ""}`
    ).then(() => { document.getElementById("eventName").value = ""; })
      .catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("backfillEvent").addEventListener("change", event => {
    const selectedEvent = state.events.find(item => item.event_id === event.target.value);
    document.getElementById("backfillCheckinAt").value = toDatetimeLocalValue(selectedEvent);
  });
  document.getElementById("backfillAttendanceButton").addEventListener("click", async event => {
    const eventSelect = document.getElementById("backfillEvent");
    const memberSelect = document.getElementById("backfillMember");
    const checkinAt = document.getElementById("backfillCheckinAt").value;
    if (!eventSelect.value) return showMessage(adminMessage, "請選擇要補登的活動", "error");
    if (!memberSelect.value) return showMessage(adminMessage, "請選擇要補登的人員", "error");
    const selectedEventId = eventSelect.value;
    const selectedEventLabel = eventSelect.options[eventSelect.selectedIndex].text;
    const selectedMemberLabel = memberSelect.options[memberSelect.selectedIndex].text;
    if (!window.confirm(`確定補登「${selectedEventLabel}」\n人員：${selectedMemberLabel}？`)) return;
    event.currentTarget.disabled = true;
    showMessage(adminMessage, "補登中...", "");
    try {
      const result = await post({
        action: "adminBackfillAttendance",
        adminToken: adminToken(),
        eventId: selectedEventId,
        memberId: memberSelect.value,
        checkinAt
      });
      await load();
      await loadReport(selectedEventId);
      document.getElementById("reportEventFilter").value = selectedEventId;
      showAdminTab("report");
      showReportView("recent");
      renderEvent();
      document.getElementById("backfillMember").value = "";
      showMessage(adminMessage, `${result.message || "補登完成"}；已切到該活動出席名單`, "success");
      window.requestAnimationFrame(() => {
        document.getElementById("reportRecentPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (error) {
      showMessage(adminMessage, error.message, "error");
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  document.getElementById("manualCheckinButton").addEventListener("click", () => {
    const select = document.getElementById("manualMember");
    if (!select.value) return showMessage(adminMessage, "請先選擇會長", "error");
    runAction(
      { action: "adminManualCheckIn", memberId: select.value },
      `確定代「${select.options[select.selectedIndex].text}」完成簽到嗎？`
    ).catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("exportAttendanceButton").addEventListener("click", () => {
    exportAttendance().catch(error => showMessage(adminMessage, `Excel 匯出失敗：${error.message}`, "error"));
  });
  document.getElementById("exportReportEventAttendanceButton").addEventListener("click", () => {
    exportReportEventAttendance().catch(error => showMessage(reportMessage, `Excel 匯出失敗：${error.message}`, "error"));
  });
  document.getElementById("memberSearch").addEventListener("input", renderMembers);
  document.getElementById("participationFilter").addEventListener("change", renderMembers);
  document.getElementById("memberZoneFilter").addEventListener("change", renderMembers);
  document.getElementById("selectAllMembers").addEventListener("change", event => {
    setVisibleMemberSelection(event.currentTarget.checked);
  });
  document.getElementById("bulkParticipatingButton").addEventListener("click", () => bulkSetParticipation(true));
  document.getElementById("bulkNotParticipatingButton").addEventListener("click", () => bulkSetParticipation(false));
  document.getElementById("reportEventFilter").addEventListener("change", event => {
    loadReport(event.target.value).catch(error => showMessage(reportMessage, error.message, "error"));
  });
  document.getElementById("reportStatusFilter").addEventListener("change", renderEvent);
  document.getElementById("reportMemberSearch").addEventListener("input", renderEvent);
  document.getElementById("reportZoneFilter").addEventListener("change", renderSelectedPerson);
  document.getElementById("memberDetailClose").addEventListener("click", () => {
    if (typeof memberDetailDialog.close === "function") memberDetailDialog.close();
    else memberDetailDialog.removeAttribute("open");
  });

  if (localPreview) {
    state = {
      requests: [],
      memberCount: 114,
      notParticipatingCount: 1,
      boundCount: 38,
      currentEvent: { event_id: "EV-PREVIEW", event_date: "2026-06-26", event_time: "18:00", name: "六月會長聯誼會" },
      events: [
        { event_id: "EV-PREVIEW", event_date: "2026-06-26", event_time: "18:00", name: "六月會長聯誼會", status: "open", registration_status: "closed", checkin_status: "open", registration_count: 2, attendance_count: 1 },
        { event_id: "EV-NEXT", event_date: "2026-07-18", event_time: "18:00", name: "七月份會長聯誼會", status: "closed", registration_status: "open", checkin_status: "closed", registration_count: 1, attendance_count: 0 }
      ],
      attendance: [{ attendance_id: "AT-PREVIEW", member_id: "P2526-001", name: "預覽會長", club: "預覽", checkin_at: new Date().toISOString(), source: "LINE" }],
      members: [
        { member_id: "P2526-001", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長", birthday: "7/27", masked_phone: "******1234", participating: true, bound: true, line_user_id: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", line_display_name: "LINE 預覽" },
        { member_id: "P2526-002", zone: "第一專區", division: "第1分區", club: "測試", name: "測試會長", birthday: "", masked_phone: "******5678", participating: false, bound: false, line_user_id: "", line_display_name: "" }
      ],
      lineOfficial: {
        configured: true,
        boundCount: 38,
        enabledGroupCount: 1,
        checkinUrl: "https://liff.line.me/2010452724-MvUou0rS",
        groups: [
          { group_id: "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", group_name: "會長通知群", group_type: "group", status: "enabled", updated_at: new Date().toISOString() },
          { group_id: "Cyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", group_name: "測試群", group_type: "group", status: "disabled", updated_at: new Date(Date.now() - 86400000).toISOString() }
        ]
      },
      registrationReports: {
        "EV-PREVIEW": {
          event: { event_id: "EV-PREVIEW", event_date: "2026-06-26", event_time: "18:00", name: "六月會長聯誼會" },
          total: 2,
          registrants: [
            { member_id: "P2526-001", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長", registered_at: new Date().toISOString(), source: "LINE" },
            { member_id: "P2526-003", zone: "第二專區", division: "第3分區", club: "示範", name: "示範會長", registered_at: new Date(Date.now() - 3600000).toISOString(), source: "LINE" }
          ]
        },
        "EV-NEXT": {
          event: { event_id: "EV-NEXT", event_date: "2026-07-18", event_time: "18:00", name: "七月份會長聯誼會" },
          total: 1,
          registrants: [
            { member_id: "P2526-003", zone: "第二專區", division: "第3分區", club: "示範", name: "示範會長", registered_at: new Date(Date.now() - 7200000).toISOString(), source: "LINE" }
          ]
        }
      }
    };
    report = {
      events: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", event_time: "18:00", name: "系統測試" }],
      selectedEvent: { event_id: "EV-PREVIEW", event_date: "2026-06-20", event_time: "18:00", name: "系統測試" },
      selectedEventMembers: [
        { member_id: "P2526-001", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長", attended: true, checkin_at: new Date().toISOString(), source: "LINE" },
        { member_id: "P2526-002", zone: "第一專區", division: "第1分區", club: "測試", name: "測試會長", attended: false, checkin_at: "", source: "" }
      ],
      members: [
        {
          member_id: "P2526-001",
          zone: "第一專區",
          division: "第1分區",
          club: "預覽",
          name: "預覽會長",
          attended_count: 1,
          absent_count: 0,
          attendance_rate: 100,
          records: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", event_name: "系統測試", attended: true, checkin_at: new Date().toISOString(), source: "LINE" }]
        },
        {
          member_id: "P2526-002",
          zone: "第一專區",
          division: "第1分區",
          club: "測試",
          name: "測試會長",
          attended_count: 0,
          absent_count: 1,
          attendance_rate: 0,
          records: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", event_name: "系統測試", attended: false, checkin_at: "", source: "" }]
        }
      ],
      summary: { event_count: 1, member_count: 2, attendance_count: 1, average_attendance: 1 }
    };
    render();
    fillEvents();
    renderStats();
    renderEvent();
    renderSummary();
    renderSelectedPerson();
    renderDashboard();
    showReportView("recent");
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
  }
})();
