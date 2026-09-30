SHELL := /bin/bash
TF    := terraform -chdir=infrastructure/terraform
EMAIL ?= luiz@example.com

.DEFAULT_GOAL := help
.PHONY: help install up down logs build infra destroy outputs env login emails link verify demo frontend test test-integration test-api test-e2e lint typecheck tf-scan check clean aws-infra aws-destroy test-aws

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

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

test: ## Run unit tests (backend + frontend)
	npm test

test-integration: ## Run integration tests against LocalStack
	npm run test:integration

test-api: ## Run the Postman collection against LocalStack (newman)
	npm run test:api

test-e2e: ## Run browser E2E tests (Playwright) against LocalStack
	npm run test:e2e

lint: ## Lint and format-check with Biome
	npm run lint

typecheck: ## Type-check backend and frontend
	npm run typecheck

tf-scan: ## Static analysis for Terraform (needs tflint and checkov installed)
	cd infrastructure/terraform && tflint --init >/dev/null && tflint --format compact
	checkov -d infrastructure/terraform --config-file infrastructure/terraform/.checkov.yaml

check: lint typecheck test ## Lint, typecheck, unit tests and Terraform validation
	$(TF) fmt -check -recursive
	$(TF) validate

aws-infra: build ## Deploy to a REAL AWS account (Terraform workspace "aws"; costs money, see README)
	$(TF) init -input=false -upgrade=false
	@$(TF) workspace new aws >/dev/null 2>&1 && $(TF) workspace select default >/dev/null || true
	TF_WORKSPACE=aws $(TF) apply -input=false -var target=aws $(AWS_TF_VARS)

aws-destroy: ## Destroy the real AWS deployment
	TF_WORKSPACE=aws $(TF) destroy -input=false -var target=aws $(AWS_TF_VARS)

test-aws: ## Smoke-test what LocalStack does not enforce, against the real AWS deployment
	npm run test:aws

clean: ## Remove build artifacts
	rm -rf dist coverage apps/frontend/dist infrastructure/terraform/.build test-results playwright-report
