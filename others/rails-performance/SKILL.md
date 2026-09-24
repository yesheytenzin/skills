---
name: rails-performance
description: Making a Rails app measurably faster — N+1 queries, missing indexes, slow or duplicated queries, repeated rendering, cache opportunities. Use when a request or job is slow or issues too many queries, when adding an index or eager loading, or when asked to speed something up.
---

# Rails Performance

One loop, every time: measure the current cost, change one thing, measure again, keep the number. Optimising without a baseline trades correctness for nothing.

## Measure first

| What | How |
|---|---|
| Queries for a block | Notification counter below — same helper is your regression assertion |
| One query's plan | `User.limit(2).explain(:analyze)` in console; `.explain(:analyze).inspect` from a script |
| Wall time | `time bin/rails runner 'Certificates::RenderPdf.call(certificate: Certificate.last)'`, or `Benchmark.realtime { ... }` |
| Request split | `process_action.action_controller` payload: `view_runtime`, `db_runtime`, `status` |
| Production reality | JSON logs grouped by `request_id`; raise verbosity with `RAILS_LOG_LEVEL=debug` |

```ruby
# throwaway probe — counts SQL for a block (schema, cached and plumbing entries excluded)
def queries(&block)
  n = 0
  counter = ->(*, payload) { n += 1 if payload[:duration] && !payload[:cached] && payload[:name] != 'SCHEMA' }
  ActiveSupport::Notifications.subscribed(counter, 'sql.active_record', &block)
  n
end
```

* Add `rack-mini-profiler` if needed (this app has none) for a browser breakdown, and `benchmark-ips` for micro-benchmarks — in a throwaway script or a non-default group, never the default bundle.
* State the numbers in the change itself: what was measured, baseline, change, after, and what you deliberately did not optimise.

## N+1 and eager loading

Bullet is enabled in test with `Bullet.raise = true` (`config/environments/test.rb`), so an N+1 fails the spec — fix the query, not the spec. Development has no Bullet block; add `Bullet.enable = true` there when you want to see it in the browser.

| Call | Use when |
|---|---|
| `includes(:items)` | Default choice: Rails picks `preload` or `eager_load` per relation shape |
| `preload(:items)` | You only need the records; no `WHERE`/`ORDER` on association columns |
| `eager_load(:items)` | You filter or sort on association columns — one `LEFT OUTER JOIN` |
| `joins(:items)` (+ `select`) | Existence checks or aggregates only; skips loading association rows |
| `references(:items)` | Needed alongside `includes` when a string `where`/`order` names that table |

* `strict_loading` turns a lazy load into an exception instead of a hidden query: `relation.strict_loading`, or `self.strict_loading_by_default = true` per model. Enable it for the code you are fixing; flipping it app-wide is its own change.
* Scoped orderings (`has_many :items, -> { order(:position) }`) plus one preload beat N per-record lookups.
* Guard the win so it cannot creep back:

```ruby
# include this module where the cost matters (spec/support/queries.rb + RSpec.configure)
module Queries
  def queries(&block)
    n = 0
    counter = ->(*, payload) { n += 1 if payload[:duration] && !payload[:cached] && payload[:name] != 'SCHEMA' }
    ActiveSupport::Notifications.subscribed(counter, 'sql.active_record', &block)
    n
  end
end

it 'loads assignments in a bounded number of queries' do
  create_list(:user, 3) { |user| create_list(:learning_assignment, 2, user: user) }
  expect(queries { User.includes(:learning_assignments).map { |u| u.learning_assignments.size } }).to eq(2)
end
```

Rails also ships `ActiveRecord::Assertions::QueryAssertions` (`assert_queries_count`, `assert_no_queries`, `assert_queries_match`), but it is not autoloaded and leans on Minitest assertions (`require 'active_record/testing/query_assertions'`), so the counter above is less ceremony in RSpec.

## Query level

* Index what the query actually asks, composite and in order: for `WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC`, `add_index :learning_assignments, [:user_id, :created_at], where: 'deleted_at IS NULL'` — equality columns first, then range/sort, and the partial clause matches this app's soft-delete convention (`idx_learning_assignments_uniq_active`).
* Partial indexes pay for hot subsets: `add_index :users, :created_at, where: 'active'` (PostgreSQL here).
* Generate the migration, never hand-write its timestamp: `bin/rails g migration AddIndexToLearningAssignmentsOnDeletedAt`, then edit for `disable_ddl_transaction!` + `algorithm: :concurrently` if the table is large. Add `strong_migrations` if absent — it blocks the unsafe variants for you.
* `select` only the columns you read on wide tables (`select(:id, :name)`), especially inside loops.
* Large sets: `find_each` / `in_batches` (keyset batch, nothing fully materialised) instead of `each` on a big relation; `update_all` / `delete_all` for bulk writes — they skip validations and callbacks, so keep them off records that depend on them.
* `size` uses the collection if it is already loaded (or a counter cache) and otherwise issues a COUNT; `count` issues a COUNT unless a counter cache answers it; `length` loads every row. Default to `size`, and never call `length` on an unloaded relation you only need a number from.
* Association counts on hot records: counter cache (`belongs_to :user, counter_cache: true` on the child plus a `learning_assignments_count` column on `users`) removes a COUNT per record.
* Confirm with the plan, not the clock: `.explain(:analyze)` should show an index scan and `rows=` close to reality for the page you render.

## Caching

Add a cache only after a measurement shows the work repeats, and only when a stale read is acceptable for that data.

| Layer | Mechanism |
|---|---|
| Fragment | `cache assignment do … end` in the view; the key defaults to `cache_key_with_version` |
| Russian doll | `cache [user, assignment]` — the parent key changes when the child does |
| Explicit value | `Rails.cache.fetch(user.cache_key_with_version, expires_in: 5.minutes) { compute }` |
| HTTP | `fresh_when(user)` / `stale?(user)` for ETag + 304 on read-only pages |

* Never let a cache key omit a dimension the response depends on (current user, tenant, locale, feature flag) — that is a data leak, not just a bug.
* Development: `perform_caching` is off unless `tmp/caching-dev.txt` exists; `bin/rails dev:cache` toggles it, and `bin/rails server --dev-caching` enables it for one boot.
* Test: `cache_store = :null_store`, so fragment caching is a no-op there. Assert caching by stubbing the store for that example: `allow(Rails).to receive(:cache).and_return(ActiveSupport::Cache::MemoryStore.new)`.
* Production uses Solid Cache (`config.cache_store = :solid_cache_store`, its own `cache` database and `db/cache_schema.rb`); tuning lives in `config/cache.yml` — `store_options.max_size: 256.megabytes`, `namespace: Rails.env`, `max_age` commented out. Eviction follows that size/age; purge through `Rails.cache.delete`/`clear`, never by editing cache rows.

## Views and assets

* `render @learning_assignments` is the cheap shorthand (uses `_learning_assignment.html.erb`, no options — a second argument is treated as locals). Batch fragment caching needs the explicit form: `render partial: 'learning_assignments/learning_assignment', collection: @learning_assignments, cached: true` — it reads/writes those fragments in one call, requires `perform_caching`, and works with a `cache learning_assignment do` block inside the partial. If a fragment depends on more than the record, say so in the key: `cached: ->(assignment) { [assignment, current_user] }`.
* Keep partial locals small and explicit: every render builds a local scope from the hash you pass, and passing a whole collection or a record's associations into a partial is what turns one render into a query per row. Prefer one list partial over a chain of nested partials per row.
* When a render cost is in doubt, measure it rather than restructuring on instinct: subscribe to `render_partial.action_view` and read the `identifier`/`duration` per partial.
* Asset and bundling work needs a build and a deploy: do not fold it into a performance change unless asked.

## Verify and report

* Re-run the "Measure first" probe after the change; the number is the deliverable, not the diff.
* Keep a permanent guard when the cost is structural (query counts, an index a query depends on) — a spec assertion, or the app's Bullet configuration. Keep one-off timings in a throwaway script.
* Report: **measured** (what and how), **baseline**, **change**, **after**, and **not optimised** (what you left alone and why — premature caching, an unrelated page, asset work).
* Gates before calling it done: `bin/rubocop` on touched files and `bundle exec rspec` (this app has no `bin/rspec`).
