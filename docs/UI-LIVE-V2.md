# V2 live UI bridge (opt-in only)

This first production-source integration is a **read-only UI layer** on the original Study Dashboard. It is not the isolated V2 demo, and it does not introduce new task/focus APIs, stores, or timers.

## Open the design

With a **branch preview/server** running this candidate, add `?ui=v2` to the original `docs/index.html` URL. For a data-free review use `?demo=1&ui=v2` (the existing app provides synthetic demo tasks; the bridge only observes them). Remove `ui=v2` or use the "返回原版" link to return to the unmodified default screen. The setting is intentionally not saved.

**Important:** this PR is not merged or deployed. The current production GitHub Pages site does NOT have this switch.

## Authority and behavior

- `docs/app.js` is changed only to conditionally import `ui-live-v2.js` when `ui=v2` appears. Without the flag no new module, CSS, or DOM subtree is loaded.
- `ui-live-v2.js` observes **rendered** `#tasks`, `#task-count`, `#banner`, and existing policy note. It displays the first **actionable nonblocked task** in the current authoritative sort; it never stores a second task list or calls the API.
- The hero never marks optimistic updates as verified. Disabled pending checkboxes are noted as unconfirmed; API errors, missing count, or stale Taiwan date display an unverified warning.
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

## Unfinished release gates

1. Current PWA shell is `app.js?v=122`, `sd-v136`; the candidate changes `app.js` but **deliberately leaves `docs/index.html` and `docs/sw.js` untouched**. Prior to any merge/deployment, coordinate a single version bump of `app.js`, SW shell and related snapshot tests **on top of #39** (its `sd-v137` privacy fix). Without this, an installed PWA could use stale `app.js`.
2. Validate the flag on a separate HTTPS test site, including iPhone Installed PWA and no data disclosure. Do not test against real study data until authorized.
3. Check performance/accessibility at narrow landscape viewports, dark mode, keyboard navigation, and Offline. Confirm no duplicated tasks or writes and rollback after API rejection.
4. Obtain explicit merge/deployment approval. Do not promote this branch by itself to GitHub Pages.

PR #40 remains a separate synthetic design concept. This candidate is a **vertical slice**, not the entire V2 visual redesign; the remaining panels should be migrated incrementally only after their actual data contracts are understood.
