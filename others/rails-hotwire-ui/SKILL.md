---
name: rails-hotwire-ui
description: Server-rendered UI work with Hotwire. Use when changing views, layouts, or forms; when a Turbo Frame or turbo_stream response updates the wrong place or nothing at all; when adding live broadcasts or morphing refreshes; when writing or registering Stimulus controllers under app/javascript/controllers.
---

# Rails Hotwire UI

Turbo and Stimulus are present in the Rails 8 default stack (`turbo-rails`, `stimulus-rails`) — but a `config.api_only = true` app has neither and no `app/javascript/`. Check `app/javascript/controllers/` and `Gemfile.lock` before assuming the stack exists; add it with `bundle add turbo-rails stimulus-rails` then `bin/rails turbo:install stimulus:install`. The server renders HTML; JavaScript only upgrades it.

## Build order — stop at the first row that solves the problem

| Step | Buys you | Costs |
|---|---|---|
| Plain form + redirect | A working feature, zero JS | Nothing |
| `turbo_frame_tag` | Section swap, URL and history intact | Frame ids must match between request and response |
| `turbo_stream` response | Several targets updated from one request | A second template per action |
| `broadcasts_to` + `turbo_stream_from` | Live updates for other clients | Action Cable configuration |

Never start at the bottom. If the stream path breaks with JS off, the baseline was skipped.

## Drive and frames

Drive is app-wide: it intercepts link clicks and form submits, fetches, and replaces `<body>`.

- Put behavior in a `connect()`/`disconnect()` pair and bind document listeners once — page scripts do not re-run the way a full page load does, and `turbo:load` fires again on every visit.
- `data-turbo="false"` opts one link or form out (file downloads, external redirects, non-Turbo endpoints); `data-turbo-frame="_top"` sends one request to the whole page instead of the enclosing frame.

```erb
<%= turbo_frame_tag dom_id(@order, :form) do %>
  <%= render "orders/form", order: @order %>
<% end %>
<%= turbo_frame_tag "stats", src: stats_path, loading: :lazy %>   <%# fetches on viewport entry %>
```

A request issued **inside** a frame is scoped to that frame: the response must contain exactly one `<turbo-frame>` whose `id` matches the frame that made the request. One frame per id per response — a frame nested inside the frame it targets is the id-duplication bug.

## Streams

```ruby
respond_to do |format|
  format.turbo_stream                 # renders create.turbo_stream.erb
  format.html { redirect_to @order }  # non-JS clients
end
```

```erb
<%# app/views/orders/create.turbo_stream.erb — or inline: render turbo_stream: … %>
<%= turbo_stream.replace dom_id(@order, :form) { render "orders/form", order: @order } %>
<%= turbo_stream.prepend "orders", @order %>
```

`broadcasts_to` on the model emits create/update/destroy streams; `turbo_stream_from` in the view subscribes the page.

```ruby
broadcasts_to ->(message) { [message.chat, :messages] }   # Message model
```

Action Cable must be configured for broadcasts to arrive; without it the page renders and simply never updates.

## Morph vs replace

| Situation | Use |
|---|---|
| Data changed, page rebuilt from server state | Default replace |
| Client state must survive: focus, open `<details>`, playing `<video>`, scroll, Stimulus-owned DOM | `<meta name="turbo-refresh-method" content="morph">` in the layout, plus `<meta name="turbo-refresh-scroll" content="preserve">` |
| A frame refreshes itself and must not flicker | `<turbo-frame id="…" refresh="morph">` |

Morph diffs new HTML into the existing DOM, so ids and element order must stay stable. Use `data-turbo-permanent` (with a stable `id`) for elements JavaScript owns.

## Forms

- `form_with model: @order` — Turbo submits it; no `remote: true`, no `data-turbo` switch.
- Invalid input must return **422** with the form re-rendered (`render :new, status: :unprocessable_entity`). A 200 leaves the page unchanged and the errors invisible.
- Scope the form to the frame it belongs to, so an error response swaps the form and not the whole page.
- `data: { turbo_confirm: "Delete this order?" }` for destructive actions.
- `data-turbo-submits-with="Saving…"` disables the submit in flight; a double submit creates duplicate records.

## Stimulus

```js
import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["panel"]
  static values  = { open: { type: Boolean, default: false } }

  connect() { this.render(); this.timer = setInterval(this.tick, 1000) }
  disconnect() { clearInterval(this.timer) }   // Turbo replaces the element: clean up here
  toggle() { this.openValue = !this.openValue }
  openValueChanged() { this.render() }
  render() { this.panelTarget.hidden = !this.openValue }
}
```

- Controller `app/javascript/controllers/reveal_controller.js` pairs with `data-controller="reveal"`; `data-action="click->reveal#toggle"`, `data-reveal-target="panel"`, `data-reveal-open-value` map to `this.toggle()`, `this.panelTarget`, `this.openValue`.
- Use `targets`, `values`, and `outlets` instead of `element.querySelector`: scoped, re-checked, and loud when markup drifts.
- One responsibility per controller; compose small ones rather than growing a `page_controller.js`.
- Controllers under `app/javascript/controllers/` are auto-registered by `index.js` (`eagerLoadControllersFrom`); manifest-based setups need `bin/rails stimulus:manifest:update` after adding one. Importmap vs esbuild changes `package.json` and the build step — ask before touching build tooling.

## Debug a frame or stream that does nothing

```js
document.addEventListener("turbo:before-fetch-request", e => console.log("turbo ->", e.target.id, e.detail.url))
document.addEventListener("turbo:fetch-request-error", e => console.error("turbo x", e.target.id, e.detail.error))
```

| Symptom | Cause | Fix |
|---|---|---|
| 200 with a blank body where a stream was expected | the action rendered HTML; no `.turbo_stream.erb` and no `format.turbo_stream` | name the template `create.turbo_stream.erb` or `render turbo_stream:`; the request `Accept` must include `text/vnd.turbo-stream.html` |
| Console: `response has no matching <turbo-frame id="…">` | the response lacks that frame id, or the id differs by a `dom_id` suffix | wrap the partial in `turbo_frame_tag` with the exact id requested |
| Frame silently never updates | the id appears twice — a frame nested inside its own target | one frame per id; use `data-turbo-frame="_top"` to escape |
| Form errors vanish, URL unchanged | the invalid render returned 200 | re-render with `status: :unprocessable_entity` |

The response preview pane in the Network tab shows which template actually rendered — Turbo requests are ordinary fetches.

## Prove it

- Build in order — no JS, then frame, then stream — and re-check the core flow with JavaScript disabled.
- Request specs never execute JavaScript and cannot see frames, streams, or Stimulus. If `spec/system/` does not exist, add capybara plus a JS-capable driver before claiming a Hotwire flow works.
- Smoke it in a real browser: click the flow, watch the Network tab for the Turbo request and its status, then confirm the DOM after the swap.
