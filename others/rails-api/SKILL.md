---
name: rails-api
description: JSON HTTP endpoints in a Rails app — versioned Api::V1 controllers, response payloads, error envelopes and machine-readable codes, pagination and filtering, idempotent writes, token auth and per-owner scoping, and request specs. Use when adding an endpoint or changing its payload, errors, auth, or version.
---

# Rails JSON APIs

An API is a contract: version it, keep controllers thin, build payloads explicitly, and answer every error in one shape. HTML assumptions (views, cookies, CSRF tokens, "just add a column") do not survive contact with an external client.

## Shape

* Namespace and version from the first endpoint: `app/controllers/api/v1/orders_controller.rb` → `Api::V1::OrdersController`, routed inside `namespace :api do namespace :v1 do resources :orders end end`. This app already nests `v1` (webhooks, scorm, certificates) — extend that, don't start a second convention.
* URL versioning is the default; if one URL is required, branch on a version media type in the route constraint:
  ```ruby
  constraints(->(req) { req.headers["Accept"].to_s.include?("application/vnd.sunrise.v2+json") }) { resources :orders }
  ```
* `ActionController::API` (this app's `ApplicationController` already inherits it) means no views, cookies, CSRF, or helpers. Deliberately choose that: an endpoint that must also serve HTML gets its own controller or an explicit `respond_to`, not a quiet switch of the base class.
* One action: fetch the scoped record, authorize, delegate to a service (`app/services/`), render a payload. Query objects live in `app/queries/`.
* Shared behaviour belongs in `app/controllers/concerns/` (`ErrorResponders`, `Authenticable` here) so API and HTML controllers use one implementation; per-version before_actions belong in a namespaced base controller (`Api::V1::Webhooks::BaseController`), not repeated on every action.

## Serialization

* Never `render json: record`. It dumps every column you forgot about (`internal_notes`, `deleted_at`, tokens), follows associations unpredictably, and turns "someone added a column" into a breaking response change.
* Build the payload explicitly, once per resource:
  ```ruby
  def order_payload(order)
    { id: order.id, status: order.status, total_cents: order.total_cents,
      created_at: order.created_at.utc.iso8601, updated_at: order.updated_at.utc.iso8601 }
  end
  ```
  Move it to a PORO (`app/serializers/order_payload.rb`) when a second endpoint needs it; add jbuilder, blueprinter, or ActiveModel::Serializers only if the repo already has one, or the payload method grows past a screen.
* Timestamps are ISO8601 UTC with explicit precision (`.utc.iso8601`), never `Time.zone`-offset strings or `to_s`. Money is integer minor units plus a currency code — never a float.
* Avoid `as_json`/`to_json` overrides on models: they change every renderer, log line, and GraphQL type at once and cannot vary per endpoint.
* Adding a field inside a version is safe; renaming, removing, or retyping one is a new version.

## Errors

* One envelope per API. This app's REST side already answers `{ error: message, code: "ERROR_..." }` (`app/controllers/concerns/error_responders.rb`, codes centralized in `app/errors/error_code.rb`) — reuse it, and register any new code in `ErrorCode`; `spec/errors/error_code_coverage_spec.rb` pins the flat, prefixed, unique shape.
* Map exceptions centrally rather than per action:
  ```ruby
  rescue_from ActiveRecord::RecordNotFound, with: :not_found_error
  rescue_from CustomRestError, with: :rest_api_error
  rescue_from StandardError, with: :server_error
  ```
  Follow the existing responders: `Rails.error.report(error, handled: true, severity: :warning, source: "http_request")` before rendering.
* Use the right status: 400 malformed request, 401 unauthenticated, 403 authenticated-but-forbidden, 404 unknown or not yours, 409 conflict (stale lock), 422 validation, 429 rate limited, 500 unexpected. No 200-with-error, no 400 for everything.
* Validation errors carry field paths, not one prose blob:
  ```ruby
  { error: I18n.t(ErrorCode::VALIDATION_FAILED), code: ErrorCode::VALIDATION_FAILED,
    details: record.errors.map { |e| { field: e.attribute.to_s.camelize(:lower), message: e.message } } }
  ```
* Never leak stack traces, SQL, or internal class names. The 500 body is a generic message plus a correlation id; the detail goes to the error reporter (Sentry is configured here).
* Return the request id: `ActionDispatch::RequestId` already sets `X-Request-Id` on the response and production logs carry `request_id` (lograge + `RequestLogPayload`). Echo it in 5xx bodies so support can quote one string.

## Collections

* Paginate every index with a default and a hard cap:
  ```ruby
  per_page = params.fetch(:per_page, 25).to_i.clamp(1, 100)
  page     = params.fetch(:page, 1).to_i.clamp(1, Float::INFINITY)
  ```
  This repo has no pagination gem — add `pagy` (or kaminari) if absent, or `.limit(per_page).offset((page - 1) * per_page)` with a `meta: { page:, per_page:, total: }` block.
* Offset paging is fine for bounded, stable collections. Switch to a keyset cursor (`where("(created_at, id) < (?, ?)", at, id)` ordered by the same pair) when rows are inserted while clients page, because offsets shift and clients silently see duplicates or gaps.
* Sort and filter through allow-lists; never interpolate `params[:sort]` or `params[:direction]` into `order`:
  ```ruby
  SORTS = { "created_at" => :created_at, "name" => :name }.freeze
  DIRECTIONS = { "asc" => :asc, "desc" => :desc }.freeze
  scope.order(SORTS.fetch(params[:sort], :created_at) => DIRECTIONS.fetch(params[:direction], :asc))
  ```
* Filters are explicit too (`params[:status].presence_in(Order.statuses.keys)`, ranges parsed with `Time.zone.parse`); ignore unknown filters instead of passing them through.
* Keep the documented envelope: `{ data: [...], meta: {...} }` for collections, `{ data: {...} }` for a single resource — the same keys every time.

## Writes

* POST creates, PUT replaces, PATCH merges, GET never mutates. A PUT that behaves like a PATCH confuses every client library and cache.
* Slow work answers 202 with a job id or status URL and renders the resource when the job finishes — `Certificates::RenderPdfJob` is the local pattern: enqueue, return, don't hold the request open.
* Mutations that cost money or create records on retry accept an `Idempotency-Key`: store key → response (or key → resource id) behind a unique index and replay the stored response on a repeat. This app has no such table yet — add one before the first endpoint whose duplicate call hurts.
* Concurrent updates: add a `lock_version` column if absent and map `ActiveRecord::StaleObjectError` to 409, or make the transition conditional and check it:
  ```ruby
  updated = Order.where(id: id, status: "pending").update_all(status: "paid", updated_at: Time.current)
  raise CustomRestError.new("order is not pending") if updated.zero?   # register a real code in ErrorCode
  ```
  Derive ownership fields (`user_id`, `partner_id`) from the token, never from permitted params.
* Keep write endpoints returning the resource (or its id) so clients don't need a follow-up GET.

## Auth and authorization

* Match the mechanism to the caller: Doorkeeper OAuth tokens for third parties (`before_action -> { doorkeeper_authorize! :write }`, as in `Api::V1::Webhooks::BaseController`) and session auth for first-party (`authenticate_user!`, as in the SCORM base controller). Don't stack both on one route.
* 401 means "I don't know you" (missing, expired, or invalid token — include `WWW-Authenticate`); 403 means "I know you and you may not". Answering 401 for an authorization failure sends clients into a pointless re-auth loop.
* Scope reads through the owner and authorize the action: `current_user.orders.find(params[:id])`, or a Pundit `policy_scope` + `authorize` pair (Pundit is already installed here). Never `Order.find(params[:id])` with a check afterwards — the query already ran and the timing leaks existence.
* Answer 404 when the caller must not learn the record exists; reserve 403 for records they can see but not change.
* Abuse controls belong at the edge: add `rack-attack` if the repo lacks it (this one does) and throttle login, OTP, export, and webhook endpoints per token and per IP.

## Contracts and tests

Request specs are the contract: `spec/requests/api/v1/orders_spec.rb`, `type: :request`, one `describe` per endpoint, using the app's existing helpers (`include_context "with authenticated users"`, `login_user(user)`, `let_it_be`).

| Case | Assert |
|---|---|
| happy path | status, exact payload keys and values |
| invalid params | 422, machine-readable `code`, `details[].field` |
| wrong identity | 401 unauthenticated; 403 or 404 for another owner's record |
| missing resource | 404 with the not-found code |

* Assert the shape and the values you promise, not the whole body: `expect(response.parsed_body).to include("id" => order.id, "status" => "paid")`, plus a key-set assertion (`match_array`) where the key set *is* the contract.
* Keep fixtures under `spec/contracts/` (this app already groups them by domain) so request specs and any future schema export share one source.
* Schema export (rswag, rspec-openapi) only when the repo adds it; until then the request specs are the schema, so make them readable as documentation.
* Versioning policy: additive changes within a version; a removal, rename, or type change needs a sibling `v2`, both served for a stated deprecation window, with deprecation headers and a changelog entry.

## Checklist

| Before calling it done | Check |
|---|---|
| Payload | explicit keys, no `render json: model`, ISO8601 UTC, minor units for money |
| Errors | one envelope, machine-readable `code`, no stack traces or SQL |
| Auth | token or session as designed, owner-scoped query, 401 vs 403 vs 404 |
| Collections | paginated with a cap, allow-listed sort and filters |
| Writes | idempotent or key-safe, 202 + job for slow work, no client-set owner |
| Specs | happy, validation, authz, and 404 examples green |
| Ops | `X-Request-Id` returned, `Rails.error.report` on 500s, logs carry the id |
