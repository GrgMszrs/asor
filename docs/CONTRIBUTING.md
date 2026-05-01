# Contributing to asor

## Local setup

```bash
# Python workspace
uv sync --all-packages

# Pre-commit hooks
uv run pre-commit install

# Web app
cd apps/web && bun install && cd ../..

# Bring everything up
cp .env.example .env  # put your GEMINI_API_KEY
docker compose -f infra/compose/docker-compose.yml up --build
```

## Branching strategy

| Prefix      | Use for                              |
| ----------- | ------------------------------------ |
| `feat/`     | New user-facing capability           |
| `fix/`      | Bug fix                              |
| `chore/`    | Tooling, deps, infra, no code change |
| `docs/`     | Documentation only                   |
| `refactor/` | Internal restructure, no behavior    |
| `test/`     | Adding/fixing tests                  |

`main` is protected. Branch from `main`, open a PR back into `main`.

## Commit & PR titles

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat(api): add /tasks streaming endpoint
fix(runner): handle non-zero gemini exit codes
chore: bump @google/gemini-cli to 0.40.1
```

Squash-merge is the default. The PR title becomes the squash commit message — keep it clean.

## PR checklist

- [ ] CI green (lint, typecheck, tests)
- [ ] No new `# noqa`, `# type: ignore`, or `eslint-disable` without a one-line reason
- [ ] If you added a Gemini CLI subagent / extension / command, document it in the PR body
- [ ] If behavior changed, update `README.md` or the relevant `docs/`

## When to add a subagent vs an API endpoint

- **Subagent** (`.gemini/agents/<name>.md`): the work is reasoning, generation, or tool use that fits within one Gemini CLI invocation.
- **Extension / MCP server**: you need a new tool that Gemini CLI calls (e.g., a domain-specific connector).
- **API endpoint** (`apps/api`): orchestration glue — receiving a task, persisting state, fan-out, returning a stream. Keep it thin.

## Don't

- `--no-verify` on commits or pushes.
- Force-push to shared branches.
- Commit secrets, `.env`, or anything from `.gemini/sessions/`.
- Add a non-GCP cloud dependency.
