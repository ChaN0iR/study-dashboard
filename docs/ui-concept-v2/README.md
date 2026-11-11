# UI Concept V2 — review-only, no production data

This folder contains a standalone, responsive Study Dashboard user-interface concept. All four tabs, tasks, study durations, and focus sessions are **synthetic**. No credential, API request, localStorage, service worker, Notion, Cloudflare Worker, or actual student record is used.

## Changes from the previous concept

- The "next learning action" card tracks the first incomplete demo task instead of remaining hard-coded.
- Completing a task updates the headline, progress meter, status, and suggested focus duration.
- The simulated timer follows the selected task duration, but an active or paused timer does not jump when a different task is checked.
- Completing all tasks disables the start button.
- Desktop navigation and fixed mobile tabs still work; light/dark, narrow screens, reduced motion, accessible focus indicators retained.
- No artificial study result is presented as verified production data.

## Test

From the repository root:

```sh
node --test docs/ui-concept-v2/preview.test.mjs
python3 docs/ui-concept-v2/browser.test.py
```

The browser test requires Playwright for Python and Chromium. GitHub Actions `ui-concept-v2.yml` runs both steps and uploads screenshots from four viewports, two color schemes (8 combinations), and checks no external requests or saved draft data.

## Real product integration mapping (future PR, **not part of this preview**)

| Concept | Existing authoritative UI / state | Integration constraint |
| --- | --- | --- |
| Hero next action | `#now`, `#tasks`, `state.tasks`, scheduling policy | Derive from the existing task renderer; never create a second task completion engine |
| Task progress | `#task-count`, `#task-prog-i`, `#tasks` | Only confirmed writes update the real completion state; preserve rollback behavior |
| Focus timer | `#focus`, `#fc-main`, `/api/focus` | Reuse persisted focus sessions; **do not ship the local demo timer** |
| Recall Room | `#recall-room-open`, Recall authentication & permissions | Do not silently enable grading or bypass auth |
| XP / lessons | `#achievement-summary`, `#lessons` | Reuse established XP calculation and validation |
| Record / notes | `#save-record`, `#save-note` | Preserve unsaved draft state and Notion API write guards |

Do not copy the preview's fake statistics, timer implementation, or demo-checkbox mutations into the production application.

## Suggested next implementation gate

1. Add an **opt-in only** UI adapter to the existing app (e.g. a separate branch and gated query flag). Show current state without introducing a new data layer; default UX unchanged.
2. On that branch verify: task completion + rejection rollback, correct schedule, timer resume/restore, offline draft, 320–1440px light/dark, keyboard and accessibility, screenshot changes reviewed.
3. Rebase against PR #39 PWA cache changes to update asset versions and cache manifest deliberately; do not change `docs/sw.js` here.
4. Require explicit authorization for any main merge/release. No production deployments or data writes are performed by this UI preview.

This PR intentionally changes only `docs/ui-concept-v2/*` and its own CI workflow, keeping PR #38 and #39 untouched.
