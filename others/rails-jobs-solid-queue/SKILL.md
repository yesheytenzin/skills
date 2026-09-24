---
name: rails-jobs-solid-queue
description: Background jobs and recurring schedules in a Rails app running Solid Queue — writing or changing a job, choosing its arguments, retrying or discarding failures, wiring config/recurring.yml, testing enqueue and perform, and triaging a backlog, a poison job, or duplicate work in the solid_queue tables.
---

# Jobs on Solid Queue

Active Job shapes the job; Solid Queue runs it through SQL tables. A job enqueued inside a transaction, or handed an AR object, breaks in production and nowhere else.

Find the app's pieces before writing one: `grep -rn queue_adapter config/environments/`, workers in `config/queue.yml`, recurring entries in `config/recurring.yml`, the jobs already in `app/jobs/` (copy their namespacing, queues, and error handling), and the supervisor — `bin/jobs`, recreated with `bin/rails g solid_queue:install` if missing, validated with `bin/jobs check`. Solid Queue often uses its own database (`config.solid_queue.connects_to`), so a job's `find_by` reads a different connection than the enqueuing transaction.

## Job shape

* One public `perform`, plus Active Job macros (`queue_as`, `retry_on`). Arguments are primitives — ids, strings, numbers, hashes of those — never an AR object you own: `ReceiptJob.perform_later(order.id)`, not `perform_later(order)`.
  An AR argument is stored as a GlobalID and reloaded at run time: if the row is gone Active Job raises `ActiveJob::DeserializationError`, and a renamed or deleted class leaves queued rows that can never run. Pass ids, load inside `perform`.
* Load defensively: `find_by(id:)` + `return if nil` when "already deleted" is normal; `find` + `discard_on ActiveRecord::RecordNotFound` when it is exceptional. Small job, then fan out — a `perform` looping over 10k rows should enqueue child jobs, so one failure cannot lose the batch and a retry stays cheap.
* Idempotent by construction — guard on state, not on "have I run before":
  ```ruby
  certificate = Certificate.find_by(id: certificate_id)
  return if certificate.nil? || certificate.file.attached?
  ```
  Assume at-least-once delivery and a crash mid-`perform`: the second run must be a no-op or a correct overwrite. Return values are discarded, so persist results.

## Never enqueue inside a transaction

```ruby
Order.transaction do
  order.save!                          # not committed
  ReceiptJob.perform_later(order.id)   # a worker on another connection sees this now
end
```

The worker claims the job before the commit lands, its `find_by(id:)` returns nil, and you get a discarded job or a silently missing receipt. On rollback you get a job that must never exist.

* Enqueue after the commit — `after_create_commit :enqueue_receipt` on the model (same as `after_commit ..., on: :create`) — or let the service return and call `perform_later` in the caller. `after_save` and `after_create` run inside the transaction: never enqueue there.
* `after_commit` does not fire when nothing commits, so building or rolling back an object enqueues nothing. RSpec's transactional fixtures *do* fire it, so `expect { create(:order) }.to have_enqueued_job(ReceiptJob)` is a real assertion.

## Retries, discards, poison jobs

```ruby
class Certificates::RenderPdfJob < ApplicationJob
  retry_on Gotenberg::GotenbergDownError, wait: :polynomially_longer, attempts: 6
  discard_on ActiveJob::DeserializationError  # also ActiveRecord::RecordNotFound, when "gone" is terminal
end
```

* Bound every `retry_on` with `attempts:`. After the last attempt the exception is re-raised and Solid Queue stores the job in `solid_queue_failed_executions` — that table is the dead letter. `wait: :polynomially_longer` beats a fixed delay against a rate-limited downstream.
* `discard_on` is the explicit "don't retry, don't alarm" path; use it only when the input is genuinely gone, otherwise it hides the bug. Never wrap the body in `rescue => e; Rails.logger.error(e); end` — an unhandled raise is the only signal the retry and dead-letter machinery gets.
* Order retryable steps first and the idempotent write last: everything before the failing line runs again. Inspect and drain the dead letter:
  ```bash
  bin/rails runner 'puts SolidQueue::FailedExecution.count'
  bin/rails runner 'SolidQueue::FailedExecution.order(created_at: :desc).limit(5).each { |f| puts [f.job.class_name, f.exception_class, f.message].join(" | ") }'
  ```
  `SolidQueue::FailedExecution#retry` re-enqueues one job, `FailedExecution.retry_all(scope)` drains many. Fix the cause first, or you re-poison the queue.

## Queues, priority, concurrency

* Two or three real queues — `queue_as :default`, `queue_as :background`, `queue_as :bulk` — mapped to workers in `config/queue.yml`; `queues: "*"` runs everything everywhere. A long job holds a thread for its whole duration, so slow external calls get their own queue and threads.
* `priority:` is an integer nudge (lower first, `solid_queue_jobs.priority`), not a fairness guarantee.
* Serialize per record with a semaphore, not a Ruby lock: `limits_concurrency to: 1, key: ->(id) { "certificate-#{id}" }, duration: 10.minutes`. Derive the key from arguments alone and always set `duration:`, so a killed worker cannot hold it forever; blocked jobs wait in `solid_queue_blocked_executions`.

## Scheduling

| Need | Mechanism | Table |
|---|---|---|
| "In ten minutes", one record | `perform_later` / `set(wait: 10.minutes)` | `solid_queue_scheduled_executions` |
| "Every day at 8am", app-wide | `config/recurring.yml` | `solid_queue_recurring_tasks` |

```yaml
production:                              # entries are keyed by environment
  nightly_rollup:
    class: Reports::NightlyRollupJob     # or: command: "Reports::NightlyRollup.call"
    queue: background
    args: [ 1000, { batch_size: 500 } ]
    schedule: every day at 8am           # Fugit, e.g. "every hour at minute 12"
```

* Runs are recorded in `solid_queue_recurring_executions` (unique on `task_key` + `run_at`), so a restart inside the same minute does not double-enqueue that instant.
* Times use the process's `Time.zone`: set `config.time_zone`, do not lean on the host clock, and avoid an hour that lands twice or never across a DST boundary.
* Thundering herd: stagger tasks (`at 8:07am`) and make a recurring entry a cheap dispatcher that fans out one job per record — a giant sweep holds one thread and one huge transaction. Each run must be self-sufficient ("what is due *now*"); missed windows are not backfilled.
* Timing: `solid_queue_jobs` has `created_at`, `scheduled_at`, `finished_at` and **no `started_at`** (`grep -n started_at db/queue_schema.rb`). Start ≈ `solid_queue_claimed_executions.created_at`; duration ≈ `finished_at - claim.created_at`.

## Testing

Specs mirror `app/` (`app/jobs/certificates/render_pdf_job.rb` → `spec/jobs/certificates/render_pdf_job_spec.rb`); run them with `bundle exec rspec spec/jobs/...` (this app has no `bin/rspec`). `type: :job` specs get `ActiveJob::TestHelper`, and the test adapter means nothing runs unless you perform it.

* Test behaviour with `perform_now`; assert the enqueue seam separately:
  ```ruby
  expect(Certificates::RenderPdfJob).to have_been_enqueued.with(certificate.id)
  described_class.perform_now(certificate.id)
  expect(certificate.reload.file).to be_attached
  ```
* Use `perform_enqueued_jobs { ... }` (optionally `only:`) when the wiring itself is under test. Assert idempotency by running twice and comparing end state, never by counting calls: `expect { described_class.perform_now(id) }.not_to change { certificate.reload.file.blob.checksum }`.
* Stub remote boundaries (`allow(Certificates::RenderPdf).to receive(:call)`); no network, storage, or sleeps. Give each `retry_on` its own example: make the dependency raise, then assert the job was re-enqueued.

## Operating

* `bin/jobs` runs the supervisor from `config/queue.yml`. It also prunes dead workers (stale `last_heartbeat_at`) and fails the jobs they had claimed with a `ProcessPrunedError`, so an abrupt kill shows up in the dead letter; a graceful shutdown releases them back to the queue instead. Either way, jobs must be idempotent.
* Tables are the source of truth: `solid_queue_jobs` (all), `_ready_executions` (queued), `_claimed_executions` (running), `_scheduled_executions`, `_blocked_executions` (semaphore), `_failed_executions` (dead letter), `_recurring_tasks` / `_recurring_executions`, `_semaphores`, `_processes`, `_pauses`.
* Triage in this order:
  1. Depth and age — `bin/rails runner 'puts SolidQueue::ReadyExecution.group(:queue_name).count'`; the oldest ready job separates backlog from outage.
  2. Workers — `SolidQueue::Process.all`; a stale heartbeat means the supervisor died, not that the database is slow.
  3. Dead letter — one poison job, or a systemic break?
  4. Logs for the failing class (production lines carry `request_id`; job lines are separate — search by class name).
  5. The database last: lock waits, pool exhaustion, a runaway sweep.
* Pause a queue to stop the bleed without killing workers: `SolidQueue::Queue.find_by_name("default").pause` / `.resume` / `.clear` (rows land in `solid_queue_pauses`). When the repo has a dashboard such as Mission Control, read the same numbers there.
* Schedule cleanup of finished jobs (`SolidQueue::Job.clear_finished_in_batches(sleep_between_batches: 0.3)`, as this app's `clear_solid_queue_finished_jobs` recurring entry does) — unbounded `solid_queue_jobs` growth is the usual reason a queue database turns slow.

## Job smells

| Smell | Fix |
|---|---|
| `perform(record)` / `perform(user)` | pass the id, load inside `perform` |
| `perform_later` inside `transaction`, `after_save`, `after_create` | `after_create_commit`, or enqueue in the caller |
| `retry_on X` without `attempts:` | bound it, and add a `discard_on` fallback |
| `rescue` everything into a log line | let it raise; the dead letter is the record |
| Job sleeps, polls, or waits for another job | split in two; the first enqueues the second |
| Loop over every record inside one job | fan out one job per record |
| Job reads `Current.user`, session, or ENV | pass explicit arguments |
| Re-running duplicates rows, files, or emails | guard on state; make it idempotent |
