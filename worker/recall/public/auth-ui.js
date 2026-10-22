(() => {
  const gate = document.getElementById("rrAuthGate");
  const form = document.getElementById("rrAuthForm");
  const emailInput = document.getElementById("rrEmail");
  const passwordInput = document.getElementById("rrPassword");
  const confirmWrap = document.getElementById("rrConfirmWrap");
  const inviteWrap = document.getElementById("rrInviteWrap");
  const inviteInput = document.getElementById("rrInviteCode");
  const confirmInput = document.getElementById("rrPasswordConfirm");
  const submitButton = document.getElementById("rrAuthSubmit");
  const status = document.getElementById("rrAuthStatus");
  const syncStatus = document.getElementById("rrSyncStatus");
  const emailLabel = document.getElementById("rrUserEmail");
  const ACCOUNT_KEY = "recall-room-account-bound-v1";

  let mode = "login";
  let user = null;
  let currentView = document.querySelector(".view.active")?.id || "dashboard";
  let sessionUpdatedAt = 0;
  let syncTimer = null;
  let syncInFlight = false;
  let syncAgain = false;
  let lastRefreshAt = 0;

  const originalShowView = showView;
  const originalRenderPractice = renderPractice;
  const legacySnapshot = {
    state: clone(state),
    answerDrafts: clone(answerDrafts),
    currentId,
    currentView,
    sessionUpdatedAt: 0,
    updatedAt: Date.now(),
  };

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
  }

  function emptySnapshot() {
    return { state: {}, answerDrafts: {}, currentId: null, currentView: "dashboard", sessionUpdatedAt: 0, updatedAt: 0 };
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function accountPrefix(userId) {
    return `recall-room-user-v1:${userId}:`;
  }

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch { return fallback; }
  }

  function readAccountSnapshot(userId) {
    const prefix = accountPrefix(userId);
    const cachedState = localStorage.getItem(prefix + "state");
    const cachedDrafts = localStorage.getItem(prefix + "drafts");
    if (cachedState !== null || cachedDrafts !== null) {
      const savedSession = readJson(prefix + "session", {});
      return {
        state: readJson(prefix + "state", {}),
        answerDrafts: readJson(prefix + "drafts", {}),
        currentId: typeof savedSession.currentId === "string" ? savedSession.currentId : null,
        currentView: ["dashboard", "practice", "deck"].includes(savedSession.currentView) ? savedSession.currentView : "dashboard",
        sessionUpdatedAt: Number(savedSession.sessionUpdatedAt) || 0,
        updatedAt: Number(savedSession.updatedAt) || 0,
      };
    }
    // Import the old anonymous browser cache only once, before this browser has been bound to an account.
    if (!localStorage.getItem(ACCOUNT_KEY)) return clone(legacySnapshot);
    return emptySnapshot();
  }

  function writeAccountSnapshot(snapshot) {
    if (!user) return;
    const prefix = accountPrefix(user.id);
    try {
      localStorage.setItem(prefix + "state", JSON.stringify(snapshot.state || {}));
      localStorage.setItem(prefix + "drafts", JSON.stringify(snapshot.answerDrafts || {}));
      localStorage.setItem(prefix + "session", JSON.stringify({
        currentId: snapshot.currentId || null,
        currentView: snapshot.currentView || "dashboard",
        sessionUpdatedAt: Number(snapshot.sessionUpdatedAt) || 0,
        updatedAt: Number(snapshot.updatedAt) || Date.now(),
      }));
      localStorage.setItem(ACCOUNT_KEY, user.id);
      // Remove the old shared cache after its one-time import so another account on this browser cannot inherit it.
      localStorage.removeItem(STORAGE);
      localStorage.removeItem(ANSWER_KEY);
    } catch {
      setSyncLabel("本機空間不足", "error");
    }
  }

  function unpackSnapshot(input) {
    const value = isObject(input) ? clone(input) : emptySnapshot();
    value.state = isObject(value.state) ? value.state : {};
    value.answerDrafts = isObject(value.answerDrafts) ? value.answerDrafts : {};
    for (const draft of Object.values(value.answerDrafts)) {
      if (isObject(draft) && Array.isArray(draft.strokes)) {
        const first = draft.strokes[0];
        if (!first || Array.isArray(first)) draft.strokes = unpackStrokes(draft.strokes);
      }
    }
    value.currentId = typeof value.currentId === "string" && cards.some((card) => card.id === value.currentId) ? value.currentId : null;
    value.currentView = ["dashboard", "practice", "deck"].includes(value.currentView) ? value.currentView : "dashboard";
    value.sessionUpdatedAt = Number(value.sessionUpdatedAt) || 0;
    value.updatedAt = Number(value.updatedAt) || 0;
    return value;
  }

  function packSnapshot(input) {
    const value = clone(input);
    const packedDrafts = {};
    for (const [id, draft] of Object.entries(value.answerDrafts || {})) {
      if (!isObject(draft)) continue;
      packedDrafts[id] = { ...draft, strokes: packStrokes(draft.strokes) };
    }
    value.answerDrafts = packedDrafts;
    return value;
  }

  function cardVersion(item) {
    return Math.max(Number(item?.updatedAt) || 0, Number(item?.dueAt) || 0);
  }

  function mergeSnapshots(localInput, remoteInput) {
    const local = unpackSnapshot(localInput);
    const remote = unpackSnapshot(remoteInput);
    const mergedState = {};
    const ids = new Set([...Object.keys(local.state), ...Object.keys(remote.state)].filter((id) => !id.startsWith("_")));
    for (const id of ids) {
      const left = local.state[id];
      const right = remote.state[id];
      if (!left) mergedState[id] = right;
      else if (!right) mergedState[id] = left;
      else if ((Number(left.reviewCount) || 0) !== (Number(right.reviewCount) || 0)) {
        mergedState[id] = (Number(left.reviewCount) || 0) > (Number(right.reviewCount) || 0) ? left : right;
      } else {
        mergedState[id] = cardVersion(left) >= cardVersion(right) ? left : right;
      }
    }

    const gradeResults = {};
    for (const id of new Set([
      ...Object.keys(local.state._gradeResults || {}),
      ...Object.keys(remote.state._gradeResults || {}),
    ])) {
      const left = local.state._gradeResults?.[id];
      const right = remote.state._gradeResults?.[id];
      gradeResults[id] = !left ? right : !right ? left : (Number(left.gradedAt) || 0) >= (Number(right.gradedAt) || 0) ? left : right;
    }
    if (Object.keys(gradeResults).length) mergedState._gradeResults = gradeResults;

    const latestSession = local.sessionUpdatedAt >= remote.sessionUpdatedAt ? local : remote;
    if (latestSession.state._adaptiveNextId) mergedState._adaptiveNextId = latestSession.state._adaptiveNextId;

    const drafts = {};
    for (const id of new Set([...Object.keys(local.answerDrafts), ...Object.keys(remote.answerDrafts)])) {
      const left = local.answerDrafts[id];
      const right = remote.answerDrafts[id];
      drafts[id] = !left ? right : !right ? left : (Number(left.savedAt) || 0) >= (Number(right.savedAt) || 0) ? left : right;
    }

    return {
      state: mergedState,
      answerDrafts: drafts,
      currentId: latestSession.currentId,
      currentView: latestSession.currentView,
      sessionUpdatedAt: Math.max(local.sessionUpdatedAt, remote.sessionUpdatedAt),
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    };
  }

  function currentSnapshot() {
    return {
      state,
      answerDrafts,
      currentId: currentId || null,
      currentView,
      sessionUpdatedAt: sessionUpdatedAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  function setSyncLabel(text, stateName = "ok") {
    if (!syncStatus) return;
    syncStatus.textContent = text;
    syncStatus.dataset.state = stateName;
  }

  function setAuthStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function errorMessage(code) {
    const messages = {
      INVALID_EMAIL: "請輸入有效的電子郵件地址。",
      PASSWORD_REQUIRED: "請輸入密碼。",
      INVALID_PASSWORD: "密碼須為 12 至 128 個字元。",
      INVALID_INVITE_CODE: "邀請碼無效或註冊尚未開放。",
      REGISTRATION_DISABLED: "註冊尚未開放，請聯絡管理者。",
      EMAIL_ALREADY_REGISTERED: "這個電子郵件已建立帳號，請改用登入。",
      INVALID_CREDENTIALS: "電子郵件或密碼不正確。",
      AUTH_RATE_LIMIT: "嘗試次數過多，請稍後再試。",
      AUTH_STORAGE_NOT_CONFIGURED: "帳號資料庫尚未連線，請稍後再試。",
      AUTH_STORAGE_ERROR: "帳號服務暫時無法使用，請稍後再試。",
      PROGRESS_STORAGE_ERROR: "進度同步暫時無法使用；作答仍會保留在此裝置。",
      PROGRESS_TOO_LARGE: "草稿資料太大，請清理較舊的手寫內容後再同步。",
      SAME_ORIGIN_ONLY: "安全檢查未通過，請重新整理頁面後再試。",
    };
    return messages[code] || "目前無法完成操作，請確認網路後再試。";
  }

  async function apiJson(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }

  async function activateUser(authenticatedUser) {
    const local = readAccountSnapshot(authenticatedUser.id);
    let remote = emptySnapshot();
    let cloudAvailable = true;
    try {
      const { response, payload } = await apiJson("/api/progress");
      if (!response.ok) throw new Error(payload.code || "PROGRESS_STORAGE_ERROR");
      remote = unpackSnapshot(payload.snapshot);
    } catch (error) {
      cloudAvailable = false;
      showToast("雲端同步暫不可用；本機草稿會保留");
    }

    const merged = mergeSnapshots(local, remote);
    user = authenticatedUser;
    state = merged.state;
    answerDrafts = merged.answerDrafts;
    currentId = merged.currentId;
    currentView = merged.currentView;
    sessionUpdatedAt = merged.sessionUpdatedAt;
    pendingNextCardId = state._adaptiveNextId || null;

    if (emailLabel) emailLabel.textContent = authenticatedUser.email;
    gate?.classList.add("is-hidden");
    document.querySelector(".shell")?.removeAttribute("inert");
    document.querySelector(".mobile-nav")?.removeAttribute("inert");
    setSyncLabel(cloudAvailable ? "雲端已同步" : "僅本機暫存", cloudAvailable ? "ok" : "error");
    updateCounts();
    renderDeck();
    const viewToRestore = currentView;
    showView(viewToRestore);
    writeAccountSnapshot(currentSnapshot());
    if (cloudAvailable) queueSync(250);
  }

  function setMode(nextMode) {
    mode = nextMode === "register" ? "register" : "login";
    document.querySelectorAll("[data-auth-mode]").forEach((button) => {
      const active = button.dataset.authMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (confirmWrap) confirmWrap.hidden = mode !== "register";
    if (inviteWrap) inviteWrap.hidden = mode !== "register";
    if (inviteInput) inviteInput.required = mode === "register";
    if (passwordInput) passwordInput.autocomplete = mode === "register" ? "new-password" : "current-password";
    if (confirmInput) confirmInput.required = mode === "register";
    if (submitButton) submitButton.textContent = mode === "register" ? "建立帳號並開始" : "登入並接續進度";
    setAuthStatus(mode === "register" ? "建立帳號後，這台裝置的既有試用進度會匯入帳號。" : "登入後會載入同一帳號最近一次的題目與草稿。");
  }

  function queueSync(delay = 700) {
    if (!user) return;
    writeAccountSnapshot(currentSnapshot());
    setSyncLabel("同步中…", "busy");
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { void syncNow(); }, delay);
  }

  async function syncNow() {
    if (!user) return false;
    if (syncInFlight) {
      syncAgain = true;
      return false;
    }
    syncInFlight = true;
    syncAgain = false;
    setSyncLabel("同步中…", "busy");
    try {
      const payload = packSnapshot(currentSnapshot());
      const { response, payload: result } = await apiJson("/api/progress", {
        method: "PUT",
        body: JSON.stringify({ snapshot: payload }),
      });
      if (!response.ok) throw new Error(result.code || "PROGRESS_STORAGE_ERROR");
      setSyncLabel("雲端已同步", "ok");
      writeAccountSnapshot(currentSnapshot());
      return true;
    } catch (error) {
      setSyncLabel("本機暫存・待同步", "error");
      return false;
    } finally {
      syncInFlight = false;
      if (syncAgain && user) queueSync(100);
    }
  }

  function touchSession() {
    if (!user) return;
    sessionUpdatedAt = Date.now();
    queueSync(700);
  }

  saveState = function saveAccountState(nextState) {
    if (!user) return;
    state = nextState;
    queueSync(700);
  };

  saveAnswerDrafts = function saveAccountDrafts() {
    if (!user) return;
    queueSync(900);
  };

  showView = function showAccountView(id) {
    originalShowView(id);
    currentView = id;
    touchSession();
  };

  renderPractice = function renderAccountPractice(...args) {
    const before = currentId;
    const result = originalRenderPractice(...args);
    if (user) {
      if (currentId !== before) sessionUpdatedAt = Date.now();
      queueSync(900);
    }
    return result;
  };

  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.authMode));
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = String(emailInput?.value || "").trim().toLowerCase();
    const password = String(passwordInput?.value || "");
    if (mode === "register" && password !== String(confirmInput?.value || "")) {
      setAuthStatus("兩次輸入的密碼不一致。", true);
      confirmInput?.focus();
      return;
    }
    if (mode === "register" && (password.length < 12 || password.length > 128)) {
      setAuthStatus("密碼須為 12 至 128 個字元。", true);
      passwordInput?.focus();
      return;
    }
    const inviteCode = String(inviteInput?.value || "").trim();
    if (mode === "register" && !inviteCode) {
      setAuthStatus("請輸入邀請碼。", true);
      inviteInput?.focus();
      return;
    }
    const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = "處理中…"; }
    setAuthStatus(mode === "register" ? "正在建立帳號…" : "正在登入並載入進度…");
    try {
      const { response, payload } = await apiJson(endpoint, {
        method: "POST",
        body: JSON.stringify(mode === "register" ? { email, password, inviteCode } : { email, password }),
      });
      if (!response.ok) {
        setAuthStatus(errorMessage(payload.code), true);
        return;
      }
      await activateUser(payload.user);
      if (mode === "register") showToast("帳號已建立，已匯入本機試用進度");
      else showToast("已載入帳號的最新複習進度");
      passwordInput.value = "";
      if (confirmInput) confirmInput.value = "";
      if (inviteInput) inviteInput.value = "";
    } catch {
      setAuthStatus("連線失敗，請確認網路後再試。", true);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = mode === "register" ? "建立帳號並開始" : "登入並接續進度";
      }
    }
  });

  document.getElementById("rrLogoutBtn")?.addEventListener("click", async () => {
    if (!user) return;
    const synced = await syncNow();
    try {
      const { response } = await apiJson("/api/auth/logout", { method: "POST", body: "{}" });
      if (!response.ok) throw new Error("LOGOUT_FAILED");
    } catch {
      showToast("無法連線完成登出；請確認網路後再試");
      return;
    }
    user = null;
    emailInput.value = "";
    passwordInput.value = "";
    if (confirmInput) confirmInput.value = "";
    gate?.classList.remove("is-hidden");
    document.querySelector(".shell")?.setAttribute("inert", "");
    document.querySelector(".mobile-nav")?.setAttribute("inert", "");
    setSyncLabel("已登出", "idle");
    setAuthStatus("已登出。再次登入即可載入自己的雲端進度。");
    setMode("login");
    showToast(synced ? "已安全登出" : "已登出；未同步的進度仍保留在本機");
  });

  async function refreshFromCloud() {
    if (!user || document.visibilityState !== "visible" || Date.now() - lastRefreshAt < 3_000) return;
    lastRefreshAt = Date.now();
    try {
      const { response, payload } = await apiJson("/api/progress");
      if (!response.ok) return;
      const before = currentSnapshot();
      const remote = unpackSnapshot(payload.snapshot);
      const merged = mergeSnapshots(before, remote);
      const sessionChanged = remote.sessionUpdatedAt > before.sessionUpdatedAt && remote.currentId !== before.currentId;
      state = merged.state;
      answerDrafts = merged.answerDrafts;
      currentId = merged.currentId;
      currentView = merged.currentView;
      sessionUpdatedAt = merged.sessionUpdatedAt;
      pendingNextCardId = state._adaptiveNextId || null;
      writeAccountSnapshot(currentSnapshot());
      updateCounts();
      renderDeck();
      const editing = ["answerInput", "answerCanvas"].includes(document.activeElement?.id);
      if (sessionChanged && !editing) {
        originalShowView(currentView);
        showToast("已接續另一裝置的最新題目與進度");
      }
    } catch { /* Keep the last local snapshot if the network is unavailable. */ }
  }

  window.addEventListener("online", () => { if (user) void syncNow(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshFromCloud();
    else if (user) void syncNow();
  });
  window.addEventListener("pagehide", () => {
    if (user) writeAccountSnapshot(currentSnapshot());
  });

  async function boot() {
    setMode("login");
    setAuthStatus("正在確認登入狀態…");
    try {
      const { response, payload } = await apiJson("/api/auth/me");
      if (response.ok && payload.authenticated && payload.user) {
        await activateUser(payload.user);
      } else if (!response.ok) {
        setAuthStatus(errorMessage(payload.code), true);
      } else {
        setAuthStatus("請登入或建立帳號；成功後會自動接續學習進度。");
      }
    } catch {
      setAuthStatus("無法連線帳號服務。進度仍留在本機；連線恢復後可再登入同步。", true);
    }
  }

  void boot();
})();
