(function () {
  "use strict";

  const { post, showMessage } = window.PresidentsCheckin;
  const tokenInput = document.getElementById("adminToken");
  const loginMessage = document.getElementById("loginMessage");
  const adminMessage = document.getElementById("adminMessage");
  tokenInput.value = sessionStorage.getItem("presidentsAdminToken") || "";

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

  async function runAction(payload) {
    showMessage(adminMessage, "處理中...", "");
    await post({ ...payload, adminToken: adminToken() });
    await load();
    showMessage(adminMessage, "資料已更新", "success");
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
    const approve = makeElement("button", "", "確認並綁定");
    const reject = makeElement("button", "danger secondary", "拒絕申請");
    approve.type = reject.type = "button";
    approve.addEventListener("click", () => {
      const phone = phoneInput.value.replace(/\D/g, "");
      if (phone && phone.length < 8) return showMessage(adminMessage, "完整電話格式不正確", "error");
      if (!window.confirm(`確定將 LINE 帳號綁定給「${request.member_name || request.club}」嗎？`)) return;
      runAction({ action: "adminApproveBinding", requestId: request.request_id, phone })
        .catch(error => showMessage(adminMessage, error.message, "error"));
    });
    reject.addEventListener("click", () => {
      if (!window.confirm("確定拒絕這筆申請嗎？")) return;
      runAction({ action: "adminRejectBinding", requestId: request.request_id })
        .catch(error => showMessage(adminMessage, error.message, "error"));
    });
    actions.append(approve, reject);
    card.append(heading, details, phoneLabel, actions);
    return card;
  }

  async function load() {
    const data = await post({ action: "adminOverview", adminToken: adminToken() });
    document.getElementById("pendingCount").textContent = data.requests.length;
    document.getElementById("boundCount").textContent = data.boundCount;
    document.getElementById("memberCount").textContent = data.memberCount;
    const list = document.getElementById("requestList");
    list.replaceChildren(...data.requests.map(renderRequest));
    document.getElementById("noRequests").classList.toggle("hidden", data.requests.length > 0);
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
    showMessage(loginMessage, "", "");
  }

  document.getElementById("loginButton").addEventListener("click", () => {
    load().catch(error => showMessage(loginMessage, error.message, "error"));
  });
  document.getElementById("refreshButton").addEventListener("click", () => {
    load().catch(error => showMessage(adminMessage, error.message, "error"));
  });
})();
