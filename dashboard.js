(function () {
  "use strict";

  const { post, showMessage } = window.PresidentsCheckin;
  const message = document.getElementById("dashboardMessage");
  const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname)
    && new URLSearchParams(location.search).get("preview") === "1";

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

  async function refresh() {
    try {
      const result = localPreview ? {
        event: { event_date: "2026-06-20", name: "會長聯誼會系統測試" },
        totalCount: 114,
        attendedCount: 36,
        absentCount: 78,
        attendanceRate: 31.6,
        list: [
          { name: "預覽會長", club: "預覽", checkin_at: new Date().toISOString(), source: "LINE" },
          { name: "測試會長", club: "測試", checkin_at: new Date().toISOString(), source: "ADMIN" }
        ]
      } : await post({ action: "dashboard" });
      document.getElementById("dashboardEventName").textContent = result.event
        ? result.event.name
        : "目前沒有開放簽到的活動";
      document.getElementById("dashboardEventMeta").textContent = result.event
        ? result.event.event_date
        : "開放活動後，此頁會自動顯示即時出席狀況。";
      document.getElementById("dashboardTotal").textContent = result.totalCount || 0;
      document.getElementById("dashboardAttended").textContent = result.attendedCount || 0;
      document.getElementById("dashboardAbsent").textContent = result.absentCount || 0;
      document.getElementById("dashboardRate").textContent = result.attendanceRate || 0;
      document.getElementById("dashboardProgressBar").style.width = `${Math.min(100, result.attendanceRate || 0)}%`;
      document.getElementById("dashboardUpdatedAt").textContent = `更新 ${formatTime(new Date().toISOString())}`;
      const people = document.getElementById("dashboardPeople");
      people.replaceChildren(...(result.list || []).map(personCard));
      document.getElementById("dashboardEmpty").classList.toggle("hidden", result.list && result.list.length > 0);
      showMessage(message, "", "");
    } catch (error) {
      showMessage(message, error.message, "error");
    }
  }

  refresh();
  if (!localPreview) setInterval(refresh, 5000);
})();
