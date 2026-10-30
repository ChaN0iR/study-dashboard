# V2 live UI bridge (opt-in only)

This first production-source integration is a **read-only UI layer** on the original Study Dashboard. It is not the isolated V2 demo, and it does not introduce new task/focus APIs, stores, or timers.

## Open the design

With a **branch preview/server** running this candidate, add `?ui=v2` to the original `docs/index.html` URL. For a data-free review use `?demo=1&ui=v2` (the existing app provides synthetic demo tasks; the bridge only observes them). Remove `ui=v2` or use the "返回原版" link to return to the unmodified default screen. The setting is intentionally not saved.

**Important:** this PR is not merged or deployed. The current production GitHub Pages site does NOT have this switch.

## Authority and behavior

- `docs/app.js` is changed only to conditionally import `ui-live-v2.js` when `ui=v2` appears. Without the flag no new module, CSS, or DOM subtree is loaded.
- `ui-live-v2.js` observes **rendered** `#tasks`, `#task-count`, `#banner`, and existing policy note. It displays the first **actionable nonblocked task** in the current authoritative sort; it never stores a second task list or calls the API.
- The hero never marks optimistic updates as verified. Disabled pending checkboxes are noted as unconfirmed; API errors, missing count, or stale Taiwan date display an unverified warning. A successful `/api/state` load sets `#tasks[data-state-verified=true]`; a failed **silent** refresh sets it to `false`, and the V2 hero disables its action and marks cached same-day data unverified until the next successful load.
- "查看任務" navigates to/focuses the existing task row, where the normal task guard, Notion sync, pending state, and rollback apply unchanged.
- "前往專注計時" **only focuses** the existing `#fc-main` on the record tab; it never clicks that control or issues a focus API call (clicking the original main button can stop an active session).
- UI-only CSS is loaded on opt-in and scoped under `body.sd-v2-live`. The existing cards, XP, schedule, Recall Room, notes, and focus timer remain the original implementations. No new persisted preference.
- All task titles are inserted with `textContent`, not interpolated HTML.

## Verification

```sh
node --test docs/ui-live-v2.test.mjs
python docs/ui-live-v2.browser.py
```

Browser test launches a loopback-only server and Chromium with fixed Taiwan daytime, covering three desktop/mobile viewports × two color schemes and two additional true app API-flow rejection cases. The latter simulate `GET /api/state`, `GET /api/focus` and a rejected task mutation to verify rollback/unverified state, with synthetic credentials and no real server.

Screenshots and JSON evidence appear in the `live-ui-v2` Actions artifact.

## Combined PWA + V2 release candidate

This integration branch combines #39 and #42 on their common main base without changing or merging either original PR.

- **Original iPhone-tested #43** uses `app.js?v=123` / `sd-v138`. The stacked silent-refresh hardening candidate uses `app.js?v=124` / `sd-v139`; it is a **distinct** candidate and requires a separate release acceptance decision. Both versions must move together.
- Install-time static shell now also contains `ui-live-v2.js` and `ui-live-v2.css?v=1` so `?demo=1&ui=v2` can load the optional card while offline. Assets are fetched anonymously, no redirects, and rejected if marked private/no-store.
- All runtime same-origin requests still bypass HTTP cache and are **never** added to CacheStorage; offline fallback only serves exact static shell URLs, not API data.
- `docs/service-worker-security.test.mjs` checks exact URL matching for optional modules, and `docs/ui-v2-offline.browser.py` launches a real Chromium PWA, installs SW online, then reloads the isolated demo while offline.
- The default site still uses the original screens and action handlers. This does not replace the XP, task or focus data model.

## Unfinished release gates

1. **All** integration CI checks must succeed on the same HEAD: PWA privacy/Chromium, opt-in browser with synthetic API failure, offline PWA reload, and original desktop/Recall regression suite. Treat failures as blockers.
2. Verify on a separate HTTPS test site and actual iPhone Installed PWA (including old-to-new upgrade and accessibility). Do not test against live study data without authorization.
3. Coordinate merging/superseding PR #39 and #42; this branch intentionally includes both. **Never merge this together with those PRs blindly**.
4. Obtain explicit permission for any merge and release. The main GitHub Pages site and Cloudflare Worker are not modified by this branch.

PR #40 remains a separate synthetic design concept. This candidate is a **vertical slice**, not the entire V2 visual redesign; the remaining panels should be migrated incrementally only after their actual data contracts are understood.
