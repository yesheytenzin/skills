---
name: rails-conventions
description: >-
  Ruby on Rails project conventions for writing and organizing code: directory
  layout, model/controller/service/concern placement, generators, Strong
  Parameters, migrations, Zeitwerk autoloading, and Rails 8 defaults (Solid
  Queue, Solid Cache, Solid Cable, authentication generator). Use when
  creating or modifying files in a Rails app, running rails/rake generators,
  writing migrations, adding controllers or models, or discussing Rails
  architecture.
---

# Rails Conventions

Companion to `ruby-rails-rspec-skill` (testing). This skill covers how to *structure* code in a Rails app.

## Before writing anything

1. Detect the Rails version: `bin/rails runner 'puts Rails.version'` or read `Gemfile.lock`.
2. Check existing patterns — match how this specific app already organizes code before imposing any convention below.
3. Prefer generators over hand-writing files: they create correct structure plus test stubs.

## Directory layout decisions

| Code | Location | Notes |
|------|----------|-------|
| Domain logic spanning multiple models | `app/models/` concerns or `app/services/` | Check if app has a services dir first |
| One business action (e.g. `Orders::Checkout`) | `app/services/<namespace>/<verb>.rb` | One public `call` method; return result object or raise |
| Reusable controller/view logic | `app/controllers/concerns/`, `app/helpers/` | |
| Plain Ruby utilities, no Rails deps | `lib/` + add to `config.autoload_lib(ignore: %w[assets tasks])` (Rails 7.1+) | |
| Background jobs | `app/jobs/` | Solid Queue in Rails 8 |
| Mailers | `app/mailers/` | |

## Generators

```bash
bin/rails g model Favorite user:references post:references --no-test-framework
bin/rails g controller Favorites create destroy
bin/rails g migration AddIndexToFavorites
```
Never hand-write a model/migration when a generator exists. Generators respect Zeitwerk naming.

## Migrations

* One migration per change, reversible `change` method.
* Add indexes for foreign keys and uniqueness: `add_index :favorites, [:user_id, :post_id], unique: true`
* Use `null: false` on required references.
* Run `bin/rails db:migrate` then check `db/schema.rb`.

## Models & Associations

* Singular model `Favorite` -> plural table `favorites`.
* `belongs_to` required by default in Rails 5+; use `optional: true` only when needed.
* `has_many :through` for favourites: `has_many :favorite_posts, through: :favorites, source: :post`
* `dependent: :destroy` on owner side.
* Validations at model layer + DB constraint for uniqueness.

## Controllers & Strong Parameters

* Plural controllers: `FavoritesController`.
* REST: `resources :posts do resource :favorite, only: [:create, :destroy] end`
* Private `favorite_params`: `params.permit(:post_id)` / `params.require(:favorite).permit(...)`
* Thin controllers - delegate to service: `Favorites::Toggle.call(current_user, post)`

## Zeitwerk

* File path must match constant: `app/services/favorites/toggle.rb` defines `Favorites::Toggle`.
* No `require` needed.

## Rails 8 defaults

* `Solid Queue` for jobs, `Solid Cache` for cache, `Solid Cable` for ActionCable.
* `authentication` generator: `bin/rails g authentication`
* Don't add `sidekiq/redis` unless needed.

## Checklist for new feature (e.g. favourites)

1. `bin/rails g model Favorite user:references post:references` + unique index
2. Add associations + validations
3. Controller with Strong Params + route
4. Service `Favorites::Toggle` if logic > one line
5. Verify: `bin/rails console` + browser - prove it works, not just `rspec`.

