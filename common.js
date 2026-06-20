(function () {
  "use strict";

  const config = window.PRESIDENTS_CHECKIN_CONFIG || {};

  async function post(payload) {
    if (!config.apiUrl || config.apiUrl.includes("PASTE_")) {
      throw new Error("尚未設定 Apps Script API 網址");
    }
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (_error) {
      throw new Error("後端回應格式不正確，請確認 Apps Script 已重新部署");
    }
    if (!result.ok) throw new Error(result.error || "操作失敗");
    return result;
  }

  function showMessage(element, message, type) {
    element.textContent = message || "";
    element.className = `message ${type || ""}`.trim();
  }

  window.PresidentsCheckin = { config, post, showMessage };
})();
