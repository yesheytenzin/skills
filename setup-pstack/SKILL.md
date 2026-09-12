---
name: setup-pstack
description: Configure which models pstack uses per role for pi and opencode. Detects your available models and writes a config file that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack (pi / opencode port)

Original cursor skill wrote `~/.cursor/rules/pstack-models.mdc`. This port writes pi/opencode-compatible config instead.

## Pi vs Opencode model slugs

Cursor defaults use slugs like `grok-4.6-fast-xhigh`, `claude-fable-5-1-thinking-max`, `gpt-5.6-sol-max`. Pi via `opencode-go` uses slugs like `opencode-go/muse-spark-1.2-contributor`, `opencode-go/kimi-k3`, `openai-codex/gpt-5.6-sol`, `nvidia/minimax-m3`. Opencode (Zen) uses `opencode/gpt-5.6-sol` etc. Map roles to whatever your harness actually provides.

## Steps

### 1. Detect available models

- **pi:** Read `~/.pi/agent/settings.json` (`enabledModels`), run `pi --list-models` or `pi update --models`, and list models available to the current session. The `opencode-go/` prefix matters.
- **opencode:** Read `~/.config/opencode/opencode.json`, run `opencode models`, and consider `opencode.json` project overrides.
- If no model list is discoverable, ask the user to paste slugs.

Never write a slug you have not confirmed is available. Aliases `inherit-parent` and `auto` always pass (means: run that role on the parent chat model, omit `model` param).

### 2. Load current state

Defaults below are the cursor originals. For pi/opencode, treat them as placeholders to be replaced.

Check for existing config in priority order:
1. `~/.pi/agent/pstack-models.json` (new pi location)
2. `~/.config/opencode/pstack-models.json` (opencode location)
3. `~/.cursor/rules/pstack-models.mdc` (legacy cursor, if present — migrate its values)

If none exists, start from defaults but mark every real slug as needing a choice (since cursor slugs likely not available on pi/opencode).

### 3. Map and confirm

Show every role with its current model, marking any slug not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering detected models plus `inherit-parent`/`auto`.

Panel roles: value is a list, one sub-agent per entry. List length sets fan-out. Upstream pstack defaults panel roles (arena runners, arena cross-judge pool, architect runners, interrogate reviewers) to 4 sub-agents; match or trim as your available models allow.

```
feature, refactoring: <fast-code-model>
bug-fix: <strong-reasoning-model>
perf-issue: <strong-reasoning-model>
hillclimb: <strong-reasoning-model>
judgment and prose: <strong-reasoning-model>
hardest tasks: <strong-reasoning-model>
how explorer: <fast-model>
how explainer: <strong-model>
why investigators: <fast-model>
why synthesizer: <strong-model>
reflect tooling: <tool-model>
reflect judgment, divergent, synthesizer: <strong-model>
arena runners: <strong-model>, <second-model>, <fast-model>
arena cross-judge pool: <strong-model>, <second-model>, <fast-model>
swarm workers: <fast-model>
architect runners: <strong-model>, <second-model>, <fast-model>
interrogate reviewers: <strong-model>, <second-model>, <fast-model>
```

Suggested pi mapping for your current `~/.pi/agent/settings.json`:
- fast code / explorers / swarm workers → `opencode-go/glm-5.3` or `opencode-go/kimi-k2.6`
- strong reasoning / judgment / architect / critics → `opencode-go/muse-spark-1.2-contributor` or `opencode-go/hy3` or `openai-codex/gpt-5.6-sol`
- fallback cheap → `nvidia/minimax-m3` or `opencode-go/deepseek-v4-flash`

For opencode Zen: map to `opencode/muse-spark-1.2-contributor`, `opencode/gpt-5.6-sol`, `opencode/kimi-k3`, etc.

### 4. Validate

Every real slug must be in detected set; `inherit-parent`/`auto` always pass. If a chosen slug is unavailable, stop and ask again.

### 5. Write the config

Write **both** pi and opencode locations so either harness picks it up (they are JSON-identical, skills check both):

**`~/.pi/agent/pstack-models.json`:**
```json
{
  "feature, refactoring": "opencode-go/glm-5.3",
  "bug-fix": "opencode-go/muse-spark-1.2-contributor",
  "perf-issue": "opencode-go/muse-spark-1.2-contributor",
  "hillclimb": "opencode-go/muse-spark-1.2-contributor",
  "judgment and prose": "opencode-go/muse-spark-1.2-contributor",
  "hardest tasks": "opencode-go/muse-spark-1.2-contributor",
  "how explorer": "opencode-go/glm-5.3",
  "how explainer": "opencode-go/muse-spark-1.2-contributor",
  "why investigators": "opencode-go/glm-5.3",
  "why synthesizer": "opencode-go/muse-spark-1.2-contributor",
  "reflect tooling": "openai-codex/gpt-5.6-sol",
  "reflect judgment, divergent, synthesizer": "opencode-go/muse-spark-1.2-contributor",
  "arena runners": ["opencode-go/muse-spark-1.2-contributor", "openai-codex/gpt-5.6-sol", "opencode-go/kimi-k2.6"],
  "arena cross-judge pool": ["opencode-go/muse-spark-1.2-contributor", "openai-codex/gpt-5.6-sol", "opencode-go/kimi-k2.6"],
  "swarm workers": "opencode-go/glm-5.3",
  "architect runners": ["opencode-go/muse-spark-1.2-contributor", "openai-codex/gpt-5.6-sol", "opencode-go/kimi-k2.6"],
  "interrogate reviewers": ["opencode-go/muse-spark-1.2-contributor", "openai-codex/gpt-5.6-sol", "opencode-go/kimi-k2.6"]
}
```

Also write `~/.config/opencode/pstack-models.json` with same content (skills check both paths). Overwrite whole file so re-runs are idempotent.

Legacy `~/.cursor/rules/pstack-models.mdc` is not required for pi/opencode but may be kept for cursor compatibility if desired.

### 6. Confirm

Tell the user the configs were written and apply to new sessions. Re-running updates them.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill or harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on.
