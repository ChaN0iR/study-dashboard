# CI checks

This workflow runs on pull requests targeting main, pushes to main, and manual dispatch.
It runs the locked offline Worker suite, the password policy suite, a Wrangler dry-run bundle, frontend tests, and a dependency security audit in separate jobs.
It never deploys, applies migrations, provides production secrets, or calls the live application.
Only the built-in read-only repository token is available; checkout does not persist credentials.
Actions are pinned to commit SHAs. Node 24 matches local validation. Dependency install scripts are disabled.
A dry run validates packaging only, not production configuration.

The audit queries npm advisories for the worker lockfile, including development tools, and fails on high/critical findings or registry errors. It runs independently so test failures do not prevent it. No automatic dependency fixes are applied. A clean audit is not a source-code security review.

## Review of the supplied CI proposal

The repository has no root package.json or root lockfile; npm commands and caching must point to worker/. The frontend uses Node's test runner, not Vitest, so it runs with node --test docs/*.test.mjs. There are no lint, typecheck, test:frontend or test:backend scripts. Optional script checks and success fallbacks would hide missing coverage; required tests and bundling fail directly. Node 20 is unsuitable because locked Cloudflare dependencies require Node >=22; retain tested Node 24. Only main currently needs a branch filter. Keep read-only permissions, pinned actions, timeouts, and disabled persisted credentials.

Adopted from the proposal: a separate npm audit gate, verified locally with zero reported vulnerabilities on 2026-10-19. The audit may change as npm advisories change.

## Widget regression test correction (2026-10-19)

The missing widgetTaskModel and extraction anchors were stale test assumptions: the shipped Widget has no such model, Sunday course exclusion, or lunch visibility filter. Test the actual selection statements instead, including skipped/completed rows, order, slot fit, empty input and input immutability. scriptable-widget.js and all product behavior remain unchanged. This does not implement the old test's proposed policy. That policy needs a separate product decision. Local Node 24 frontend suite: 119 tests, 107 passed, 0 failed, 12 existing visual skips.

## Historical blockers and scope

This PR is independently based on main ec6ed83 and does not include PR #2, #3, or #4.
PR #3 contains PR #2 and should be reviewed after it. PR #4 is independent documentation.

On 2026-10-19, a clean LF checkout of main and PR #3 both produced 119 frontend tests:
106 passed, 1 failed, 12 skipped. The failure at docs/rest-day-policy.test.mjs:72 calls
widgetTaskModel, which scriptable-widget.js does not define. Its extraction anchors
WIDGET_STUDY_TASK_TYPES and const today = are also absent. This requires reconciling
the expected Widget behavior with the current implementation; this CI PR does not change product behavior.
The job deliberately fails on this regression. No continue-on-error, filtering, or additional skips are used.
The existing twelve skipped tests remain unverified.

Windows CRLF checkouts produce additional source-extraction failures.
Linux CI uses LF. PR #3 fixes the separate Windows runtime file-URL issue and Recall asset newline comparisons.
This does not imply the current main Worker suite has passed on Windows.

PR #3 at 551118a passed the full offline Worker suite and Wrangler dry-run locally on Windows/Node 24.
The initial CI run (39265122750) passed Worker tests and bundling on Ubuntu/Node 24; frontend failed. Main has not been claimed to pass locally on Windows.
The workflow in this PR does not retroactively add checks to the old heads of PR #2, #3, or #4.
After this workflow reaches main through a separately authorized merge, update those PR branches
and require all three job checks in repository protection rules as a separate administrator action.
Until then, absence of checks on those PRs is not evidence of success.

