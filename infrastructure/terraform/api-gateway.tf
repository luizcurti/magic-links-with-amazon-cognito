resource "aws_api_gateway_rest_api" "main" {
  name        = "${local.name}-api"
  description = "Passwordless magic-link authentication API"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_authorizer" "cognito" {
  name            = "cognito"
  rest_api_id     = aws_api_gateway_rest_api.main.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [aws_cognito_user_pool.main.arn]
  identity_source = "method.request.header.Authorization"
}

# /login ---------------------------------------------------------------------

resource "aws_api_gateway_resource" "login" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "login"
}

resource "aws_api_gateway_method" "login_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.login.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "login_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.login.id
  http_method             = aws_api_gateway_method.login_post.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.login.invoke_arn
}

# /auth/verify ---------------------------------------------------------------

resource "aws_api_gateway_resource" "auth" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "auth"
}

resource "aws_api_gateway_resource" "auth_verify" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.auth.id
  path_part   = "verify"
}

resource "aws_api_gateway_method" "auth_verify_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.auth_verify.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "auth_verify_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.auth_verify.id
  http_method             = aws_api_gateway_method.auth_verify_post.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.auth_callback.invoke_arn
}

# /me (protected by the Cognito authorizer) ------------------------------------

resource "aws_api_gateway_resource" "me" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "me"
}

resource "aws_api_gateway_method" "me_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.me.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "me_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.me.id
  http_method             = aws_api_gateway_method.me_get.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.me.invoke_arn
}

# Deployment -------------------------------------------------------------------

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    # Only stable attributes: hashing whole resources picks up provider-computed
    # defaults after refresh and would redeploy the API on every apply.
    redeployment = sha1(jsonencode([
      aws_api_gateway_integration.login_post.id,
      aws_api_gateway_integration.login_post.uri,
      aws_api_gateway_integration.auth_verify_post.id,
      aws_api_gateway_integration.auth_verify_post.uri,
      aws_api_gateway_integration.me_get.id,
      aws_api_gateway_integration.me_get.uri,
      aws_api_gateway_method.me_get.authorization,
      aws_api_gateway_authorizer.cognito.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "main" {
  rest_api_id          = aws_api_gateway_rest_api.main.id
  deployment_id        = aws_api_gateway_deployment.main.id
  stage_name           = var.stage_name
  xray_tracing_enabled = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      resourcePath   = "$context.resourcePath"
      status         = "$context.status"
      responseLength = "$context.responseLength"
      latencyMs      = "$context.responseLatency"
    })
  }

  depends_on = [aws_api_gateway_account.main]
}

# Every route is public except /me, and /login sends email: throttle the
# whole stage to keep a single client from email-bombing or exhausting
# Lambda concurrency.
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = aws_api_gateway_stage.main.stage_name
  method_path = "*/*"

  settings {
    logging_level          = "ERROR"
    metrics_enabled        = true
    throttling_rate_limit  = var.api_throttle_rate_limit
    throttling_burst_limit = var.api_throttle_burst_limit
  }
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}-access"
  retention_in_days = var.log_retention_days
}

# API Gateway needs an account-level role to write access logs to CloudWatch.
data "aws_iam_policy_document" "apigateway_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apigateway_cloudwatch" {
  name               = "${local.name}-apigateway-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.apigateway_assume_role.json
}

resource "aws_iam_role_policy_attachment" "apigateway_cloudwatch" {
  role       = aws_iam_role.apigateway_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "main" {
  cloudwatch_role_arn = aws_iam_role.apigateway_cloudwatch.arn

  depends_on = [aws_iam_role_policy_attachment.apigateway_cloudwatch]
}

resource "aws_lambda_permission" "api_gateway" {
  for_each = {
    login         = aws_lambda_function.login.function_name
    auth_callback = aws_lambda_function.auth_callback.function_name
    me            = aws_lambda_function.me.function_name
  }

  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}
