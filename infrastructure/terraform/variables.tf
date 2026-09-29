variable "project_name" {
  description = "Prefix used to name every resource."
  type        = string
  default     = "magic-links"
}

variable "region" {
  description = "AWS region emulated by LocalStack."
  type        = string
  default     = "us-east-1"
}

variable "localstack_endpoint" {
  description = "LocalStack edge endpoint used for every AWS service."
  type        = string
  default     = "http://localhost:4566"
}

variable "stage_name" {
  description = "API Gateway stage name."
  type        = string
  default     = "local"
}

variable "ses_from_address" {
  description = "Sender address for magic-link emails (verified in SES)."
  type        = string
  default     = "no-reply@magic-links.local"
}

variable "magic_link_callback_url" {
  description = "Frontend route the magic link points to."
  type        = string
  default     = "http://localhost:5173/auth/callback"
}

variable "frontend_origin" {
  description = "Origin allowed by CORS."
  type        = string
  default     = "http://localhost:5173"
}

variable "magic_link_ttl_seconds" {
  description = "How long a magic link stays valid."
  type        = number
  default     = 600

  validation {
    condition     = var.magic_link_ttl_seconds >= 60 && var.magic_link_ttl_seconds <= 3600
    error_message = "magic_link_ttl_seconds must be between 60 and 3600."
  }
}

variable "lambda_runtime" {
  description = "Node.js runtime for every Lambda."
  type        = string
  default     = "nodejs22.x"
}

variable "lambda_dist_dir" {
  description = "Folder with the esbuild output (npm run build)."
  type        = string
  default     = "../../dist"
}

variable "log_retention_days" {
  description = "Retention for Lambda and API Gateway access logs."
  type        = number
  default     = 14
}

variable "api_throttle_rate_limit" {
  description = "Steady-state requests per second allowed across the API stage."
  type        = number
  default     = 10
}

variable "api_throttle_burst_limit" {
  description = "Maximum concurrent request burst allowed across the API stage."
  type        = number
  default     = 20
}

variable "magic_link_cooldown_seconds" {
  description = "Minimum time between two magic links for the same email (email-bombing protection)."
  type        = number
  default     = 60

  validation {
    condition     = var.magic_link_cooldown_seconds >= 1 && var.magic_link_cooldown_seconds <= 3600
    error_message = "magic_link_cooldown_seconds must be between 1 and 3600."
  }
}
