locals {
  common_env = {
    NODE_OPTIONS = "--enable-source-maps"
  }

  api_env = merge(local.common_env, {
    CORS_ALLOWED_ORIGIN = var.frontend_origin
  })
}

# Managed log groups, so retention applies.
resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.lambda_roles

  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

data "archive_file" "lambda" {
  for_each = local.lambda_roles

  type        = "zip"
  source_dir  = "${path.module}/${var.lambda_dist_dir}/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

# ---------------------------------------------------------------------------
# Cognito triggers
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "define_auth_challenge" {
  function_name    = "${local.name}-define-auth-challenge"
  role             = aws_iam_role.lambda["define-auth-challenge"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["define-auth-challenge"].output_path
  source_code_hash = data.archive_file.lambda["define-auth-challenge"].output_base64sha256
  timeout          = 5
  memory_size      = 128

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = local.common_env
  }
}

resource "aws_lambda_function" "create_auth_challenge" {
  function_name    = "${local.name}-create-auth-challenge"
  role             = aws_iam_role.lambda["create-auth-challenge"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["create-auth-challenge"].output_path
  source_code_hash = data.archive_file.lambda["create-auth-challenge"].output_base64sha256
  timeout          = 5
  memory_size      = 128

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = local.common_env
  }
}

resource "aws_lambda_function" "verify_auth_challenge" {
  function_name    = "${local.name}-verify-auth-challenge"
  role             = aws_iam_role.lambda["verify-auth-challenge"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["verify-auth-challenge"].output_path
  source_code_hash = data.archive_file.lambda["verify-auth-challenge"].output_base64sha256
  timeout          = 5
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.common_env, {
      MAGIC_LINKS_TABLE = aws_dynamodb_table.magic_links.name
    })
  }
}

# ---------------------------------------------------------------------------
# API Gateway handlers
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "login" {
  function_name    = "${local.name}-login"
  role             = aws_iam_role.lambda["login"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["login"].output_path
  source_code_hash = data.archive_file.lambda["login"].output_base64sha256
  timeout          = 10
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.api_env, {
      LOGIN_QUEUE_URL = aws_sqs_queue.login_requests.url
    })
  }
}

resource "aws_lambda_function" "send_magic_link" {
  function_name    = "${local.name}-send-magic-link"
  role             = aws_iam_role.lambda["send-magic-link"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["send-magic-link"].output_path
  source_code_hash = data.archive_file.lambda["send-magic-link"].output_base64sha256
  timeout          = 10
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.common_env, {
      MAGIC_LINKS_TABLE               = aws_dynamodb_table.magic_links.name
      SES_FROM_ADDRESS                = aws_ses_email_identity.sender.email
      MAGIC_LINK_CALLBACK_URL         = var.magic_link_callback_url
      MAGIC_LINK_TTL_SECONDS          = tostring(var.magic_link_ttl_seconds)
      MAGIC_LINK_COOLDOWN_SECONDS     = tostring(var.magic_link_cooldown_seconds)
      MAGIC_LINK_MAX_COOLDOWN_SECONDS = tostring(var.magic_link_max_cooldown_seconds)
    })
  }
}

resource "aws_lambda_function" "auth_callback" {
  function_name    = "${local.name}-auth-callback"
  role             = aws_iam_role.lambda["auth-callback"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["auth-callback"].output_path
  source_code_hash = data.archive_file.lambda["auth-callback"].output_base64sha256
  timeout          = 15
  memory_size      = 256

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.api_env, {
      USER_POOL_ID        = aws_cognito_user_pool.main.id
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.web.id
      MAGIC_LINKS_TABLE   = aws_dynamodb_table.magic_links.name
    })
  }
}

resource "aws_lambda_function" "me" {
  function_name    = "${local.name}-me"
  role             = aws_iam_role.lambda["me"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["me"].output_path
  source_code_hash = data.archive_file.lambda["me"].output_base64sha256
  timeout          = 5
  memory_size      = 128

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.api_env, {
      ID_TOKEN_ISSUER     = local.cognito_issuer
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.web.id
    })
  }
}

resource "aws_lambda_function" "logout" {
  function_name    = "${local.name}-logout"
  role             = aws_iam_role.lambda["logout"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["logout"].output_path
  source_code_hash = data.archive_file.lambda["logout"].output_base64sha256
  timeout          = 10
  memory_size      = 128

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.api_env, {
      USER_POOL_ID        = aws_cognito_user_pool.main.id
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.web.id
    })
  }
}

resource "aws_lambda_function" "refresh" {
  function_name    = "${local.name}-refresh"
  role             = aws_iam_role.lambda["refresh"].arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = data.archive_file.lambda["refresh"].output_path
  source_code_hash = data.archive_file.lambda["refresh"].output_base64sha256
  timeout          = 10
  memory_size      = 128

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.lambda]

  environment {
    variables = merge(local.api_env, {
      USER_POOL_ID        = aws_cognito_user_pool.main.id
      USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.web.id
    })
  }
}
