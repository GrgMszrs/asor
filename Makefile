.PHONY: help install hooks lint typecheck test build up down logs clean

help:
	@echo "asor — common dev commands"
	@echo "  make install   — uv sync + bun install"
	@echo "  make hooks     — install pre-commit hooks"
	@echo "  make lint      — ruff + eslint"
	@echo "  make typecheck — mypy + tsc"
	@echo "  make test      — pytest"
	@echo "  make build     — build all docker images"
	@echo "  make up        — docker compose up"
	@echo "  make down      — docker compose down"

install:
	uv sync --all-packages
	cd apps/web && bun install

hooks:
	uv run pre-commit install

lint:
	uv run ruff check .
	uv run ruff format --check .
	cd apps/web && bun run lint

typecheck:
	uv run mypy packages/core apps/api
	cd apps/web && bun run typecheck

test:
	uv run pytest

build:
	docker compose -f infra/compose/docker-compose.yml build

up:
	docker compose -f infra/compose/docker-compose.yml up

down:
	docker compose -f infra/compose/docker-compose.yml down

logs:
	docker compose -f infra/compose/docker-compose.yml logs -f

clean:
	rm -rf .venv apps/web/node_modules apps/web/.next
