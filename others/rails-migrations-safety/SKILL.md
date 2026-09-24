---
name: rails-migrations-safety
description: Safe, zero-downtime Rails migrations in production. Use when adding/removing indexes, columns or constraints on large tables; when a migration must not lock or rewrite a table; when renaming columns or backfilling data; when reviewing migration reversibility; when strong_migrations flags a migration.
---

# Rails Migrations Safety

Rules for migrations that stay correct while the old code is still running. DDL locks and full-table rewrites are the two ways a deploy takes the app down; design around both.

## Install strong_migrations if absent

`strong_migrations` is not in the Gemfile (verified). Add it as the first step of nontrivial migration work:

```ruby
# Gemfile
gem "strong_migrations"
```

```bash
bundle install
bin/rails generate strong_migrations:install   # writes config/initializers/strong_migrations.rb
```

It raises on dangerous DDL. **Fix the migration, don't silence it** — each error names the remedy. Reach for `safety_assured` only when the risk is genuinely absent, e.g. a table created in an earlier migration of the same deploy, or known-tiny static reference data:

```ruby
safety_assured do
  add_column :countries, :iso_code, :string   # ~250 rows, static reference data
end
```

Every `safety_assured` needs a one-line comment stating the reason. Bare blocks are review noise — reject them.

## Avoid long locks

| Operation | Safe form |
|---|---|
| Add index | `disable_ddl_transaction!` + `add_index :t, :c, algorithm: :concurrently, if_not_exists: true` |
| Remove index | `remove_index :t, :c, algorithm: :concurrently, if_not_exists: true` |
| Backfill rows | batched job (below), never one `UPDATE` |
| Add FK | `add_foreign_key` then `validate_foreign_key` (validation is the locking step) |
| Add check | `add_check_constraint …, validate: false`, then `validate_check_constraint` |

```ruby
class AddIndexOnOrdersCustomerId < ActiveRecord::Migration[8.1]
  disable_ddl_transaction!          # concurrent index builds run outside a txn

  def change
    add_index :orders, :customer_id, algorithm: :concurrently, if_not_exists: true
  end
end
```

* `algorithm: :concurrently` requires `disable_ddl_transaction!` and a single statement — never wrap it with other DDL.
* `if_not_exists: true` makes a half-applied deploy re-runnable.
* Never `UPDATE … WHERE` a whole table in a migration: it holds row locks inside a long transaction. Write a batched job and enqueue it after deploy:

```ruby
class BackfillOrderStatusJob < ApplicationJob
  def perform
    Order.where(status: nil).in_batches(of: 1_000) { |b| b.update_all(status: "pending") }
  end
end
```

## Column changes as multi-step deploys

Adding a `NOT NULL` column with a default rewrites the table and takes an `ACCESS EXCLUSIVE` lock. Split across releases:

1. **R1** — `add_column :orders, :region, :string, null: true` (nullable, no default). Code writes it going forward.
2. **R2** — backfill with a batched job.
3. **R3** — enforce without a blocking check:
   ```ruby
   add_check_constraint :orders, "region IS NOT NULL", name: "orders_region_null", validate: false
   validate_check_constraint :orders, name: "orders_region_null"   # separate migration; lighter lock
   change_column_null :orders, :region, false
   ```
   `validate_check_constraint` checks existing rows without the full `ACCESS EXCLUSIVE` lock `change_column_null` alone would take.
4. **Dropping** — stop reading the column, add it to `ignored_columns` so the running app no longer `SELECT`s it, deploy, *then* drop:
   ```ruby
   class Order < ApplicationRecord
     self.ignored_columns += ["legacy_status"]
   end
   ```
   Remove the `ignored_columns` entry in a later release once no deploy can reference the column.

## Renames: never in place

`rename_column` breaks the old code for the length of the deploy. For any table that matters: add the new column (nullable) → dual-write both → backfill old → new in batches, deploy code reading the new column → stop writing the old, `ignored_columns` it, drop it. Rename in place only on a table created in the same deploy, with no running code depending on the old name.

## Reversibility

`change` reverses DDL (`add_column`, `add_index`, `add_reference`) but not data changes — backfills, `execute`, `remove_column`. Those need explicit `up`/`down`:

```ruby
def up
  add_column :orders, :region, :string
  execute "UPDATE orders SET region = 'us'"   # change cannot express this
end
```

Provide a matching `down` that reverses each step (here: `remove_column :orders, :region`).

## Verify against the real database

```bash
bin/rails db:migrate --trace           # prints the SQL actually executed
git diff db/schema.rb                 # every line intended — no accidental type/default drift
bin/rails db:migrate:status           # applied vs pending matches expectations
bin/rails db:rollback STEP=1 && bin/rails db:migrate   # reversibility proof
```

Read the traced SQL: the index uses `CONCURRENTLY`, the constraint is added `NOT VALID` first, and no unexpected table rewrite appears.

## Migration review checklist

| Check | Why |
|---|---|
| Index on every FK | unindexed FKs make deletes/joins scan |
| Uniqueness via a unique index, not just a model validation | validations race |
| `null: false` on required columns | app validation isn't enough under concurrency |
| Defaults set without a table rewrite | verify behavior on your PG version |
| No data migration in the same migration as DDL | a long `UPDATE` multiplies lock duration |
