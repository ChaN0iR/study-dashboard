# Backend integration validation

Evidence-only integration branch based on PR #12 at 40299d6da492e9bd88476104103c672c7f77b1ec, which includes #3 and #2.
Imports the complete CI workflow and corrected shipped-Widget regression from PR #5 at 6681101a6884f2789a0dea0ec741b69804f9f438.
The only workflow adaptation is accepting PRs targeting the #12 branch as well as main.

## Required evidence

All three jobs must succeed at the integration head: Worker tests and bundle, Frontend tests, Dependency security audit.
The Worker npm test script inherited from #12 includes image prevalidation, security regressions and password policy tests. External services are mocked; bundling uses --dry-run only.
Frontend checkout retains full history for achievement baselines. The Widget test runs existing selection behavior; no Sunday/meal policy is introduced. Twelve browser-dependent frontend checks may still skip in this job; Chromium evidence remains separately tracked in #10/#14 and does not automatically certify this integration head.

## Review and limits

This is a stacked Draft targeting #12, not a replacement for #2/#3/#5/#12 and not a merge recommendation. Review the full combined diff before later owner-approved integration. Revalidate after any base/head changes. No main merge, deployment, production database/Notion calls, secrets, model APIs or paid runners. The dependency audit uses npm's advisory registry; registry failure fails the job.

Primary writer: current chat 01a156d7-532f-78d1-a051-46a6d5313e87. Source PRs remain unchanged. Validation results belong to the exact SHA reported in the PR body, not to source branches retroactively.
