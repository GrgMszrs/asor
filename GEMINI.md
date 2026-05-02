# asor — project context for Gemini CLI

This file is loaded by Gemini CLI as project context.

## Project
asor is a multi-agent orchestrator wrapping Gemini CLI. When asked to plan or implement, prefer Gemini-CLI-native primitives:

- **Subagents** in `.gemini/agents/*.md` over hand-rolled DAGs.
- **Extensions** (MCP servers / tools) over inlined Python helpers.
- **Custom commands** in `.gemini/commands/` over ad-hoc shell snippets.

## Stack
Python 3.11 + FastAPI (apps/api), Next.js + TS (apps/web), Gemini CLI in a container (apps/agent-runner), Postgres, deployed on GCP Cloud Run.

## Conventions
- Conventional-commit titles, squash-merge.
- Python: ruff + mypy strict, 100-char lines.
- TS: strict mode.
- Don't introduce non-GCP cloud providers.
