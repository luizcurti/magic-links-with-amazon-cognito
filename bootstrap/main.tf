# One-time, account-level setup for the CI/CD deploy job (see "Real AWS via GitHub Actions" in
# docs/deployment.md). Applied manually, once, with your own admin credentials:
#
#   cd bootstrap && terraform init && terraform apply
#
# It creates what the pipeline needs *before* it can run, so it can't be created by the
# pipeline itself:
#   - an S3 bucket holding the main stack's remote state (native S3 locking, no DynamoDB table)
#   - the GitHub Actions OIDC identity provider (optional, an account can only have one)
#   - an IAM role the deploy job assumes via OIDC, so no long-lived AWS keys live in GitHub
#
# This directory keeps its own local state (bootstrap/terraform.tfstate, gitignored): it is a
# handful of resources that rarely change, and it can't store its state in the bucket it creates.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "${var.project_name}-tfstate-${local.account_id}"
  oidc_host    = "token.actions.githubusercontent.com"

  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${local.account_id}:oidc-provider/${local.oidc_host}"

  github_owner = split("/", var.github_repository)[0]
  github_repo  = split("/", var.github_repository)[1]

  github_oidc_subjects = [
    "repo:${var.github_repository}:environment:${var.github_environment}",
    "repo:${local.github_owner}@${var.github_owner_id}/${local.github_repo}@${var.github_repository_id}:environment:${var.github_environment}",
  ]

  common_tags = {
    Project = var.project_name
  }
}

# --- Remote state bucket ---------------------------------------------------------------

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket
  tags   = local.common_tags
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# --- GitHub OIDC -----------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]

  tags = local.common_tags
}

# Only the deploy job, running in the repo's `production` GitHub environment, can assume this
# role. Pull requests, forks and other branches get a different `sub` claim and are refused.
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # GitHub may send the subject in either format: the classic name-based one, or the
    # immutable one that embeds owner/repo IDs (survives renames and blocks repo-name reuse).
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = local.github_oidc_subjects
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${var.project_name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600

  tags = local.common_tags
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${var.project_name}-github-deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.deploy_permissions.json
}
