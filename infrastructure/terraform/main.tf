terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

# target = "localstack" (default) redirects every AWS API to LocalStack with
# dummy credentials. target = "aws" uses the default credential chain and the
# real endpoints; keep its state apart (`make aws-infra` uses the "aws"
# workspace) so it never mixes with the disposable LocalStack state.
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
      cognitoidp = endpoints.value
      dynamodb   = endpoints.value
      iam        = endpoints.value
      kms        = endpoints.value
      lambda     = endpoints.value
      logs       = endpoints.value
      ses        = endpoints.value
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

  # The `iss` claim of the pool's tokens; its JWKS is at <issuer>/.well-known/jwks.json.
  cognito_issuer = (local.localstack
    ? "${var.localstack_cognito_issuer_base}/${aws_cognito_user_pool.main.id}"
    : "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  )
}
