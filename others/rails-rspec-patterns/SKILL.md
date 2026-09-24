---
name: rails-rspec-patterns
description: Deeper RSpec practice for a Rails app — choosing a spec type, factories vs fixtures, WebMock, SimpleCov, determinism, and debugging or speeding up a red suite. Use when picking a spec type, writing or refactoring specs, chasing a flaky or failing example, or deciding whether a bug fix has a real regression test.
---

# Rails RSpec Patterns

`rails-conventions` covers the RSpec basics. This is the practice on top: which spec type proves what, how to keep test data honest, and how to get green without cheating.

## Pick the spec type

| Spec | Proves | Wrong tool when |
|---|---|---|
| `spec/models` | domain rules: validations, scopes, calculations, transitions | the behavior only exists above the model |
| `spec/requests` | the full HTTP path: route, params, auth, status, body, side effects | you only assert a class or method in isolation |
| `spec/system` | a real user flow through the browser | you need speed or precise unit feedback |
| `spec/jobs` | enqueueing, delivery, retry and backoff behavior | the job body is really a service |
| `spec/mailers` | recipients, subject, body content | you only assert that a job enqueued |
| `spec/queries` | SQL-level filtering, sorting, aggregation results | the logic has no query object yet |
| `spec/services` | one business action: inputs → outcome, errors, side effects | it is plain model logic |

* Controller specs are deprecated — endpoints go in `spec/requests/*_spec.rb`.
* Real user flows (JS, clicks, multi-page redirects) go in `spec/system/`, which needs `capybara` and a driver — add both if the repo has no `spec/system/` or no capybara.
* One endpoint, one request spec file: assert status, parsed body, and the persisted change — not just "no error".

## Factories, not fixture guesswork

`factory_bot_rails` is present. `spec/fixtures/` may hold static files, but test data comes from factories.

| Caller | Use for |
|---|---|
| `build(:order)` | attributes and validations; nothing hits the DB |
| `build_stubbed(:order)` | everything else — no row, no callbacks, fastest |
| `create(:order)` | behavior needing ids, queries, callbacks, associations |
| `create_list(:order, 3)` | collections |
| `attributes_for(:order)` | params hashes for request specs |

* Add traits for meaningful variations (`:paid`, `:cancelled`), not for every attribute combination.
* Uniqueness: sequences (`sequence(:email) { |n| "user#{n}@example.com" }`) beat `rand`, which collides and hides order bugs.
* Use `association` or nested factories for required parents instead of stubbing them out.
* A big fabricated graph (order → customer → cart → shipping) hides the wiring under test: build only what the behavior reads, and assert on real rows when the bug was in the graph.
* A factory-only test proves the factory. Exercise each factory in at least one spec that uses it for real.

## shoulda-matchers

One-line coverage for trivially declared behavior:

```ruby
it { is_expected.to validate_presence_of(:status) }
it { is_expected.to belong_to(:customer) }
it { is_expected.to have_many(:line_items).dependent(:destroy) }
```

* Validations and associations only. Never let these be the whole model spec — they restate the class body and prove no behavior.
* Methods, scopes, and state transitions get a real example with a literal expectation.

## WebMock — no real network

Stub at the boundary and assert the call happened:

```ruby
stub_request(:post, "https://api.example.com/charges").to_return(status: 200, body: '{"id":"ch_1"}')
# exercise the code under test
expect(a_request(:post, "https://api.example.com/charges")).to have_been_made.once
```

* Stub the HTTP client's boundary, not deep internals; a stubbed response alone never proves the request was made.
* Never hit a real host in specs: no live APIs, no sleeps waiting on a response.
* Turn accidents into failures with `WebMock.disable_net_connect!(allow_localhost: true)` in spec support.

## SimpleCov — coverage, not a score

* Coverage is a regression guard, not a target. Set a floor in spec support and keep it from dropping; never chase 100%.
* Per-file percentages lie: a file can be 100% "covered" by one example that runs every line once with every branch untested.
* Ignore coverage where the honest spec would be theatre: generated code, `db/schema.rb`, framework glue, trivial delegations. Say why in a comment instead of writing a fake spec.
* The only rule worth enforcing: new code does not lower the number.

## Structure and naming

* `describe` names the subject; `context` names the state ("when the order is already paid"); `it` completes the sentence ("returns a refund error"). No `it "should work"`.
* One behavior per example — two independent assertions means two examples.
* Group related assertions on one action with `:aggregate_failures` so a run reports every failure.
* Shared examples only for genuine duplication (e.g. every authenticated endpoint rejects anonymous callers). When in doubt, inline it — copy-paste beats a fake abstraction.
* `let` is lazy and memoized; `let!` runs before the example. Prefer `let` unless setup must run.

## Determinism

* Keep transactional fixtures on (the default); add `database_cleaner` only if a driver forces it.
* Freeze time with `travel_to(Time.zone.parse("2026-01-01"))` … `travel_back`, or `freeze_time`. Never `sleep`, never assert on wall clock or "today".
* Unique factory data so examples pass in any order; re-run a suspicious failure with a different `--seed` to prove order independence. A suite that fails on one seed is a real bug — fix the spec, not the seed.
* Do not depend on callback ordering between independent records.

## Run it fast, then run it all

```bash
bundle exec rspec spec/models/order_spec.rb:42   # the failing line, first
bundle exec rspec --fail-fast                    # stop at the first failure while iterating
bundle exec rspec --only-failures                # rerun the last run's failures
bundle exec rspec spec/models/order_spec.rb      # then the whole file
bundle exec rspec                                # full suite before done
```

* Touch a file, run its spec; do not run the suite on every edit.
* `--only-failures` reads the persistence file (`spec/examples.txt`) — keep it current by running the suite, and gitignore it.
* If the suite is too slow to run before changes, add `parallel_tests` (gem + `--runtime-log`) rather than skipping the run.

## Debugging a red spec

* Read the whole failure first: expected vs actual, and the line in *your* code it points at.
* `bundle exec rspec path:line --backtrace` when the message is a bare boot/rake error.
* Bisect with `--example "returns a refund error"` to shrink a file, then narrow again.
* Use `puts`/`pp` or `binding.irb` deliberately and remove them; do not leave them in a green suite.
* Never `.skip`, `pending`, delete, or weaken an assertion to go green. A red spec is information — fix the code or the spec's setup, not the bar.

## Bug fixes

1. Write a spec that reproduces the bug and watch it fail.
2. Confirm it fails on the old code for the right reason — not a typo or a missing factory.
3. Fix the code; the spec passes without touching the assertion.
4. Keep it as the regression test, named after the behavior that broke.
