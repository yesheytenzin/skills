---
name: rails-conventions
description: Ruby on Rails work in an existing app — migrations, RuboCop, RSpec, and where code belongs. Use when adding or changing a model, controller, route, job, mailer, or service; when writing or editing a migration or db/schema.rb; when writing, running, or fixing specs; before declaring Rails work done (RuboCop + RSpec gates).
---

# Rails Conventions

Concrete rules for changing an existing Rails app. Every command below assumes the app's own binstubs; fall back to `bundle exec` when a binstub is missing.

## First, read the app (30 seconds)

1. Version: `bin/rails -v`, or read `Gemfile.lock`.
2. Tooling: `ls bin/` — binstubs beat `bundle exec`. Look for `bin/rubocop`, `bin/rspec`, `bin/brakeman`, `bin/rails`.
3. Config: `.rubocop.yml`, `spec/`, `db/schema.rb`, `app/services/`, factories in `spec/factories/`.
4. Existing patterns win. If the app already places logic somewhere, put it there — do not introduce a second convention.

## Migrations — always the generator

**Never hand-write a migration file, its timestamp, or its class name.** Generators produce the correct timestamp, class, and versioned filename; hand-made names collide and reorder.

```bash
bin/rails g migration AddStatusToOrders status:string
bin/rails g migration AddIndexToOrdersOnCustomerId
bin/rails g model OrderItem order:references product:references quantity:integer
```

* Names are CamelCase, args are `column:type` (`:string` is the default — omit it).
* After generating, **read the file**, then edit content: indexes, `null: false`, defaults, data backfills.
* Default to reversible `change`. Use `up`/`down` (or `reversible do |dir|`) only when `change` can't express it — data backfills, dropping a column you still read.
* Data backfills: define a throwaway model inside the migration (`class MigrationOrder < ActiveRecord::Base; self.table_name = "orders"; end`) — never reference app models, they change under you.
* Index foreign keys and anything you filter/order by; `add_index …, unique: true` plus a model uniqueness validation for uniqueness; `null: false` on required references and enums.
* Avoid `change_column` on a large table without a stated plan (locks + full rewrite).
* Verify:
  ```bash
  bin/rails db:migrate
  git diff db/schema.rb          # schema matches intent
  bin/rails db:rollback STEP=1 && bin/rails db:migrate   # reversibility
  ```
* Schema change and every caller change (model, queries, specs, factories) land in the same change — no half-migrated state.

## RuboCop — syntax and style gate

```bash
bin/rubocop                                  # whole repo
bin/rubocop app/models/order.rb spec/models/order_spec.rb   # touched files, fast
ruby -c app/models/order.rb                  # syntax only, after hand-editing
bin/rubocop -a  app/models/order.rb          # safe autocorrect
bin/rubocop -A  app/models/order.rb          # unsafe autocorrect — review the diff after
```

* Run RuboCop on every file you touched **before** declaring done; 0 new offenses is the bar.
* After any autocorrect, re-read the diff — `-A` can change semantics (it does not fix your logic).
* **Never add inline disables** (`# rubocop:disable …`). Fix the code. If a cop is genuinely wrong for this repo, disable it once in `.rubocop.yml` with a comment saying why.
* Never regenerate `.rubocop_todo.yml` or add `# rubocop:todo` to hide new findings.
* The repo's extensions define the rules — respect `.rubocop.yml` (this box's app uses `rubocop-rails-omakase`, `rubocop-rspec`, `rubocop-rake`, `rubocop-faker`, `rubocop-graphql`).

## RSpec — behavior gate

Layout mirrors `app/`: `app/models/order.rb` → `spec/models/order_spec.rb`.

```bash
bin/rails g rspec:model Order              # rspec:model | rspec:request | rspec:system | rspec:job | rspec:mailer
bundle exec rspec spec/models/order_spec.rb      # one file
bundle exec rspec spec/models/order_spec.rb:42   # one example
bundle exec rspec                                # full suite (required before done)
```

No `bin/rspec` binstub? That's the normal case — only `bundle binstubs rspec-core` creates one, so use `bundle exec rspec`. Use `bin/rspec` solely when `ls bin/` shows it.

* Test **behavior through the public interface** with literal expected values: `expect(order.total).to eq(1099)`, not a recomputation of the implementation.
* `shoulda-matchers` for validations/associations (`it { is_expected.to validate_presence_of(:status) }`), `factory_bot` for data, `build_stubbed`/`build` when the DB isn't the subject.
* Prefer `spec/requests` over controller specs (controller specs are deprecated); `spec/system` for real user flows; `spec/models` for domain logic.
* Every bug fix starts with a failing spec that reproduces it; keep it as the regression test.
* Determinism: `travel_to` instead of sleeping, no real network, no order dependence (run with a different `--seed` when a failure smells order-related), factory data unique so tests can run in any order.
* Read failures properly: full message, `--backtrace`, `--fail-fast` when iterating. Never `.skip`, `pending`, or delete failing examples to go green — a red spec is information, not an obstacle.

## Where code goes

| Code | Location |
|---|---|
| One business action, one public `call` | `app/services/<namespace>/<verb>.rb` |
| Logic shared across models | model concerns in `app/models/concerns/` |
| Controller/view helpers | `app/controllers/concerns/`, `app/helpers/` |
| Plain Ruby, no Rails deps | `lib/` (autoloaded via `config.autoload_lib`) |
| Background jobs / mailers | `app/jobs/`, `app/mailers/` |

Zeitwerk: the file path must match the constant (`app/services/orders/checkout.rb` → `Orders::Checkout`). No `require`.

## Definition of done

1. Migrations came from a generator, `db/schema.rb` is updated, and the migration is reversible.
2. `bin/rubocop` reports 0 new offenses on every touched file, with no inline disables.
3. `bin/rspec` is green — the targeted specs and the full suite.
4. The real path was exercised (console, browser, or a system spec), not just unit tests.
5. Run the repo's safety nets when present: `bin/brakeman` (security), `bullet` (N+1s), `bin/bundler-audit` (CVEs).
