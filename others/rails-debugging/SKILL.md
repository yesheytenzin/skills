---
name: rails-debugging
description: Diagnosing wrong or failing Rails behavior — an exception or 500, a save/update that silently does nothing, an N+1 or slow query, a callback or job that never fired. Use when you must reproduce a failure, break into running code, read logs, or trace a frame into a gem.
---

# Debugging Rails

Reproduce, observe, then fix. A cause you have not seen in command output is a guess, not a diagnosis.

## Reproduce first

Shrink the failure to one command with one input, and run it yourself.

| Situation | First move |
|---|---|
| Model, service, query | `bin/rails runner 'p Certificates::RenderPdf.call(certificate: Certificate.last)'` |
| One request path | `bundle exec rspec spec/requests/trainers_spec.rb:42` |
| Data state | `bin/rails console` — pick the env deliberately |
| A job that misbehaves | `bin/rails runner 'Certificates::RenderPdfJob.perform_now(id)'` — inline, so the exception surfaces |
| Order dependence | rerun the suite with a different seed: `bundle exec rspec --seed 1234` |

* `bin/rails runner` is the tightest loop: real env, no server, no browser; `-e production` selects the env.
* Read-only on production data: `RAILS_ENV=production bin/rails console --sandbox` rolls back every write at exit. Keep the queries small anyway.
* Bug in committed behavior? Write the failing spec first; it stays as the regression test.

## Break in

This app bundles no `debug` gem — add `gem 'debug'` if absent (`bundle install`), or use stdlib `binding.irb`.

| Tool | Use |
|---|---|
| `binding.irb` | Anywhere, no gem needed: IRB prompt on that frame. |
| `binding.break` | With `debug`: real stepper — `next`, `step`, `up`, `p expr`. |
| `binding.break(if: -> { order.nil? })` | Conditional: trips only on the interesting case. `debugger` is an alias. |

* A break in request code stops the terminal running `bin/rails server` in the foreground.
* No TTY (container, background, `bin/dev` jobs)? Start nonstop and attach:

```bash
RUBY_DEBUG_NONSTOP=1 bin/rails server   # keeps running until you attach
rdbg -A                                 # attach from another terminal in the app dir
```

* Before committing: `grep -rn 'binding\.\(break\|irb\)\|debugger' app lib spec` — a left-in breakpoint hangs specs and production.

## Logs

```bash
tail -f log/development.log
RAILS_LOG_LEVEL=debug bin/rails runner '...'    # production reads this env; dev already logs at debug
bin/rails log:clear LOGS=development            # truncate one log, keep the rest
grep -n 'Completed 500' log/development.log
```

* Tag the path you care about so its lines are greppable: `Rails.logger.tagged('checkout') { Rails.logger.info("order=#{order.id}") }`.
* Development already logs the useful context (`config/environments/development.rb`): `active_record.verbose_query_logs`, `query_log_tags_enabled`, `active_job.verbose_enqueue_logs`, `action_dispatch.verbose_redirect_logs` — they name the app frame behind each query, enqueue, and redirect.
* Deployed logs are JSON (`lib/logging/json_log_formatter.rb`, shipped to Loki): one object per line with `time`, `level` (downcased), `source_type` (`puma` / `solid` / `rails`), plus `request_id` (`config.log_tags`), `job_class`, `job_id`. Filter fields, not prose: `grep '"level":"error"'`. Vendor webhook/API traffic goes through `Loggers.for(vendor:, direction:)`.
* Follow the app's error reporting rather than inventing one: `Rails.error.report(error, handled: true, severity: :error, source: 'http_request')` and `Rails.error.set_context(vendor: :sbh, direction: :inbound)` (`app/controllers/concerns/error_responders.rb`, `app/controllers/sso_controller.rb`). Sentry is the subscriber.

### Time one thing without a profiler

```ruby
ActiveSupport::Notifications.subscribe('sql.active_record') do |*, payload|
  next if payload[:duration].nil? || payload[:cached] || payload[:name] == 'SCHEMA'
  Rails.logger.debug { "#{payload[:duration].round(1)}ms #{payload[:sql]}" }
end
ActiveSupport::Notifications.subscribe('render_partial.action_view') do |*, p|
  Rails.logger.debug { "render #{p[:identifier]} #{p[:duration].round(1)}ms" }
end
```

Drop this in `bin/rails runner` or a dev-only initializer. `process_action.action_controller` carries `view_runtime`, `db_runtime`, and `status` per request.

## N+1 and slow queries

* Bullet is wired in test (`config/environments/test.rb`: `Bullet.raise = true`), so an N+1 fails the spec; findings land in `log/bullet.log`. Development has no Bullet block — add `Bullet.enable = true` (plus `bullet_logger`/`raise` as you prefer) to a `config.after_initialize` block in `config/environments/development.rb` if you want it in the browser.
* Relation SQL: `User.where(active: true).order(:created_at).limit(5).to_sql`.
* Plan (this app is PostgreSQL): `User.limit(2).explain(:analyze)` in the console prints the plan; in a script use `.explain(:analyze).inspect`. Look for `Seq Scan` on a large table, `rows=` estimates off by orders of magnitude, and high `loops=`.
* Raw SQL: `ActiveRecord::Base.lease_connection.select_value('SELECT 1')` / `.execute('EXPLAIN ANALYZE ...')`. For a slow request, the SQL lines with durations in `log/development.log` point at the frame above them.

## Silent failures

Nothing raises and nothing changes. Check in this order.

| Symptom | Probe |
|---|---|
| Row unchanged / 200 with no write | `save` returned `false` — call `save!`/`update!` and read `record.errors.full_messages`; a service returned a failure result nobody checked |
| Callback never ran | A `before_*` callback that ran `throw(:abort)`, or a halting chain: test the callback directly |
| `after_commit` "never fires" | It runs at the outermost commit, not at the save: deferred to the end of a wrapping `transaction do` block, skipped if that transaction rolls back, skipped on `after_rollback`, and filtered by `on:`/`if:`. Look for a surrounding transaction or rollback first. (Specs here wrap examples in DatabaseCleaner's transaction strategy, started `joinable: false`, so commit callbacks do still run — that is not your bug.) |
| Exception vanished | `rescue => e` that neither re-raises nor reports; grep `rescue` around the call site |
| Job never ran | `bin/rails runner 'puts SolidQueue::FailedExecution.last&.message'`; `SolidQueue::Job.where(finished_at: nil).last(5)`; start a worker with `bin/jobs` |
| Enqueued but no effect | Wrong queue adapter for that env, or the job rescued its own error |
| Association empty | Wrong scope/`default_scope`, unsaved owner (`persisted?`), or a stale in-memory object — `reload` it |

`SolidQueue::FailedExecution#retry` (and `.retry_all`) requeues once the cause is fixed; `bin/jobs` reads `config/queue.yml`, recurring tasks come from `config/recurring.yml`.

## Stack traces: find your frame

* Read top-down for the first `app/` or `spec/` frame; gem frames above it are usually the reporter, not the cause.
* `bundle exec rspec --backtrace` (`-b`) prints the full trace; the default truncation hides the frame you need.
* `bundle show <gem>` prints its path — read the source instead of guessing: `grep -rn 'def save' $(bundle show activerecord)/lib/active_record/persistence.rb`.
* Live objects: `obj.method(:name).source_location`, `SomeClass.instance_method(:call).source_location`.
* `NoMethodError` inside a gem is usually version skew — check `Gemfile.lock` before rewriting your code.

## Symptom → first probe

| Symptom | First probe |
|---|---|
| 500 in dev | The exception page's backtrace, then `bin/rails runner` the same call |
| Spec fails, app works | The spec's setup (factories, DatabaseCleaner, frozen time), not the app |
| Works in dev, fails in test | Env diff: `Bullet.raise`, `cache_store = :null_store`, `eager_load` under CI |
| Works alone, fails in suite | Order dependence — rerun with a different seed, then hunt leaked global state |
| Slow endpoint | SQL durations in the log, then `.explain(:analyze)` on the slowest query |
| Wrong data after a write | Halted callbacks, lazy-loaded associations, stale objects (`reload`) |
| "Cannot run" in console | `bin/rails -v`, `ruby -v`, and a missing `bundle exec` prefix |

## Clean up

Remove breakpoints, temporary loggers, ad-hoc `puts`, and throwaway scripts. Keep the regression spec. Validate the fix with the repo's gates: `bin/rubocop` on touched files and `bundle exec rspec` (this app has no `bin/rspec` binstub). Never silence a cop inline — fix the code, or disable the cop once in `.rubocop.yml` with a reason.
