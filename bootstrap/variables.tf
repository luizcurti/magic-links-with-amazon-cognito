variable "aws_region" {
  description = "Region the main stack is deployed to. Must match the AWS_REGION variable of the GitHub environment."
  type        = string
  default     = "eu-west-2"
}

variable "project_name" {
  description = "Must match project_name in ../infrastructure/terraform/variables.tf: the deploy role's permissions are scoped by this prefix."
  type        = string
  default     = "magic-links"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role."
  type        = string
  default     = "luizcurti/magic-links-with-amazon-cognito"
}

variable "github_owner_id" {
  description = "Numeric GitHub ID of the repository owner, used in the immutable OIDC subject format (gh api repos/OWNER/REPO --jq .owner.id)."
  type        = number
  default     = 9360461
}

variable "github_repository_id" {
  description = "Numeric GitHub ID of the repository, used in the immutable OIDC subject format (gh api repos/OWNER/REPO --jq .id)."
  type        = number
  default     = 1387390780
}

variable "github_environment" {
  description = "GitHub environment the deploy job runs in. Only that environment can assume the role."
  type        = string
  default     = "production"
}

variable "create_oidc_provider" {
  description = "Whether to create the token.actions.githubusercontent.com OIDC provider. An account can only have one, so this defaults to false: it already exists if another project's bootstrap (e.g. event-driven-notification-platform) was applied in the same account. Set true on a fresh account."
  type        = bool
  default     = false
}
