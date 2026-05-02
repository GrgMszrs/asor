# Claude Code project guide for asor

## What this project is
asor is a multi-agent orchestrator that wraps Gemini CLI. The main agent decomposes user tasks and spawns Gemini CLI subagents (parallel/sequential) packaged with industry-specific skills, plugins, and connectors.

**Key insight:** Gemini CLI provides subagent spawning, MCP, sandboxing, sessions, and streaming JSONL output natively. We do NOT re-implement these — we wrap them.

## Stack (locked for v0.1)
- Python 3.11 + FastAPI for the orchestrator (`apps/api`)
- Next.js + TS + Tailwind for the UI (`apps/web`)
- Gemini CLI in a Docker container as the agent runtime (`apps/agent-runner`)
- Postgres for state, Firestore for live events (prod)
- `uv` for Python deps, `bun` for the Next app
- GCP-only for cloud (Cloud Run, Cloud SQL, Firestore, Secret Manager)

## Branching & PRs
- `main` is protected.
- Feature branches: `feat/<short-desc>`, `fix/<short-desc>`, `chore/<short-desc>`, `docs/<short-desc>`.
- Squash-merge with conventional-commit titles (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Every PR runs `lint + typecheck + test` via GitHub Actions.
- Pre-commit hooks must pass locally — never `--no-verify`.

## Code conventions
- Python: ruff + mypy (strict). 100-char line length. No mutable defaults. Pydantic v2 for models.
- TypeScript: strict mode, no `any` without justification.
- Don't add comments unless the *why* is non-obvious.
- Prefer extending Gemini CLI (extensions, MCP, agents) over building parallel infrastructure.

## When adding a new capability, ask first
1. Does Gemini CLI already do this? (Check `geminicli.com/docs`.) If yes, configure it instead of building it.
2. Should it be a **subagent** (`.gemini/agents/*.md`), an **extension** (MCP server / tool), or an asor-side **API endpoint**? Most domain logic should be a subagent or extension; only orchestration glue belongs in `apps/api`.

## Don't
- Don't add multi-tenancy / auth in v0.1.
- Don't suggest non-GCP cloud providers.
- Don't reinvent agent spawning, tool calling, or sandboxing — Gemini CLI handles them.
- Don't commit `.env`, `settings.local.json`, or anything in `.gemini/sessions/`.
