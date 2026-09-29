SHELL := /bin/bash
TF    := terraform -chdir=infrastructure/terraform
EMAIL ?= luiz@example.com

.DEFAULT_GOAL := help
.PHONY: help install up down logs build infra destroy outputs env login emails link verify demo frontend test test-integration typecheck check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install npm dependencies
	npm install

up: ## Start LocalStack and wait until it is healthy
	@test -f .env || (echo "Missing .env - run: cp .env.example .env and set LOCALSTACK_AUTH_TOKEN" && exit 1)
	docker compose up -d --wait
	@echo "LocalStack is ready at http://localhost:4566"

down: ## Stop LocalStack and delete its data
	docker compose down -v
	rm -f infrastructure/terraform/terraform.tfstate*

logs: ## Tail LocalStack logs
	docker compose logs -f localstack

build: ## Bundle the Lambdas with esbuild
	npm run build

infra: build ## Build the Lambdas and apply Terraform against LocalStack
	$(TF) init -input=false -upgrade=false
	$(TF) apply -input=false -auto-approve
	@$(MAKE) --no-print-directory env

destroy: ## Destroy the Terraform-managed resources
	$(TF) destroy -input=false -auto-approve

outputs: ## Show Terraform outputs
	$(TF) output

env: ## Write the API URL for the frontend (apps/frontend/.env.local)
	@echo "VITE_API_PROXY_TARGET=$$($(TF) output -raw api_url)" > apps/frontend/.env.local
	@echo "Wrote apps/frontend/.env.local"

login: ## Request a magic link: make login EMAIL=you@example.com
	@curl -s -X POST "$$($(TF) output -raw api_url)/login" \
		-H 'Content-Type: application/json' \
		-d '{"email":"$(EMAIL)"}' | jq .

emails: ## Show emails captured by LocalStack SES
	@node scripts/emails.mjs

link: ## Print the latest magic link for EMAIL
	@node scripts/emails.mjs --link --to "$(EMAIL)"

verify: ## Exchange the latest magic link for JWTs
	@LINK=$$(node scripts/emails.mjs --link --to "$(EMAIL)") && \
	TOKEN=$$(echo "$$LINK" | sed -E 's/.*token=([0-9a-f]+).*/\1/') && \
	curl -s -X POST "$$($(TF) output -raw api_url)/auth/verify" \
		-H 'Content-Type: application/json' \
		-d "{\"email\":\"$(EMAIL)\",\"token\":\"$$TOKEN\"}" | jq .

demo: ## Full flow from the terminal: login -> email -> JWT -> /me
	@./scripts/demo.sh "$(EMAIL)"

frontend: ## Start the React frontend on http://localhost:5173
	npm run dev:frontend

test: ## Run unit tests
	npm test

test-integration: ## Run integration tests against LocalStack
	npm run test:integration

typecheck: ## Type-check backend and frontend
	npm run typecheck

check: typecheck test ## Typecheck, unit tests and Terraform validation
	$(TF) fmt -check -recursive
	$(TF) validate

clean: ## Remove build artifacts
	rm -rf dist coverage apps/frontend/dist infrastructure/terraform/.build
