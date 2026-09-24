---
name: rails-security
description: Security work in a Rails app — Brakeman and bundler-audit gates, strong parameters, authorization and IDOR, credentials and secret leaks, XSS/CSRF/CSP, Active Storage uploads, outbound-request SSRF, login throttling, and SQL injection. Use when touching controllers, params, auth, uploads, credentials, or when a scan reports findings.
---

# Rails Security

Review every change as an attacker, not as the author. The rules below map each risk to one action: fix the code, or write down why the finding is safe.

## Gates — run before declaring done

```bash
bin/brakeman -q --no-pager          # static analysis; -w2 also fails on warnings
bin/bundler-audit check --update    # CVEs in Gemfile.lock vs ruby-advisory-db
```

| Finding | Action |
|---|---|
| SQL/command injection, `eval`, `send` with user input | Fix the code. Never ignore. |
| Mass assignment, unsafe redirect/`render`, weak crypto, missing CSRF | Fix: allow-list, `redirect_to` on a known key, `protect_from_forgery`. |
| Gem CVE / unmaintained gem | Upgrade, or `bundle update <gem>`. Blocked? Pin plus a written reason and an expiry date. |
| Real finding, mitigated elsewhere (e.g. validated upstream) | Add to `brakeman.ignore` with `note:` (the mitigation) and `until:` (revisit date). |
| You do not understand the fingerprint | Investigate. Never hand-edit the ignore file to silence it. |

Regenerate the ignore file with `bin/brakeman -I` (interactive) instead of guessing fingerprints; it writes `brakeman.ignore` with `note`/`until` fields. Review every ignore in the PR diff.

An ignore without a written reason is a bug: the next reader cannot tell a false positive from a regression, so a real vulnerability survives review. `until:` forces the claim to expire. Keep the ignore file in the repo, not in a local `.gitignore`.

## Strong parameters

```ruby
params.require(:order).permit(:status, :quantity, address: [:line1, :city], tag_ids: [])
```

* Never `params.permit!`, `params.to_unsafe_h`, or `Order.update(params[:order])` / `Order.create(params)` wholesale — every permitted key is one an attacker can set.
* `params.require(:id)` alone is not authorization; see the IDOR rules below.
* `find(params[:id])` raises `RecordNotFound` (404) on a bad id — use it for lookups. `find_by(params[:id])` returns `nil` and can silently fall through to another record or a create path; only use `find_by` with a value you control or when nil is genuinely handled.
* GraphQL arguments and JSON API bodies follow the same rule: read named fields, never splat the input hash into a model call.

## Authorization

This app uses Pundit (`app/policies/`, `pundit-matchers` in specs). Keep it that way — do not re-implement checks inline.

* Every action authorizes: `authorize @order` (or `authorize Order, :index?`) before doing work.
* Add `after_action :verify_authorized` and `verify_policy_scoped` in `ApplicationController` as a net for the action someone forgets.
* Index actions scope, they do not `Model.all`: `policy_scope(Order)`.
* No `current_user.admin?` scattered through controllers, views, or helpers. Role logic lives in a policy method (`OrderPolicy#update?`), so a permission change is one edit in one file.
* IDOR: resolve children through the parent or the user — `current_user.orders.find(params[:id])`, not `Order.find(params[:id])`. A nested route proves nothing about ownership.
* Multi-tenant: scope every query by the tenant/account (`current_account.orders`) or make the default scope mandatory. Never trust `params[:tenant_id]`, `X-Account-Id`, or a path segment.
* Prefer 404 over 403 for records the user cannot see, so existence is not leaked.
* Policy specs use `pundit-matchers`: `it { is_expected.to permit(user, order) }`.

## Secrets and credentials

* Secrets live in `config/credentials.yml.enc`, edited with `bin/rails credentials:edit` (`--environment production` for that file). Never commit the key: `git check-ignore -v config/master.key` must print a match.
* No secret literals as defaults: `ENV.fetch("API_KEY")`, never `ENV.fetch("API_KEY", "dev-key")`.
* Never log them. `config/initializers/filter_parameter_logging.rb` already filters `:passw, :email, :secret, :token, :_key, :crypt, :salt, :certificate, :otp, :ssn, :cvv, :cvc` — add every new secret name there, and filter sensitive request headers in any custom logger.
* A leaked key is leaked forever: rotate it. Deleting the commit or force-pushing history does not un-share it. The repo's `secret-scanning.yaml` workflow exists to catch this before merge.

## XSS, CSRF, headers

* ERB escapes output. `raw`, `.html_safe`, and `sanitize` are opt-in — use them only on markup you wrote, and give `sanitize` an explicit allow-list, never on user content.
* Keep `protect_from_forgery with: :exception` in `ApplicationController`. Do not `skip_before_action :verify_authenticity_token` for cookie-authenticated JSON; if the endpoint is token-authenticated, it must verify its own token.
* CSP: this app has no `config/initializers/content_security_policy.rb` yet. When you add one, drive it with nonces (`content_security_policy_nonce` + `javascript_importmap_tags`), keep a `report-uri`, and avoid `unsafe-inline`/`unsafe-eval`.
* Production: `config.force_ssl = true`, and session cookies `secure: true, httponly: true, same_site: :lax`.

## Uploads (Active Storage)

* Validate what you accept: allow-listed `content_type` plus a `byte_size` limit, enforced server-side. The client's `Content-Type` is a hint, not proof — sniff when it matters.
* Private files: hand out `url_for(..., expires_in: 5.minutes)`-style short-lived URLs; never a public blob URL for private storage (e.g. the `PrivateStorage` service).
* Never interpolate `filename` or `content_type` into a shell command, SQL, or file path — pass an argv element or a bind parameter, and let Active Storage generate the key.
* Serve user files with `Content-Disposition: attachment` or from a separate origin, so an uploaded HTML/SVG cannot run against your cookies.

## SSRF and outbound requests

* Allow-list hosts before any outbound call: parse the URI, require `https`, and match the host exactly against a configured list. Never fetch a URL straight from params.
* Block internal targets (`127.0.0.1`, `::1`, `169.254.169.254`, `10.0.0.0/8`, `172.16/12`, `192.168/16`) at connect time and re-check after every redirect.
* Always set connect/read timeouts and a max response size.

## Rate limiting and brute force

* Rails 8 ships controller rate limiting — prefer it for login, reset, and code entry:

```ruby
rate_limit to: 5, within: 1.minute, only: :create
```

* For whole-app edge throttling (per IP, by path, global), add `rack-attack` if absent: `Rack::Attack.throttle("logins/ip", limit: 5, period: 60)` plus a `logins/email` throttle and a `throttled_responder`.
* Compare secrets with `ActiveSupport::SecurityUtils.secure_compare` (digests: `fixed_length_secure_compare`). `==` on a token or password leaks timing.
* Answer unknown accounts with the same response and timing as known ones; no "email not found" on password reset.

## SQL

```ruby
Order.where("status = ? AND created_at > ?", status, since)
Order.where(status: status)
```

* Never interpolate into a query string, including `where`, `having`, `pluck`.
* `order`, `select`, and `group` cannot take bind params — map user input through a literal allow-list (`{ "name" => :name, "date" => :created_at }`) and reject anything else.
* `Arel.sql` is only for a string you wrote yourself; never `Arel.sql(params[:sort])`.
* For identifiers use `connection.quote_table_name`/`quote_column_name`; for dynamic value lists use `sanitize_sql_array` or a subquery instead of joining strings.

## Review checklist

| Check | Pass condition |
|---|---|
| Brakeman / bundler-audit | Both clean, or every remaining finding has a reason and an expiry. |
| Params | `permit` with an explicit key list; no `permit!`, no wholesale `update(params)`. |
| Authorization | Every action calls `authorize`; index calls `policy_scope`; no inline role checks. |
| Ownership | Nested/record lookups scoped through `current_user`/tenant; no bare `Model.find(params[:id])`. |
| Secrets | In credentials; master key untracked; new secret names added to `filter_parameters`. |
| Output | No `raw`/`html_safe` on user content; CSRF on; CSP nonce-based. |
| Uploads | Type + size validated; short-lived URLs; filename never in a shell/path string. |
| Outbound HTTP | Host allow-list, internal ranges blocked, timeouts set. |
| Abuse | Login/reset rate-limited; `secure_compare` for tokens; no account enumeration. |
| SQL | Placeholders or allowed literal lists only; no interpolated `order`/`select`. |
