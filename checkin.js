(async function () {
  "use strict";

  const { config, post, showMessage } = window.PresidentsCheckin;
  const statusMessage = document.getElementById("statusMessage");
  const panels = ["bindingPanel", "pendingPanel", "checkinPanel", "successPanel"];
  let idToken = "";
  let members = [];

  function showPanel(id) {
    panels.forEach(panelId => document.getElementById(panelId).classList.toggle("hidden", panelId !== id));
  }

  function unique(values) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }

  function fillSelect(select, values, placeholder) {
    select.replaceChildren(new Option(placeholder, ""));
    values.forEach(value => select.appendChild(new Option(value, value)));
    select.disabled = values.length === 0;
  }

  async function loadRoster() {
    const result = await post({ action: "getRoster" });
    members = result.members || [];
    if (!members.length) throw new Error("目前沒有今年參加的會長名冊");
    fillSelect(document.getElementById("zoneSelect"), unique(members.map(member => member.zone)), "請選擇專區");
  }

  function renderSession(session) {
    if (session.alreadyCheckedIn) {
      document.getElementById("successText").textContent = `${session.member.name}，您已完成本次活動簽到。`;
      showPanel("successPanel");
      showMessage(statusMessage, "身分已確認", "success");
      return;
    }
    if (session.member) {
      document.getElementById("memberArea").textContent = `${session.member.zone} · ${session.member.division}`;
      document.getElementById("memberName").textContent = session.member.name || "姓名待補";
      document.getElementById("memberClub").textContent = `${session.member.club}會 會長`;
      document.getElementById("eventBox").textContent = session.participationInactive
        ? "目前列為今年未參加，若資料有誤請聯絡管理者。"
        : session.event
        ? `${session.event.event_date}｜${session.event.name}`
        : "目前沒有開放簽到的活動";
      document.getElementById("checkinButton").disabled = session.participationInactive || !session.event;
      showPanel("checkinPanel");
      showMessage(statusMessage, session.participationInactive ? "今年未參加，無法簽到" : "LINE 身分已綁定", session.participationInactive ? "error" : "success");
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

  async function loadSession() {
    const session = await post({ action: "getSession", idToken });
    renderSession(session);
  }

  document.getElementById("zoneSelect").addEventListener("change", event => {
    const divisions = unique(members.filter(member => member.zone === event.target.value).map(member => member.division));
    fillSelect(document.getElementById("divisionSelect"), divisions, "請選擇分區");
    fillSelect(document.getElementById("memberSelect"), [], "請先選分區");
  });

  document.getElementById("divisionSelect").addEventListener("change", event => {
    const zone = document.getElementById("zoneSelect").value;
    const choices = members.filter(member => member.zone === zone && member.division === event.target.value);
    const select = document.getElementById("memberSelect");
    select.replaceChildren(new Option("請選擇分會與會長", ""));
    choices.forEach(member => select.appendChild(new Option(`${member.club}｜${member.name || "姓名待補"}`, member.id)));
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
      const result = await post({ action: "requestBinding", idToken, memberId, phoneLast4 });
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
      const result = await post({ action: "checkIn", idToken });
      document.getElementById("successText").textContent = result.message;
      showPanel("successPanel");
      showMessage(statusMessage, "已寫入簽到紀錄", "success");
    } catch (error) {
      showMessage(statusMessage, error.message, "error");
      event.currentTarget.disabled = false;
    }
  });

  try {
    await loadRoster();
    const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
      && new URLSearchParams(location.search).get("preview") === "1";
    if (localPreview) {
      document.getElementById("lineName").textContent = "預覽使用者";
      document.getElementById("profilePanel").classList.remove("hidden");
      renderSession({ member: null, bindingPending: false });
      return;
    }
    if (!config.liffId || config.liffId.includes("PASTE_")) throw new Error("尚未設定 LIFF ID");
    await liff.init({ liffId: config.liffId });
    if (!liff.isLoggedIn()) return liff.login({ redirectUri: window.location.href });
    idToken = liff.getIDToken();
    if (!idToken) throw new Error("無法取得 LINE 登入憑證，請確認 LIFF 已啟用 openid 權限");
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
