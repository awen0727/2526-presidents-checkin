(async function () {
  "use strict";

  const { config, post, showMessage, compareLabels } = window.PresidentsCheckin;
  const statusMessage = document.getElementById("statusMessage");
  const panels = ["bindingPanel", "pendingPanel", "checkinPanel", "successPanel"];
  let idToken = "";
  let accessToken = "";
  let members = [];

  function linePayload(action, extra) {
    return { action, idToken, accessToken, ...extra };
  }

  function showPanel(id) {
    panels.forEach(panelId => document.getElementById(panelId).classList.toggle("hidden", panelId !== id));
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))].sort(compareLabels);
  }

  function fillSelect(select, values, placeholder) {
    select.replaceChildren(new Option(placeholder, ""));
    values.forEach(value => select.appendChild(new Option(value, value)));
    select.disabled = values.length === 0;
  }

  function formatEventDate(value) {
    if (!value) return "";
    const date = new Date(`${value}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    }).format(date);
  }

  async function loadRoster() {
    const result = await post({ action: "getRoster" });
    members = result.members || [];
    if (!members.length) throw new Error("目前沒有今年參加的會長名冊");
    fillSelect(document.getElementById("zoneSelect"), unique(members.map(member => member.zone)), "請選擇專區");
  }

  function renderSession(session) {
    if (session.member) {
      document.getElementById("memberArea").textContent = `${session.member.zone} · ${session.member.division}`;
      document.getElementById("memberName").textContent = session.member.name || "姓名待補";
      document.getElementById("memberClub").textContent = `${session.member.club}會 會長`;
      document.getElementById("eventBox").textContent = session.participationInactive
        ? "目前列為今年未參加，若資料有誤請聯絡管理者。"
        : session.event
        ? `${session.event.event_date}｜${session.event.name}`
        : "目前沒有開放簽到的活動";
      document.getElementById("checkinButton").disabled = session.participationInactive || !session.event || session.alreadyCheckedIn;
      document.getElementById("checkinButton").textContent = session.alreadyCheckedIn ? "本場已簽到" : "確認簽到";
      renderRegistrationEvents(session.registrationEvents || [], Boolean(session.participationInactive));
      showPanel("checkinPanel");
      showMessage(statusMessage, session.participationInactive
        ? "今年未參加，無法簽到或報名"
        : session.alreadyCheckedIn ? "身分已確認，本場已簽到" : "LINE 身分已綁定",
      session.participationInactive ? "error" : "success");
      return;
    }
    if (session.bindingPending) {
      showPanel("pendingPanel");
      showMessage(statusMessage, "申請等待管理者確認", "pending");
      return;
    }
    showPanel("bindingPanel");
    showMessage(statusMessage, "請完成首次身分核對", "");
  }

  function renderRegistrationEvents(events, disabled) {
    const panel = document.getElementById("registrationPanel");
    const empty = document.getElementById("noRegistrationEvents");
    const list = document.getElementById("registrationList");
    panel.classList.remove("hidden");
    list.replaceChildren();
    empty.classList.toggle("hidden", events.length > 0);
    events.forEach(item => {
      const card = document.createElement("article");
      card.className = "registration-card";
      const info = document.createElement("div");
      info.className = "manage-card-info";
      const title = document.createElement("strong");
      title.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = formatEventDate(item.event_date);
      const state = document.createElement("span");
      state.className = item.registered ? "badge success-badge" : "badge";
      state.textContent = item.registered ? "已報名" : "尚未報名";
      info.append(title, meta, state);

      const button = document.createElement("button");
      button.type = "button";
      button.className = item.registered ? "secondary compact-button" : "compact-button";
      button.textContent = item.registered ? "取消報名" : "我要報名";
      button.disabled = disabled;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const action = item.registered ? "cancelRegistration" : "registerEvent";
          const result = await post(linePayload(action, { eventId: item.event_id }));
          showMessage(statusMessage, result.message, "success");
          await loadSession();
        } catch (error) {
          showMessage(statusMessage, error.message, "error");
          button.disabled = false;
        }
      });
      card.append(info, button);
      list.appendChild(card);
    });
  }

  async function loadSession() {
    try {
      const session = await post(linePayload("getSession"));
      renderSession(session);
    } catch (error) {
      if (String(error.message || "").includes("LINE 登入憑證無效或已過期") && liff.isLoggedIn()) {
        liff.logout();
        liff.login({ redirectUri: window.location.href });
        return;
      }
      throw error;
    }
  }

  document.getElementById("zoneSelect").addEventListener("change", event => {
    const divisions = unique(members.filter(member => member.zone === event.target.value).map(member => member.division));
    fillSelect(document.getElementById("divisionSelect"), divisions, "請選擇分區");
    fillSelect(document.getElementById("memberSelect"), [], "請先選分區");
  });

  document.getElementById("divisionSelect").addEventListener("change", event => {
    const zone = document.getElementById("zoneSelect").value;
    const choices = members
      .filter(member => member.zone === zone && member.division === event.target.value)
      .sort((a, b) => compareLabels(a.club, b.club) || compareLabels(a.name, b.name));
    const select = document.getElementById("memberSelect");
    select.replaceChildren(new Option("請選擇分會與會長", ""));
    choices.forEach(member => select.appendChild(new Option(`${member.club}｜${member.name || "姓名待補"}`, member.member_id)));
    select.disabled = choices.length === 0;
  });

  document.getElementById("phoneLast4").addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
  });

  document.getElementById("bindingButton").addEventListener("click", async event => {
    const memberId = document.getElementById("memberSelect").value;
    const phoneLast4 = document.getElementById("phoneLast4").value;
    if (!memberId) return showMessage(statusMessage, "請選擇您的分會與姓名", "error");
    if (!/^\d{4}$/.test(phoneLast4)) return showMessage(statusMessage, "請輸入手機末四碼", "error");
    event.currentTarget.disabled = true;
    try {
      const result = await post(linePayload("requestBinding", { memberId, phoneLast4 }));
      if (result.status === "approved") await loadSession();
      else renderSession({ member: null, bindingPending: true });
    } catch (error) {
      showMessage(statusMessage, error.message, "error");
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  document.getElementById("pendingRefreshButton").addEventListener("click", () => {
    loadSession().catch(error => showMessage(statusMessage, error.message, "error"));
  });

  document.getElementById("checkinButton").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await post(linePayload("checkIn"));
      document.getElementById("successText").textContent = result.message;
      showPanel("successPanel");
      showMessage(statusMessage, "已寫入簽到紀錄", "success");
    } catch (error) {
      showMessage(statusMessage, error.message, "error");
      event.currentTarget.disabled = false;
    }
  });

  try {
    const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
      && new URLSearchParams(location.search).get("preview") === "1";
    if (localPreview) {
      members = [
        { member_id: "P2526-001", zone: "第一專區", division: "第1分區", club: "預覽", name: "預覽會長" },
        { member_id: "P2526-002", zone: "第二專區", division: "第3分區", club: "示範", name: "示範會長" }
      ];
      document.getElementById("lineName").textContent = "預覽使用者";
      document.getElementById("profilePanel").classList.remove("hidden");
      renderSession({
        member: members[0],
        event: { event_id: "EV-PREVIEW", event_date: "2026-06-26", name: "六月會長聯誼會" },
        registrationEvents: [
          { event_id: "EV-PREVIEW", event_date: "2026-06-26", name: "六月會長聯誼會", registered: true },
          { event_id: "EV-NEXT", event_date: "2026-07-18", name: "七月份會長聯誼會", registered: false }
        ],
        alreadyCheckedIn: false,
        participationInactive: false,
        bindingPending: false
      });
      return;
    }
    await loadRoster();
    if (!config.liffId || config.liffId.includes("PASTE_")) throw new Error("尚未設定 LIFF ID");
    await liff.init({ liffId: config.liffId });
    if (!liff.isLoggedIn()) return liff.login({ redirectUri: window.location.href });
    idToken = liff.getIDToken();
    accessToken = liff.getAccessToken() || "";
    if (!idToken && !accessToken) throw new Error("無法取得 LINE 登入憑證，請確認 LIFF 已啟用 openid 權限");
    const profile = await liff.getProfile();
    document.getElementById("lineName").textContent = profile.displayName || "LINE 使用者";
    if (profile.pictureUrl) {
      document.getElementById("profileImage").src = profile.pictureUrl;
      document.getElementById("profileImage").classList.remove("hidden");
    }
    document.getElementById("profilePanel").classList.remove("hidden");
    await loadSession();
  } catch (error) {
    showMessage(statusMessage, error.message, "error");
  }
})();
