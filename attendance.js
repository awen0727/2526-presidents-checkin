(function () {
  "use strict";

  const { post, showMessage } = window.PresidentsCheckin;
  const tokenInput = document.getElementById("reportAdminToken");
  const message = document.getElementById("reportMessage");
  let report = null;
  const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
    && new URLSearchParams(location.search).get("preview") === "1";
  tokenInput.value = sessionStorage.getItem("presidentsAdminToken") || "";

  function adminToken() {
    const token = tokenInput.value.trim();
    if (!token) throw new Error("請輸入管理密鑰");
    sessionStorage.setItem("presidentsAdminToken", token);
    return token;
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(date);
  }

  function addCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text == null ? "" : String(text);
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function fillEvents() {
    const select = document.getElementById("reportEventFilter");
    select.replaceChildren();
    if (!report.events.length) select.appendChild(new Option("尚無活動", ""));
    report.events.forEach(event => select.appendChild(new Option(
      `${event.event_date}｜${event.name}`,
      event.event_id,
      false,
      report.selectedEvent && event.event_id === report.selectedEvent.event_id
    )));
  }

  function renderStats() {
    document.getElementById("reportEventCount").textContent = report.summary.event_count;
    document.getElementById("reportMemberCount").textContent = report.summary.member_count;
    document.getElementById("reportAttendanceCount").textContent = report.summary.attendance_count;
    document.getElementById("reportAverage").textContent = report.summary.average_attendance;
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

  function showDetail(member) {
    document.getElementById("reportDetailName").textContent = `${member.club}｜${member.name || "姓名待補"} 出席明細`;
    const rows = document.getElementById("reportDetailRows");
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
    document.getElementById("reportDetailPanel").classList.remove("hidden");
    document.getElementById("reportDetailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderSummary() {
    const rows = document.getElementById("reportSummaryRows");
    rows.replaceChildren();
    report.members.forEach(member => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-link-button";
      button.textContent = member.name || "姓名待補";
      button.addEventListener("click", () => showDetail(member));
      nameCell.appendChild(button);
      row.appendChild(nameCell);
      addCell(row, member.club);
      addCell(row, member.attended_count);
      addCell(row, member.absent_count);
      addCell(row, `${member.attendance_rate}%`, member.attendance_rate < 50 ? "rate-low" : "rate-good");
      rows.appendChild(row);
    });
  }

  async function load(eventId) {
    try {
      report = localPreview ? {
        events: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試" }],
        selectedEvent: { event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試" },
        selectedEventMembers: [
          { member_id: "P1", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長", attended: true, checkin_at: new Date().toISOString(), source: "LINE" },
          { member_id: "P2", zone: "第一專區", division: "第1分區", club: "測試", name: "測試會長", attended: false, checkin_at: "", source: "" }
        ],
        members: [
          { member_id: "P1", club: "預覽", name: "預覽會長", attended_count: 1, absent_count: 0, attendance_rate: 100, records: [{ event_date: "2026-06-20", event_name: "系統測試", attended: true, checkin_at: new Date().toISOString(), source: "LINE" }] },
          { member_id: "P2", club: "測試", name: "測試會長", attended_count: 0, absent_count: 1, attendance_rate: 0, records: [{ event_date: "2026-06-20", event_name: "系統測試", attended: false, checkin_at: "", source: "" }] }
        ],
        summary: { event_count: 1, member_count: 2, attendance_count: 1, average_attendance: 1 }
      } : await post({ action: "adminAttendanceReport", adminToken: adminToken(), eventId: eventId || "" });
      fillEvents();
      renderStats();
      renderEvent();
      renderSummary();
      document.getElementById("reportLoginPanel").classList.add("hidden");
      document.getElementById("reportApp").classList.remove("hidden");
      showMessage(document.getElementById("reportLoginMessage"), "", "");
      showMessage(message, "", "");
    } catch (error) {
      showMessage(document.getElementById("reportLoginMessage"), error.message, "error");
      showMessage(message, error.message, "error");
    }
  }

  document.getElementById("reportLoginButton").addEventListener("click", () => load());
  document.getElementById("reportEventFilter").addEventListener("change", event => load(event.target.value));
  document.getElementById("reportStatusFilter").addEventListener("change", renderEvent);
  document.getElementById("reportMemberSearch").addEventListener("input", renderEvent);
  document.getElementById("reportDetailClose").addEventListener("click", () => document.getElementById("reportDetailPanel").classList.add("hidden"));
  if (localPreview || tokenInput.value) load();
})();
