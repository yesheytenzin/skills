# skills

My personal collection of agent skills and extensions, organized in three groups:

- **`matt-pocock/`** — Matt Pocock's idea-to-ship system
- **`others/`** — personal & custom skills
- **`extensions/`** — Pi coding-agent extensions

## Install

Copy a skill into your agent's skills dir, e.g.:

```bash
# for Pi
cp -r matt-pocock/tdd ~/.pi/agent/skills/
# for generic agents
cp -r others/find-skills ~/.agents/skills/
```

Or symlink a whole group:

```bash
git clone https://github.com/yesheytenzin/skills.git
ln -s $(pwd)/skills/matt-pocock/* ~/.agents/skills/
```

## matt-pocock (29)

Matt Pocock's idea-to-ship system, routed by `ask-matt`: grill (`grill-with-docs`/`grill-me`/`grilling`), spec (`to-spec`/`to-tickets`), build (`implement`/`implement-spec`), upkeep (`triage`, `diagnosing-bugs`, `wayfinder`, `improve-codebase-architecture`), plus the `domain-modeling`/`codebase-design` vocabulary layer.

| Skill | Description |
|---|---|
| `ask-matt` | Ask which skill or flow fits your situation. A router over the skills in this repo. |
| `code-review` | Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standa |
| `codebase-design` | Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a se |
| `diagnosing-bugs` | Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow. |
| `domain-modeling` | Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a CONTEXT.md, or recording or editing an ADR. |
| `grill-me` | A relentless interview to sharpen a plan or design. |
| `grill-with-docs` | A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go. |
| `grilling` | Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases. |
| `handoff` | Compact the current conversation into a handoff document for another agent to pick up. |
| `implement` | Implement a piece of work based on a spec or set of tickets. |
| `implement-spec` | Implement a specification in code. |
| `improve-codebase-architecture` | Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one you pick. |
| `loop-me` | Grill me about specs for the workflows I want to build, within this workspace. |
| `principle-attack-the-premise` | Apply when two or more fixes that share one premise have failed the same gate. Take a census of which actors hold the imbalance before the next fix, then questi |
| `principle-test-behavior-not-implementation` | Apply when you write, change, or keep a test. Call the code the way its users do and assert the result they observe against a literal expected value. If the tes |
| `prototype` | Build a throwaway prototype to answer a design question. Use when the user wants to sanity-check whether a state model or logic feels right, or explore what a U |
| `research` | Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, d |
| `resolving-merge-conflicts` | Use when you need to resolve an in-progress git merge/rebase conflict. |
| `retro` | Conduct a retrospective on a coding session. |
| `setup-matt-pocock-skills` | Configure this repo for the engineering skills: set up its issue tracker, triage label vocabulary, and domain doc layout. Run once before first use of the other |
| `setup-ts-deep-modules` | Wire dependency-cruiser into a TypeScript repo so each package is a deep module, with implementation hidden in subfolders and reachable only through its entry-p |
| `to-questionnaire` | Turn a decision you can't fully answer into a questionnaire for someone else to fill in. |
| `to-spec` | Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed. |
| `to-tickets` | Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edg |
| `triage` | Move issues and external PRs through a state machine of triage roles, categorise, verify, grill if needed, and write agent-ready briefs. |
| `wait-what` | Stop. That last message did not land: re-pitch it. |
| `wayfinder` | Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until |
| `wizard` | Generate an interactive bash wizard that walks a human through steps only they can perform. Use when provisioning infrastructure, setting up credentials or CI s |
| `writing-for-agents` | Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md. |

## others (11)

Personal and custom skills: Omarchy maintenance, Rails conventions, exercise scaffolding, pre-commit setup, writing (`writing-beats`/`fragments`/`shape`), and misc utilities.

| Skill | Description |
|---|---|
| `claude-handoff` | Hand the current conversation off to a fresh background agent that picks up the work immediately. |
| `find-skills` | Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express int |
| `git-guardrails-claude-code` | Set up Claude Code hooks to block dangerous git commands (push, reset --hard, clean, branch -D, etc.) before they execute. Use when user wants to prevent destru |
| `migrate-to-shoehorn` | Migrate test files from `as` type assertions to @total-typescript/shoehorn. Use when user mentions shoehorn, wants to replace `as` in tests, or needs partial te |
| `omarchy-maintenance` | >- |
| `rails-conventions` | >- |
| `scaffold-exercises` | Create exercise directory structures with sections, problems, solutions, and explainers that pass linting. Use when user wants to scaffold exercises, create exe |
| `setup-pre-commit` | Set up Husky pre-commit hooks with lint-staged (Prettier), type checking, and tests in the current repo. Use when user wants to add pre-commit hooks, set up Hus |
| `writing-beats` | Writing, exploit; assemble raw material into a journey of beats, grounding each term before a beat leans on it. |
| `writing-fragments` | Writing, explore: mine raw fragments, no structure yet. |
| `writing-shape` | Writing, exploit: shape raw material into an article, paragraph by paragraph. |

## Notes

- `matt-pocock/principle-attack-the-premise` and `matt-pocock/principle-test-behavior-not-implementation` are additions to the principle family that pair with the Matt Pocock flow (`grilling`, `tdd`).

## extensions (2)

Pi coding-agent extensions (live in `~/.pi/agent/extensions/`):

| Extension | Description |
|---|---|
| `destructive-guard.ts` | Confirm-before-run guard for footguns: `rm -rf`, pacman cache wipes, `rails db:drop`, `dd`/`mkfs` on devices, git force-push, etc. |
| `omarchy-system-theme.ts` | Applies the custom `omarchy-system` pi theme on startup so it sticks as default. |
