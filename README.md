# Asor

A multi-agent orchestrator built on top of [Gemini CLI](https://geminicli.com/docs/). Asor turns natural-language tasks into coordinated runs of specialized Gemini CLI sub-agents, packaged with industry-specific skills, plugins, and connectors.

## Stack

- **Frontend:** Next.js + TypeScript + Tailwind (`apps/web`)
- **Backend:** FastAPI (`apps/api`)
- **Agent runtime:** Gemini CLI inside a Docker container (`apps/agent-runner`)
- **Core domain:** Pydantic models, runner interface (`packages/core`)
- **Storage:** Postgres (state) + Firestore (live event streams, prod only)
- **Cloud:** GCP — Cloud Run + Cloud SQL + Firestore + Secret Manager

## Why Gemini CLI

We don't reinvent agent coordination. Gemini CLI already provides:

- **Subagents** as `.md` files with YAML frontmatter (`.gemini/agents/*.md`)
- **Headless / streaming JSONL output** (`gemini -p "..." --output-format stream-json`)
- **MCP server integration**, custom tools, custom commands
- **Sandboxing** via Docker/Podman, **A2A remote subagents**, sessions

asor wraps these with a web UI, persistence, run isolation, and a continuous-learning loop that improves skills over time.

## Quick start

```bash
cp .env.example .env
# put your GEMINI_API_KEY in .env
docker compose -f infra/compose/docker-compose.yml up --build
# UI:  http://localhost:3000
# API: http://localhost:8000/docs
```

## Repo layout

```
apps/
  api/            FastAPI orchestrator
  web/            Next.js UI
  agent-runner/   Container image wrapping Gemini CLI
packages/
  core/           Domain models, runner interface
infra/
  docker/         Dockerfiles
  compose/        docker-compose.yml
  terraform/      GCP IaC (added in Phase 3)
.gemini/
  agents/         Custom subagent definitions
  settings.json   Gemini CLI config (mounted into runner)
docs/             Contributing, branching, PR guidelines
```

## Status

v0.1 — Phase 0 + Phase 1 scaffold. See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the development workflow.