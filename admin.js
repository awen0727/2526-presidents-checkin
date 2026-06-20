(function () {
  "use strict";

  const { post, showMessage, compareLabels } = window.PresidentsCheckin;
  const tokenInput = document.getElementById("adminToken");
  const loginMessage = document.getElementById("loginMessage");
  const adminMessage = document.getElementById("adminMessage");
  const reportMessage = document.getElementById("reportMessage");
  const memberDetailDialog = document.getElementById("memberDetailDialog");
  let state = { requests: [], members: [], events: [], attendance: [], currentEvent: null, notParticipatingCount: 0 };
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
      currentMeta.textContent = state.currentEvent.event_date;
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
      info.append(
        makeElement("strong", "", event.name),
        makeElement("span", "muted", `${event.event_date} · ${event.status === "open" ? "簽到開放中" : "已關閉"}`)
      );
      const nextStatus = event.status === "open" ? "closed" : "open";
      const label = event.status === "open" ? "關閉" : "重新開放";
      const button = makeButton(label, "secondary compact-button", () => {
        runAction(
          { action: "adminSetEventStatus", eventId: event.event_id, status: nextStatus },
          `確定${label}「${event.name}」嗎？`
        ).catch(error => showMessage(adminMessage, error.message, "error"));
      });
      card.append(info, button);
      list.appendChild(card);
    });
  }

  function renderRequest(request) {
    const card = makeElement("article", "review-card");
    const heading = makeElement("div", "review-heading");
    const title = makeElement("div");
    title.append(
      makeElement("strong", "review-name", request.member_name || "姓名待補"),
      makeElement("span", "muted", `${request.zone} · ${request.division} · ${request.club}會`)
    );
    heading.append(title, makeElement("span", "badge warning-badge", "末四碼不符"));
    const details = makeElement("div", "review-details");
    details.append(
      makeElement("span", "", `LINE 名稱：${request.line_display_name || "未提供"}`),
      makeElement("span", "", `輸入末四碼：${request.provided_last4}`),
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
    const divisionSelect = document.getElementById("memberDivisionFilter");
    const clubSelect = document.getElementById("memberClubFilter");
    const selectedZone = zoneSelect.value;
    const selectedDivision = divisionSelect.value;
    const selectedClub = clubSelect.value;
    const zones = unique(state.members.map(member => member.zone));
    fillSelect(zoneSelect, zones, "全部專區", false);
    zoneSelect.value = zones.includes(selectedZone) ? selectedZone : "";

    const divisions = unique(state.members.map(member => member.division));
    fillSelect(divisionSelect, divisions, "全部分區", false);
    divisionSelect.value = divisions.includes(selectedDivision) ? selectedDivision : "";

    const clubs = unique(state.members.map(member => member.club));
    fillSelect(clubSelect, clubs, "全部會名", false);
    clubSelect.value = clubs.includes(selectedClub) ? selectedClub : "";
  }

  function filteredMembers() {
    const query = document.getElementById("memberSearch").value.trim().toLowerCase();
    const participation = document.getElementById("participationFilter").value;
    const zone = document.getElementById("memberZoneFilter").value;
    const division = document.getElementById("memberDivisionFilter").value;
    const club = document.getElementById("memberClubFilter").value;
    return state.members.filter(member => {
      const text = [member.zone, member.division, member.club, member.name].join(" ").toLowerCase();
      if (participation === "participating" && !member.participating) return false;
      if (participation === "not_participating" && member.participating) return false;
      if (zone && member.zone !== zone) return false;
      if (division && member.division !== division) return false;
      if (club && member.club !== club) return false;
      return !query || text.includes(query);
    });
  }

  function renderMembers() {
    buildMemberFilters();
    const list = document.getElementById("memberList");
    list.replaceChildren();
    filteredMembers().forEach(member => {
      const card = makeElement("article", "member-admin-card");
      const heading = makeElement("div", "review-heading");
      const info = makeElement("div", "manage-card-info");
      info.append(
        makeElement("strong", "", `${member.club}｜${member.name || "姓名待補"}`),
        makeElement("span", "muted", `${member.zone} · ${member.division}`),
        makeElement("span", member.participating ? "participating-state" : "not-participating-state", member.participating ? "今年參加" : "今年未參加"),
        makeElement("span", member.bound ? "bound-state" : "unbound-state", member.bound
          ? `LINE 已綁定：${member.line_display_name || "名稱未記錄"}`
          : "LINE 未綁定")
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
      ? event.event_date
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
      `${event.event_date}｜${event.name}`,
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

  function renderEvent() {
    const event = report.selectedEvent;
    const query = document.getElementById("reportMemberSearch").value.trim().toLowerCase();
    const status = document.getElementById("reportStatusFilter").value;
    document.getElementById("reportSelectedEventName").textContent = event ? event.name : "尚無活動";
    document.getElementById("reportSelectedEventMeta").textContent = event ? event.event_date : "";
    const attended = report.selectedEventMembers.filter(member => member.attended).length;
    document.getElementById("reportSelectedEventBadge").textContent = event ? `已出席 ${attended}／${report.selectedEventMembers.length}` : "";
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
    const divisionSelect = document.getElementById("reportDivisionFilter");
    const clubSelect = document.getElementById("reportClubFilter");
    const selectedZone = zoneSelect.value;
    const selectedDivision = divisionSelect.value;
    const selectedClub = clubSelect.value;
    const zones = unique(report.members.map(member => member.zone));
    fillSelect(zoneSelect, zones, "全部專區", false);
    zoneSelect.value = zones.includes(selectedZone) ? selectedZone : "";

    const divisions = unique(report.members.map(member => member.division));
    fillSelect(divisionSelect, divisions, "全部分區", false);
    divisionSelect.value = divisions.includes(selectedDivision) ? selectedDivision : "";

    const clubs = unique(report.members.map(member => member.club));
    fillSelect(clubSelect, clubs, "全部會名", false);
    clubSelect.value = clubs.includes(selectedClub) ? selectedClub : "";
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
    const division = document.getElementById("reportDivisionFilter").value;
    const club = document.getElementById("reportClubFilter").value;
    return report.members.filter(member => {
      if (zone && member.zone !== zone) return false;
      if (division && member.division !== division) return false;
      if (club && member.club !== club) return false;
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
        document.getElementById("reportDivisionFilter").value = member.division;
        fillPersonFilters();
        document.getElementById("reportClubFilter").value = member.club;
        renderSelectedPerson();
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
      ? "請繼續選擇專區、分區或會名以查看個人出席日期。"
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

  function render() {
    renderOverview();
    renderManualMembers();
    renderAttendance();
    renderEvents();
    renderRequests();
    renderMembers();
  }

  async function load() {
    state = await post({ action: "adminOverview", adminToken: adminToken() });
    render();
    await loadReport(document.getElementById("reportEventFilter").value);
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
    showMessage(loginMessage, "", "");
  }

  function exportAttendance() {
    const event = state.currentEvent;
    if (!event || !state.attendance.length) return;
    const escapeXml = value => String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
    const rows = [
      ["活動日期", "活動名稱", "分會", "姓名", "簽到時間", "來源"],
      ...state.attendance.map(record => [
        event.event_date, event.name, record.club, record.name, formatDateTime(record.checkin_at), record.source
      ])
    ];
    const xml = [
      "<?xml version=\"1.0\"?>",
      "<?mso-application progid=\"Excel.Sheet\"?>",
      "<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">",
      "<Worksheet ss:Name=\"簽到名單\"><Table>",
      ...rows.map(row => `<Row>${row.map(cell => `<Cell><Data ss:Type=\"String\">${escapeXml(cell)}</Data></Cell>`).join("")}</Row>`),
      "</Table></Worksheet></Workbook>"
    ].join("");
    const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${event.event_date}-${event.name}-簽到名單.xls`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  document.querySelectorAll(".admin-tab").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach(tab => tab.classList.toggle("active", tab === button));
      document.querySelectorAll(".admin-tab-panel").forEach(panel => panel.classList.add("hidden"));
      document.getElementById(`${button.dataset.tab}Tab`).classList.remove("hidden");
    });
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
      { action: "adminSetEventStatus", eventId: state.currentEvent.event_id, status: "closed" },
      `確定關閉「${state.currentEvent.name}」的簽到嗎？`
    ).catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("createEventButton").addEventListener("click", () => {
    const name = document.getElementById("eventName").value.trim();
    const eventDate = document.getElementById("eventDate").value;
    if (!name || !eventDate) return showMessage(adminMessage, "請填寫活動日期與名稱", "error");
    runAction(
      { action: "adminCreateEvent", name, eventDate, open: true },
      `建立並開放「${name}」？目前開放中的活動會自動關閉。`
    ).then(() => { document.getElementById("eventName").value = ""; })
      .catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("manualCheckinButton").addEventListener("click", () => {
    const select = document.getElementById("manualMember");
    if (!select.value) return showMessage(adminMessage, "請先選擇會長", "error");
    runAction(
      { action: "adminManualCheckIn", memberId: select.value },
      `確定代「${select.options[select.selectedIndex].text}」完成簽到嗎？`
    ).catch(error => showMessage(adminMessage, error.message, "error"));
  });
  document.getElementById("exportAttendanceButton").addEventListener("click", exportAttendance);
  document.getElementById("memberSearch").addEventListener("input", renderMembers);
  document.getElementById("participationFilter").addEventListener("change", renderMembers);
  document.getElementById("memberZoneFilter").addEventListener("change", renderMembers);
  document.getElementById("memberDivisionFilter").addEventListener("change", renderMembers);
  document.getElementById("memberClubFilter").addEventListener("change", renderMembers);
  document.getElementById("reportEventFilter").addEventListener("change", event => {
    loadReport(event.target.value).catch(error => showMessage(reportMessage, error.message, "error"));
  });
  document.getElementById("reportStatusFilter").addEventListener("change", renderEvent);
  document.getElementById("reportMemberSearch").addEventListener("input", renderEvent);
  document.getElementById("reportZoneFilter").addEventListener("change", renderSelectedPerson);
  document.getElementById("reportDivisionFilter").addEventListener("change", renderSelectedPerson);
  document.getElementById("reportClubFilter").addEventListener("change", renderSelectedPerson);
  document.getElementById("memberDetailClose").addEventListener("click", () => {
    if (typeof memberDetailDialog.close === "function") memberDetailDialog.close();
    else memberDetailDialog.removeAttribute("open");
  });

  const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
    && new URLSearchParams(location.search).get("preview") === "1";
  if (localPreview) {
    state = {
      requests: [],
      memberCount: 114,
      notParticipatingCount: 1,
      boundCount: 38,
      currentEvent: { event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試" },
      events: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試", status: "open" }],
      attendance: [{ attendance_id: "AT-PREVIEW", member_id: "P2526-001", name: "預覽會長", club: "預覽", checkin_at: new Date().toISOString(), source: "LINE" }],
      members: [
        { member_id: "P2526-001", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長", masked_phone: "******1234", participating: true, bound: true, line_display_name: "LINE 預覽" },
        { member_id: "P2526-002", zone: "第一專區", division: "第1分區", club: "測試", name: "測試會長", masked_phone: "******5678", participating: false, bound: false, line_display_name: "" }
      ]
    };
    report = {
      events: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試" }],
      selectedEvent: { event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試" },
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
