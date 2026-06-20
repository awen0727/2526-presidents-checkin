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

  const labelCollator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });

  function chineseNumber(value) {
    const digits = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!value.includes("十")) return digits[value];
    const [tens, ones] = value.split("十");
    return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0);
  }

  function ordinalNumber(value) {
    const text = String(value || "");
    const arabic = text.match(/第\s*(\d+)\s*(?:專區|分區)/);
    if (arabic) return Number(arabic[1]);
    const chinese = text.match(/第\s*([零一二三四五六七八九十]+)\s*(?:專區|分區)/);
    return chinese ? chineseNumber(chinese[1]) : null;
  }

  function compareLabels(a, b) {
    const aNumber = ordinalNumber(a);
    const bNumber = ordinalNumber(b);
    if (aNumber != null && bNumber != null && aNumber !== bNumber) return aNumber - bNumber;
    return labelCollator.compare(String(a || ""), String(b || ""));
  }

  window.PresidentsCheckin = { config, post, showMessage, compareLabels };
})();
