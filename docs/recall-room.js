(() => {
  "use strict";
  const link = document.getElementById("recall-room-open");
  const shortcut = document.getElementById("recall-room-shortcut");
  const links = [link, shortcut].filter(Boolean);
  const status = document.getElementById("recall-room-status");
  if (!link) return;
  try {
    const base = localStorage.getItem("apiBase") || window.CONFIG?.API_BASE;
    const url = new URL(base);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("invalid API origin");
    if (url.username || url.password) throw new Error("credentials in URL");
    // Open as a top-level page: account cookies stay first-party on iPhone/iPad.
    // Never append the dashboard APP_KEY, email, answers or other private data.
    for (const item of links) { item.href = new URL("/recall/", url.origin).href; item.removeAttribute("aria-disabled"); }
    if (status) status.textContent = "登入回想室同一帳號，即可接續題目與草稿。";
  } catch {
    for (const item of links) { item.removeAttribute("href"); item.setAttribute("aria-disabled", "true"); }
    if (status) status.textContent = "請先設定有效的儀表板 API 位址，再開啟回想室。";
  }
})();
