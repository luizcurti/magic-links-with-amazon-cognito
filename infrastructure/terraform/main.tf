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

# Every AWS API is redirected to LocalStack. To deploy to real AWS instead,
# remove the dummy credentials, the skip_* flags and the endpoints block.
provider "aws" {
  region     = var.region
  access_key = "test"
  secret_key = "test"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    apigateway = var.localstack_endpoint
    cognitoidp = var.localstack_endpoint
    dynamodb   = var.localstack_endpoint
    iam        = var.localstack_endpoint
    kms        = var.localstack_endpoint
    lambda     = var.localstack_endpoint
    logs       = var.localstack_endpoint
    ses        = var.localstack_endpoint
    sts        = var.localstack_endpoint
  }

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

locals {
  name = var.project_name
}
