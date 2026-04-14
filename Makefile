# Makefile for AI Gateway
# Fixes: #973 (Makefile for common tasks)

.PHONY: help install dev build test test-unit test-coverage lint format typecheck clean docker-up docker-down release

# Default target
help: ## Show this help message
	@echo "AI Gateway - Available commands:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	bun install

install-frozen: ## Install with frozen lockfile
	bun install --frozen-lockfile

dev: ## Start development server with hot-reload
	bun run dev

serve: ## Start production server
	bun run serve.ts

build: ## Build library bundle
	bun run build

typecheck: ## Run TypeScript type checking
	bun run typecheck

lint: ## Run ESLint
	bun run lint

lint-fix: ## Run ESLint with auto-fix
	bun run lint:fix

format: ## Format code with Prettier
	bun run format

format-check: ## Check code formatting
	bun run format:check

test: ## Run all tests
	bun run test

test-unit: ## Run unit tests only
	bun run test:unit

test-coverage: ## Run tests with coverage report
	bun run test:coverage

test-watch: ## Run tests in watch mode
	bun run test:watch

test-groq: ## Run Groq integration tests
	bun run test:groq

test-openai: ## Run OpenAI integration tests
	bun run test:openai

test-fallback: ## Run fallback integration tests
	bun run test:fallback

test-auth: ## Run auth integration tests
	bun run test:auth

test-load: ## Run load tests
	bun run test:load

test-soak: ## Run soak tests
	bun run test:soak

check: typecheck lint format-check ## Run all checks (typecheck, lint, format)

clean: ## Clean build artifacts
	rm -rf dist/
	rm -rf coverage/
	rm -rf .turbo/
	rm -f *.tsbuildinfo

docker-up: ## Start local development environment
	docker compose -f docker-compose.dev.yml up -d

docker-down: ## Stop local development environment
	docker compose -f docker-compose.dev.yml down

docker-logs: ## View local environment logs
	docker compose -f docker-compose.dev.yml logs -f

docker-build: ## Build production Docker image
	docker build -t ai-gateway:latest -f Dockerfile.production .

docker-scan: ## Scan Docker image for vulnerabilities
	docker build -t ai-gateway:scan -f Dockerfile.production .
	trivy image ai-gateway:scan

release: ## Create a new release (requires changeset)
	bunx changeset
	bunx changeset version

deploy: ## Deploy to Fly.io
	fly deploy

deploy-staging: ## Deploy to staging
	fly deploy --app ai-gateway-staging

deploy-prod: ## Deploy to production
	fly deploy --app ai-gateway-production

health: ## Check gateway health
	curl -s http://localhost:4000/health | jq .

status: ## View gateway status
	curl -s http://localhost:4000/status | jq .

metrics: ## View Prometheus metrics
	curl -s http://localhost:4000/metrics

gpu-status: ## Check GPU status
	bunx ai-gateway gpu status

gpu-offers: ## Check GPU offers
	bunx ai-gateway gpu offers

logs: ## View gateway logs
	fly logs --app ai-gateway

profile: ## Start server with profiling enabled
	PROFILE=1 bun run serve.ts

# CI targets
ci: check test-unit build ## Run CI checks locally
ci-all: check test build ## Run full CI suite locally
