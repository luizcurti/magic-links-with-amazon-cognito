# Per-IP limits in front of the API. The per-email cooldown stops one inbox
# from being flooded; these rules stop one client from mailing many inboxes.
resource "aws_wafv2_web_acl" "api" {
  name        = "${local.name}-api"
  description = "Rate limits and AWS managed protections for the magic-link API"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  custom_response_body {
    key          = "too-many-requests"
    content_type = "APPLICATION_JSON"
    content      = jsonencode({ message = "Too many requests, please try again later" })
  }

  rule {
    name     = "login-rate-limit-per-ip"
    priority = 0

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "too-many-requests"

          response_header {
            name  = "Retry-After"
            value = tostring(var.waf_rate_window_seconds)
          }

          # Without it, the browser hides the 429 from the frontend as a network error.
          response_header {
            name  = "Access-Control-Allow-Origin"
            value = var.frontend_origin
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_login_rate_limit
        evaluation_window_sec = var.waf_rate_window_seconds
        aggregate_key_type    = "IP"

        # API Gateway routes /login/, //login and percent-encoded spellings to the
        # same Lambda, so the path is decoded and normalised before matching, and
        # a trailing slash is allowed. A plain ENDS_WITH "/login" missed them.
        scope_down_statement {
          regex_match_statement {
            regex_string = "/login/*$"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }

            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH"
            }

            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-login-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "api-rate-limit-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "too-many-requests"

          response_header {
            name  = "Retry-After"
            value = tostring(var.waf_rate_window_seconds)
          }

          # Without it, the browser hides the 429 from the frontend as a network error.
          response_header {
            name  = "Access-Control-Allow-Origin"
            value = var.frontend_origin
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_api_rate_limit
        evaluation_window_sec = var.waf_rate_window_seconds
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-api-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-common-rule-set"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_api_gateway_stage.main.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}

# WAF only accepts log groups whose name starts with "aws-waf-logs-".
resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "api" {
  resource_arn            = aws_wafv2_web_acl.api.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # ID tokens travel in this header; keep them out of the logs.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
}
