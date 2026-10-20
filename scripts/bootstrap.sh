#!/usr/bin/env bash
# One-time setup for the CI/CD deploy job, in one command:
#   1. applies bootstrap/ (Terraform state bucket + GitHub OIDC deploy role) with YOUR AWS
#      credentials (admin), and
#   2. creates the `production` GitHub environment and writes AWS_DEPLOY_ROLE_ARN,
#      TF_STATE_BUCKET and AWS_REGION into it from the bootstrap outputs, plus SES_FROM_ADDRESS
#      (the sender of the magic-link emails: asked for, or taken from the env variable).
#
# Requirements: terraform >= 1.10, the AWS CLI credentials of the target account, and the
# GitHub CLI logged in with admin access to this repository (`gh auth login`).
#
# Usage:
#   scripts/bootstrap.sh                              # region eu-west-2, reuse the OIDC provider
#   scripts/bootstrap.sh -var="aws_region=eu-west-1"  # extra args go to `terraform apply`
#   scripts/bootstrap.sh -var="create_oidc_provider=true"   # account without the GitHub OIDC provider
#   SES_FROM_ADDRESS=you@example.com scripts/bootstrap.sh   # skip the prompt
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bootstrap_dir="$root_dir/bootstrap"

for cmd in terraform aws gh; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is not installed" >&2; exit 1; }
done

cd "$root_dir"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
repo_id="$(gh api "repos/$repo" --jq .id)"
owner_id="$(gh api "repos/$repo" --jq .owner.id)"
environment="production"

if [ -z "${SES_FROM_ADDRESS:-}" ]; then
  echo "Sender address of the magic-link emails. AWS emails it a verification link on the first"
  echo "deploy; while the account is in the SES sandbox it can also only send TO verified"
  echo "addresses, so use your own email to test the flow end to end."
  read -rp "SES_FROM_ADDRESS: " SES_FROM_ADDRESS
fi
[[ "$SES_FROM_ADDRESS" == *@*.* ]] || { echo "error: '$SES_FROM_ADDRESS' is not an email address" >&2; exit 1; }

echo "AWS account: $(aws sts get-caller-identity --query Account --output text)"
echo "GitHub repo: $repo (environment: $environment)"
echo

terraform -chdir="$bootstrap_dir" init -input=false
terraform -chdir="$bootstrap_dir" apply \
  -var="github_repository=$repo" \
  -var="github_repository_id=$repo_id" \
  -var="github_owner_id=$owner_id" \
  "$@"

echo
echo "Configuring the '$environment' environment on GitHub..."
gh api --method PUT "repos/$repo/environments/$environment" >/dev/null

for name in AWS_DEPLOY_ROLE_ARN TF_STATE_BUCKET AWS_REGION; do
  value="$(terraform -chdir="$bootstrap_dir" output -raw "$name")"
  gh variable set "$name" --env "$environment" --repo "$repo" --body "$value"
  echo "  $name=$value"
done
gh variable set SES_FROM_ADDRESS --env "$environment" --repo "$repo" --body "$SES_FROM_ADDRESS"
echo "  SES_FROM_ADDRESS=$SES_FROM_ADDRESS"

echo
echo "Done. Deploy with: gh workflow run ci.yml --repo $repo --ref main"
