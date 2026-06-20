(function () {
  "use strict";

  const { post, showMessage } = window.PresidentsCheckin;
  const tokenInput = document.getElementById("adminToken");
  const loginMessage = document.getElementById("loginMessage");
  const adminMessage = document.getElementById("adminMessage");
  let state = { requests: [], members: [], events: [], attendance: [], currentEvent: null };
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
      .filter(member => !attendedIds.has(member.member_id))
      .sort((a, b) => `${a.zone}${a.division}${a.club}`.localeCompare(`${b.zone}${b.division}${b.club}`, "zh-Hant"))
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

  function renderMembers() {
    const query = document.getElementById("memberSearch").value.trim().toLowerCase();
    const list = document.getElementById("memberList");
    list.replaceChildren();
    state.members.filter(member => {
      const text = [member.zone, member.division, member.club, member.name].join(" ").toLowerCase();
      return !query || text.includes(query);
    }).forEach(member => {
      const card = makeElement("article", "member-admin-card");
      const heading = makeElement("div", "review-heading");
      const info = makeElement("div", "manage-card-info");
      info.append(
        makeElement("strong", "", `${member.club}｜${member.name || "姓名待補"}`),
        makeElement("span", "muted", `${member.zone} · ${member.division}`),
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
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
    showMessage(loginMessage, "", "");
  }

  function exportAttendance() {
    const event = state.currentEvent;
    if (!event || !state.attendance.length) return;
    const escape = value => `"${String(value || "").replace(/"/g, '""')}"`;
    const rows = [
      ["活動日期", "活動名稱", "分會", "姓名", "簽到時間", "來源"],
      ...state.attendance.map(record => [
        event.event_date, event.name, record.club, record.name, formatDateTime(record.checkin_at), record.source
      ])
    ];
    const blob = new Blob(["\ufeff" + rows.map(row => row.map(escape).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${event.event_date}-${event.name}-簽到名單.csv`;
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

  const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
    && new URLSearchParams(location.search).get("preview") === "1";
  if (localPreview) {
    state = {
      requests: [],
      memberCount: 114,
      boundCount: 38,
      currentEvent: { event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試" },
      events: [{ event_id: "EV-PREVIEW", event_date: "2026-06-20", name: "系統測試", status: "open" }],
      attendance: [{ attendance_id: "AT-PREVIEW", member_id: "P2526-001", name: "預覽會長", club: "預覽", checkin_at: new Date().toISOString(), source: "LINE" }],
      members: [
        { member_id: "P2526-001", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長", masked_phone: "******1234", bound: true, line_display_name: "LINE 預覽" },
        { member_id: "P2526-002", zone: "第一專區", division: "第1分區", club: "測試", name: "測試會長", masked_phone: "******5678", bound: false, line_display_name: "" }
      ]
    };
    render();
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
  }
})();
