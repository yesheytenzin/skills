---
name: verify-app
description: Prove a change works by driving the real app, not the test suite. Use whenever claiming a feature is done or a bug is fixed; when unit tests pass but the real flow is unverified; when setting up a project-local verify-<project> skill with boot steps, accounts, and per-feature pass criteria.
---

# Verify the App

Unit tests are not proof. Run the real surface — terminal, browser, HTTP API, or the app itself — and observe the result before saying "done". This applies to every language and framework; Rails-specific gates come from the Rails skills.

## The rule

- Decide which surface a human would use to check this change, then drive that surface. A green suite with an unrun flow is an unverified change.
- Never edit the thing you are verifying to make it verifiable. Drive it as shipped.
- If you cannot drive it, say so explicitly and name what you did instead — a reduced claim, not a green checkmark.

## Build a project verification skill

Every project gets one, committed inside the project repo: `verify-<project>/SKILL.md`. It is the checklist for "is this real yet", written once and re-run forever.

```markdown
# Verifying Acme

## Boot
`bin/dev` — ready when the log prints `Listening on http://localhost:3000` (~20s). Seed with `bin/rails db:reset`.

## Accounts
| Role | Credentials | Notes |
|---|---|---|
| admin | admin@example.test / seeded-password | full access |
| member | member@example.test / seeded-password | read-only |

## Features and how to drive them
| Feature | Flow a human clicks | Pass criteria |
|---|---|---|
| Sign in | `/login` -> email + password -> Sign in | lands on `/dashboard`, name visible in the header |
| Create order | dashboard -> New order -> fill -> Create | order appears in the list with the total entered |
```

- Boot: the exact command, the expected ready signal, and required services (db, queue, cache, external API stub).
- Accounts and fixtures: logins, tokens, seeded records, and how to reset them.
- Feature map: one row per feature a user can reach, and the exact flow a human clicks. Never "exercise the order flow" — clickable steps or a copy-pasteable command.
- Per-flow pass criteria: the observable result that means pass.
- Keep flow scripts beside it when the flow is scriptable (`verify-<project>/flows/create_order.sh`).

## Driving patterns

| Surface | Drive it | Notes |
|---|---|---|
| HTTP API | `curl -sS -o /tmp/body -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @payload.json http://host/api/v1/orders` | Assert on status **and** body; httpie: `http POST host/api/v1/orders "Authorization:Bearer $TOKEN" < payload.json` |
| Browser | Playwright/CDP script, selecting by user-visible text (`getByRole('button', { name: 'Create order' })`) | Screenshot each step; wait for elements, never `sleep` |
| CLI | `mytool run --json` | Parse the JSON; assert on fields, not on "no output" |
| Data store | Query only to confirm what the UI already showed | Never the primary evidence |

## Evidence standard

- Capture the command and its raw output together, so the reader can reproduce the run.
- UI change: a screenshot or DOM snapshot per step. API change: status line plus response body. CLI change: the parsed output.
- State what you could not drive and why — no credential, no driver installed, needs hardware, third-party sandbox.
- "Should work", "the tests pass", "the linter is clean", and "no errors in the log" are not evidence.

## Maintenance

- Re-run one pass per feature after every big merge — schema, auth, routing, dependency bumps — and update the rows in the same change.
- Every flow is runnable as-is and idempotent: create with a unique name, assert, clean up; a second run must pass on a fresh database.
- Never lean on leftover state — a logged-in session, an existing record, a warm cache. Prove it by booting from a reset database occasionally.
- A stale verification skill is worse than none. If the boot command or a flow has drifted, fix the row or delete it; never leave pass criteria that no longer describe the app.
- Keep the skill and its scripts in version control next to the code they verify.

## Anti-patterns

| Anti-pattern | Why it is not proof | Do instead |
|---|---|---|
| Mocked-out "e2e" — stubs at the boundary | proves the mock agrees with itself | run one real pass against the real dependency |
| Asserting on logs, or "no exception raised" | logs lie; silence is not success | assert on the user-visible result |
| "Works on my branch" | uncommitted files, local data, stale build | record branch + commit, or run on a clean checkout |
| Green suite with an unrun migration | the suite ran against the old schema | migrate, then suite, then drive the app |
| Happy path only | bugs live on the failure path | drive one failure: bad input, denied access, double submit |
| Manual click-through reported from memory | nobody else can reproduce it | capture the command, script, or screenshot |
