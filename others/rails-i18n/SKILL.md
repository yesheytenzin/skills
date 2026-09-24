---
name: rails-i18n
description: Translating a Rails app — what belongs in locale files, key layout and lazy lookup, I18n.t defaults and plurals, request-scoped locale switching, localized dates/numbers/currency, fallbacks, and catching missing keys in specs or CI. Use when adding user-facing copy, locale files, or per-request locale handling.
---

# Rails I18n

User-facing text lives in `config/locales`; everything the user never reads stays a code string. This app sets `I18n.available_locales = %i[en de fr it]` in `config/application.rb` but ships only English files, so the rules below assume more locales will be added.

## Translate or not

| String | Where it goes |
|---|---|
| View copy, flash, mailer subject/body, validation messages, PDF text | Locale file, read with `t(...)`. |
| Log lines, metric names, exception messages | English literal — a translated log line cannot be grepped. |
| JSON/GraphQL error codes, job and queue names | Stable English identifiers or symbols; the client translates. Never an `I18n.t` key, or the API contract changes when copy does. |
| Seeds, fixtures, spec expectations, class names, DB enum values | Literals — enum values are data, not copy. |

## Layout and naming

* Rails loads every `*.yml` under `config/locales`, nested dirs included. This app is flat (`en.yml`, `doorkeeper.en.yml`, `dry_validations.en.yml`); nested per-locale dirs (`config/locales/de/orders.yml`) are the alternative when a repo uses them.
* The root key must be the locale (`en:`) and must agree with the filename suffix (`.en.yml`). A `de:` document inside `orders.en.yml` is a bug.
* Name files snake_case with the locale last: no `dry-validations.en.yml`, no `orders.index.en.yml`. Dots separate the locale, dashes break tooling conventions.
* One namespace per file, keys mirroring the code path: `orders.show.title`, `activerecord.attributes.order.status`, `errors.messages.too_long`.
* Locale files are data: nothing under `config/locales` is autoloaded, so no Ruby or constants there. Test-only strings can live in `spec/fixtures/locales/*.yml` — the test env adds that dir to `I18n.load_path`.

## Keys and the `t` API

```ruby
t('.title')                            # lazy: views/orders/show.html.erb -> orders.show.title
I18n.t('orders.show.title')            # explicit, outside views
I18n.t('orders.paid_count', count: orders.size)
I18n.t('support.email', default: 'support@example.com')
I18n.t('checkout.button', default: :'cart.checkout')
```

* Prefer lazy lookup inside views and mailer templates; use full keys in jobs, services, models, and controllers, where no template path can be inferred.
* `count:` selects the plural form. Supply every form the locale's CLDR rules require (`one`/`other` for English and German; add `few`/`many` where the locale has them) — a missing form is a runtime error or a wrong fallback.
* `default:` is for genuinely optional copy, not to paper over a key you meant to ship; `raise_on_missing_translations` catches that.
* Interpolate, never concatenate: `t('orders.greeting', name: user.name)`. Keys ending `_html` are marked html-safe automatically, so only static markup goes in them, escaped user input (`h(user.name)`) otherwise.

## Request-scoped locale

```ruby
around_action :switch_locale

def switch_locale(&action) = I18n.with_locale(locale_from_params, &action)

def locale_from_params
  requested = params[:locale].presence&.to_sym
  requested if I18n.available_locales.include?(requested)
end
```

* Use `I18n.with_locale`, not `I18n.locale =`, so the previous locale is restored even when the action raises. Where a controller already sets the request locale directly (this app's GraphQL controller assigns `I18n.locale = requested_locale`), follow that pattern instead of mixing both.
* Always allow-list against `I18n.available_locales`; passing `params[:locale]` straight to `I18n.locale` lets a stranger select arbitrary locales and breaks fallbacks. `Accept-Language` is a hint that still goes through the allow-list.
* Persist the choice (session or user column) and define `default_url_options = { locale: I18n.locale }` so links retain it.
* Jobs do not inherit the request locale: pass the locale in and wrap the body in `I18n.with_locale(locale) { ... }`. Never pick a locale inside a DB callback that writes.

## Dates, numbers, currency

```erb
<%= l(@order.paid_at, format: :long) %>
<%= number_to_currency(@order.total) %>
<%= number_to_percentage(@rate, precision: 1) %>
```

* Never `strftime` or `sprintf("%.2f")` for user-facing output — `l(...)` and `number_to_*` read the current locale.
* Define formats in the locale file (`en.date.formats.short`, `en.time.formats.long`) and reference them by name; inline format strings are for one-off admin output only.
* Store money as integer cents and format at the edge with `number_to_currency(unit: ...)`; do not bake `$` into a stored string.
* Time zone and locale are independent: `Time.zone`/`in_time_zone` converts UTC, `l` handles language. Neither substitutes for the other.

## Fallbacks and raising

* `config.i18n.fallbacks = true` is set in development and test; in production make the chain explicit (`[:en]` or a per-locale map) so a missing German string degrades to English instead of `translation missing:`.
* Uncomment `config.i18n.raise_on_missing_translations = true` in development and test: it turns a silent missing key into a failing request or spec. Never raise in production — fall back and report.

## Missing keys, specs and CI

This app has no `i18n-tasks`. Add it if absent (`gem 'i18n-tasks', group: :development`) and gate CI on it:

```bash
bin/i18n-tasks health      # missing + unused keys, normalization
bin/i18n-tasks unused      # keys nothing references — not detectable by a spec
bin/i18n-tasks missing     # t() keys with no translation
bin/i18n-tasks normalize   # sort keys, dedupe, consistent layout
```

Run `health` in the test job (`.github/workflows/test.yaml`). Rails ships no missing-key task of its own; if the app already has a gem providing `bin/rails i18n:missing_keys`, keep using it, otherwise add the spec below — asserting only locales you actually ship, since `available_locales` may list locales with no file yet.

```ruby
RSpec.describe 'locale files' do
  it 'parses, and each root key is an available locale' do
    allowed = I18n.available_locales.map(&:to_s)
    Dir[Rails.root.join('config/locales/**/*.yml')].each do |file|
      expect(allowed).to include(*YAML.safe_load_file(file, aliases: true).keys), file
    end
  end

  it 'defines every key referenced with t("...") in app code' do
    globs = [Rails.root.join('app/**/*.rb'), Rails.root.join('app/views/**/*.erb')]
    keys = Dir[*globs].flat_map { |f| File.read(f).scan(/\bt\(\s*['"]([a-z0-9_.]+)['"]/).flatten }
    expect(keys.reject { |key| I18n.exists?(key) }).to eq([])
  end
end
```

## Checklist

| Check | Pass condition |
|---|---|
| Audience | Every string a user sees comes from a locale file; logs/API codes stay English. |
| Files | Snake_case names, locale suffix matches the root key, valid YAML. |
| Keys | Lazy `t('.key')` in views, full keys elsewhere, namespaced by code path. |
| Plurals | Every form the locale needs, driven by `count:`. |
| Locale switching | `I18n.with_locale` + `available_locales` allow-list; jobs pass the locale in. |
| Formats | `l(...)` and `number_to_*`; no `strftime`/`sprintf` for UI output. |
| Fallbacks | Explicit chain in production; `raise_on_missing_translations` on in dev/test. |
| CI | `i18n-tasks health` (or the spec above) green; `normalize` run after edits. |
