terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
  }
}

# target = "localstack": every endpoint is LocalStack, dummy credentials.
# target = "aws": default credential chain (workspace "aws", see make aws-infra).
provider "aws" {
  region     = var.region
  access_key = local.localstack ? "test" : null
  secret_key = local.localstack ? "test" : null

  skip_credentials_validation = local.localstack
  skip_metadata_api_check     = local.localstack
  skip_requesting_account_id  = local.localstack
  s3_use_path_style           = local.localstack

  dynamic "endpoints" {
    for_each = local.localstack ? [var.localstack_endpoint] : []
    content {
      apigateway = endpoints.value
      cloudwatch = endpoints.value
      cognitoidp = endpoints.value
      dynamodb   = endpoints.value
      iam        = endpoints.value
      kms        = endpoints.value
      lambda     = endpoints.value
      logs       = endpoints.value
      ses        = endpoints.value
      sns        = endpoints.value
      sqs        = endpoints.value
      sts        = endpoints.value
      wafv2      = endpoints.value
    }
  }

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

locals {
  name       = var.project_name
  localstack = var.target == "localstack"

  # `iss` of the pool's tokens; JWKS at <issuer>/.well-known/jwks.json.
  cognito_issuer = (local.localstack
    ? "${var.localstack_cognito_issuer_base}/${aws_cognito_user_pool.main.id}"
    : "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  )
}
