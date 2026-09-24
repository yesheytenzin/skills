---
name: rails-precommit-gate
description: Make Rails' definition of done automatic at commit time. Use when wiring or fixing a pre-commit hook or staged-diff gate for RuboCop, Brakeman, and RSpec; when deciding which checks a change must pass; when local checks and CI disagree; when someone bypasses the hook.
---

# Rails Pre-commit Gate

Run the same checks locally that CI runs, scoped to the files about to be committed, in about 15 seconds. The gate is versioned code in the repo (`scripts/gate.sh`) and the hook is a one-line call to it, so the logic stays reviewable and every clone gets the same gate.

## Checks the gate runs

| Check | Command | Scope |
|---|---|---|
| Style | `bin/rubocop $(git diff --cached --name-only --diff-filter=ACM \| grep -E '\.rb$')` | staged `.rb` files only |
| Security | `bin/brakeman -q` | repo-wide — Brakeman analyses the app, not a file list |
| Behavior | `bundle exec rspec <specs matching the changed code>` | touched specs; the full suite when `db/`, `config/`, `Gemfile*`, or `lib/` changed |
| Optional | `bundle exec erb_lint --lint-all`, `bundle exec i18n-tasks health` | only when the repo has them (`grep -E 'erb_lint\|i18n-tasks' Gemfile`) |

Prefer the app's binstubs (`bin/rubocop`, `bin/brakeman`) when `ls bin/` shows them, and `bundle exec` otherwise — there is no `bin/rspec` unless someone ran `bundle binstubs rspec-core`.

## scripts/gate.sh

```bash
#!/usr/bin/env bash
# Commit gate: staged Ruby files only, target <15s. CI re-runs the same commands.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"   # hook cwd is not guaranteed; diff paths are root-relative

if [ "${GATE_SKIP:-}" = "1" ]; then
  echo "gate skipped (GATE_SKIP=1) - put the reason in the commit message" >&2
  exit 0
fi

mapfile -t changed < <(git diff --cached --name-only --diff-filter=ACM -- '*.rb')
if [ "${#changed[@]}" -eq 0 ]; then echo "gate: no staged Ruby files"; exit 0; fi

echo "+ bin/rubocop ${changed[*]}"
bin/rubocop "${changed[@]}"     # style: changed files only, never a silent autocorrect

echo "+ bin/brakeman -q"        # security: always repo-wide
bin/brakeman -q

targets=()
broad=false
for f in "${changed[@]}"; do
  case "$f" in
    spec/*_spec.rb)    targets+=("$f") ;;
    app/*.rb|lib/*.rb) s="spec/${f#*/}"; s="${s%.rb}_spec.rb"; [ -f "$s" ] && targets+=("$s") || true ;;
    db/*|config/*|Gemfile|Gemfile.lock) broad=true; break ;;
  esac
done
# a file staged together with its own spec appears twice; rspec would run it twice
mapfile -t targets < <(printf '%s\n' "${targets[@]:-}" | sed '/^$/d' | sort -u)

if [ "$broad" = true ] || [ "${#targets[@]}" -eq 0 ]; then
  echo "+ bundle exec rspec   # broad change, or no spec matched the touched code"
  bundle exec rspec
else
  echo "+ bundle exec rspec ${targets[*]}"
  bundle exec rspec "${targets[@]}"
fi
```

`app/models/order.rb` maps to `spec/models/order_spec.rb`; a changed controller with no `spec/controllers` file falls through to the full suite. If that fallback fires often, the fix is request specs, not a weaker gate.

## Hook wiring — pick one

| Option | Setup | Notes |
|---|---|---|
| Plain git hook | `git config core.hooksPath .githooks` + a committed `.githooks/pre-commit` | No dependency; each clone must run the config command — put it in `bin/setup` |
| lefthook | `lefthook.yml` (below) + `lefthook install` | Committed config, per-glob commands, installed per clone |
| husky + lint-staged | `npx husky init`; `.husky/pre-commit` runs `npx lint-staged`, globs in `package.json` | Choose when the repo already has Node tooling |
| pre-commit | `.pre-commit-config.yaml` with a `local` repo, `entry: scripts/gate.sh`, `pass_filenames: false`, `always_run: true` | Python-side tooling |

```yaml
# lefthook.yml
pre-commit:
  commands:
    gate:
      run: scripts/gate.sh
      stage_fixed: false      # the gate never edits files
```

```bash
mkdir -p .githooks
printf '#!/usr/bin/env bash\nexec "$(git rev-parse --show-toplevel)/scripts/gate.sh"\n' > .githooks/pre-commit
chmod +x .githooks/pre-commit scripts/gate.sh && git config core.hooksPath .githooks
```

## Rules

- **Fast.** Style, security, and the matching specs only — a gate that blocks for a minute gets disabled. The full suite belongs to CI (`.github/workflows/test.yaml`) and to `bin/ci` before a push.
- **Never auto-fix.** No `rubocop -a` in the gate; it hides what changed and `-A` can alter behavior. Print the failure and let the author fix it.
- **Never bypass with `git commit --no-verify`** — that skips every hook, including the ones you forgot exist.
- **Keep the gate in version control.** Never a hand-edited `.git/hooks/pre-commit`: unversioned, unreviewable, and absent for teammates.
- **Fail loudly.** Echo the exact command before running it, so the re-run line is the last thing on screen, and exit non-zero at the first failure.
- **Migrations path to the full suite** — `db/migrate/*` and `db/schema.rb` changes always run `bundle exec rspec`, never a partial run.
- **Never add inline `# rubocop:disable`** to get past the gate. If a cop is wrong here, disable it once in `.rubocop.yml` with a comment saying why.

## Escape hatch

- `GATE_SKIP=1 git commit -m "…"` for a real emergency (hotfix on broken main, machine missing the toolchain). The script prints that it skipped; state the reason in the commit message and fix it in the next commit.
- Never make the skip permanent: no `exit 0` at the top of `gate.sh`, no deleted hook, no `--no-verify` shell alias. If the gate is too slow or too noisy, fix the gate.

## Local and CI agree

- CI runs whole-repo `bin/rubocop`, `bin/brakeman`, and the full `bundle exec rspec`; the gate is a strict subset on a smaller file set. When local passes and CI fails, the difference is scope, not rules.
- Run full `bin/rubocop` and `bundle exec rspec` before pushing a branch, not just before each commit.
- If a check exists only in CI, either add it to `scripts/gate.sh` or delete it from CI — two definitions of done is how regressions ship.
