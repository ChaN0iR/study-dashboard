import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fetchRecallAsset } from "../worker/recall/assets.generated.js";

// Execute the shipped UI with a small DOM and strictly local fetch responses.
async function harness({ errorCode = "INVALID_INVITE_CODE", source = readFileSync(new URL("./recall/auth-ui.js", import.meta.url), "utf8") } = {}) {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", dataset: {}, listeners: {}, hidden: false,
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute() {}, removeAttribute() {}, focus() {},
    });
    return nodes.get(id);
  }
  const modes = ["login", "register"].map(mode => {
    const button = element(mode); button.dataset.authMode = mode; return button;
  });
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => modes, addEventListener() {} },
    window: { addEventListener() {} }, localStorage: { getItem: () => null },
    state: {}, answerDrafts: {}, currentId: null, showView() {}, renderPractice() {},
    Date, setTimeout() {}, clearTimeout() {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      return { ok: path === "/api/auth/me", json: async () => path === "/api/auth/me" ? { authenticated: false } : { code: errorCode } };
    },
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve)); // Let the real boot request settle before interacting.
  return {
    element, calls,
    mode: mode => element(mode).listeners.click(),
    submit: () => element("rrAuthForm").listeners.submit({ preventDefault() {} }),
  };
}

test("registration UI checks confirmation, invite and 12–128 password limits before submitting", async () => {
  const h = await harness();
  h.mode("register");
  assert.equal(h.element("rrInviteWrap").hidden, false);
  assert.equal(h.element("rrInviteCode").required, true);
  h.element("rrEmail").value = " Student@Example.com ";
  for (const password of ["x".repeat(11), "x".repeat(129)]) {
    h.element("rrPassword").value = h.element("rrPasswordConfirm").value = password;
    h.element("rrInviteCode").value = "valid-test-invite";
    await h.submit();
    assert.equal(h.calls.filter(c => c.path === "/api/auth/register").length, 0);
    assert.match(h.element("rrAuthStatus").textContent, /12.*128/);
  }
  h.element("rrPassword").value = h.element("rrPasswordConfirm").value = "x".repeat(12);
  h.element("rrInviteCode").value = "  ";
  await h.submit();
  assert.match(h.element("rrAuthStatus").textContent, /請輸入邀請碼/);
  assert.equal(h.calls.filter(c => c.path === "/api/auth/register").length, 0);
  h.element("rrInviteCode").value = " valid-test-invite ";
  h.element("rrPasswordConfirm").value = "mismatched";
  await h.submit();
  assert.match(h.element("rrAuthStatus").textContent, /不一致/);
  for (const length of [12, 128]) {
    h.element("rrPassword").value = h.element("rrPasswordConfirm").value = "x".repeat(length);
    await h.submit();
    const { path, options } = h.calls.at(-1);
    assert.equal(path, "/api/auth/register");
    assert.deepEqual(JSON.parse(options.body), { email: "student@example.com", password: "x".repeat(length), inviteCode: "valid-test-invite" });
    assert.equal(options.cache, "no-store");
    assert.match(h.element("rrAuthStatus").textContent, /邀請碼無效/);
    assert.equal(h.element("rrAuthSubmit").disabled, false);
  }
});

test("server password-length rejection displays actionable message in Pages, Worker source and bundled UI", async () => {
  const bundled = fetchRecallAsset(new Request("https://offline.example/auth-ui.js"));
  assert.equal(bundled.status, 200);
  const sources = [
    ["Pages", readFileSync(new URL("./recall/auth-ui.js", import.meta.url), "utf8")],
    ["Worker source", readFileSync(new URL("../worker/recall/public/auth-ui.js", import.meta.url), "utf8")],
    ["Worker bundle", await bundled.text()],
  ];
  for (const [label, source] of sources) {
    const h = await harness({ errorCode: "PASSWORD_LENGTH_INVALID", source });
    h.mode("register");
    h.element("rrEmail").value = "student@example.com";
    h.element("rrPassword").value = h.element("rrPasswordConfirm").value = "valid-password";
    h.element("rrInviteCode").value = "offline-test-invite";
    await h.submit();
    assert.equal(h.calls.at(-1).path, "/api/auth/register", label);
    assert.equal(h.element("rrAuthStatus").textContent, "密碼須為 12 至 128 個字元。", label);
    assert.equal(h.element("rrAuthSubmit").disabled, false, label);
    assert.equal(h.element("rrPassword").value, "valid-password", "rejected submission keeps input for correction");
  }
});

test("login hides the invite and submits legacy passwords without registration constraints", async () => {
  const h = await harness();
  h.mode("register"); h.mode("login");
  assert.equal(h.element("rrInviteWrap").hidden, true);
  assert.equal(h.element("rrInviteCode").required, false);
  h.element("rrEmail").value = "legacy@example.com";
  h.element("rrPassword").value = "short";
  h.element("rrInviteCode").value = "must-not-send";
  await h.submit();
  assert.equal(h.calls.at(-1).path, "/api/auth/login");
  assert.deepEqual(JSON.parse(h.calls.at(-1).options.body), { email: "legacy@example.com", password: "short" });
});
