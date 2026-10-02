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

# /auth/refresh --------------------------------------------------------------

resource "aws_api_gateway_resource" "auth_refresh" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.auth.id
  path_part   = "refresh"
}

resource "aws_api_gateway_method" "auth_refresh_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.auth_refresh.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "auth_refresh_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.auth_refresh.id
  http_method             = aws_api_gateway_method.auth_refresh_post.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.refresh.invoke_arn
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

# /logout (public: holding the refresh token is the proof of ownership) -------

resource "aws_api_gateway_resource" "logout" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "logout"
}

resource "aws_api_gateway_method" "logout_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.logout.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "logout_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.logout.id
  http_method             = aws_api_gateway_method.logout_post.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.logout.invoke_arn
}

# Deployment -------------------------------------------------------------------

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    # Stable attributes only, so applies do not redeploy needlessly.
    redeployment = sha1(jsonencode([
      aws_api_gateway_integration.login_post.id,
      aws_api_gateway_integration.login_post.uri,
      aws_api_gateway_integration.auth_verify_post.id,
      aws_api_gateway_integration.auth_verify_post.uri,
      aws_api_gateway_integration.me_get.id,
      aws_api_gateway_integration.me_get.uri,
      aws_api_gateway_integration.logout_post.id,
      aws_api_gateway_integration.logout_post.uri,
      aws_api_gateway_integration.auth_refresh_post.id,
      aws_api_gateway_integration.auth_refresh_post.uri,
      aws_api_gateway_method.me_get.authorization,
      aws_api_gateway_authorizer.cognito.id,
      [for key, integration in aws_api_gateway_integration.cors : integration.id],
      [for key, response in aws_api_gateway_integration_response.cors : response.response_parameters],
      [for key, response in aws_api_gateway_gateway_response.cors : response.response_parameters],
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
      xrayTraceId    = "$context.xrayTraceId"
    })
  }

  depends_on = [aws_api_gateway_account.main]
}

# Stage-wide limits; per-IP limits are in waf.tf, per-email ones in the worker.
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

# A lower budget for /login: flooding it does not starve the other routes.
resource "aws_api_gateway_method_settings" "login" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = aws_api_gateway_stage.main.stage_name
  method_path = "${aws_api_gateway_resource.login.path_part}/${aws_api_gateway_method.login_post.http_method}"

  settings {
    logging_level          = "ERROR"
    metrics_enabled        = true
    throttling_rate_limit  = var.login_throttle_rate_limit
    throttling_burst_limit = var.login_throttle_burst_limit
  }
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.name}-access"
  retention_in_days = var.log_retention_days
}

# Account-level role for API Gateway logging.
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

# Each function may only be invoked by its own route.
resource "aws_lambda_permission" "api_gateway" {
  for_each = {
    login         = { function_name = aws_lambda_function.login.function_name, route = "POST/login" }
    auth_callback = { function_name = aws_lambda_function.auth_callback.function_name, route = "POST/auth/verify" }
    me            = { function_name = aws_lambda_function.me.function_name, route = "GET/me" }
    logout        = { function_name = aws_lambda_function.logout.function_name, route = "POST/logout" }
    refresh       = { function_name = aws_lambda_function.refresh.function_name, route = "POST/auth/refresh" }
  }

  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/${each.value.route}"
}

# CORS ------------------------------------------------------------------------
#
# Preflights, and CORS headers on API Gateway's own errors (the Lambdas set
# them on their responses).

locals {
  cors_routes = {
    login        = { resource_id = aws_api_gateway_resource.login.id, methods = "OPTIONS,POST" }
    auth_verify  = { resource_id = aws_api_gateway_resource.auth_verify.id, methods = "OPTIONS,POST" }
    auth_refresh = { resource_id = aws_api_gateway_resource.auth_refresh.id, methods = "OPTIONS,POST" }
    me           = { resource_id = aws_api_gateway_resource.me.id, methods = "OPTIONS,GET" }
    logout       = { resource_id = aws_api_gateway_resource.logout.id, methods = "OPTIONS,POST" }
  }

  cors_allowed_headers = "Content-Type,Authorization"
}

resource "aws_api_gateway_method" "cors" {
  for_each = local.cors_routes

  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value.resource_id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "cors" {
  for_each = local.cors_routes

  rest_api_id       = aws_api_gateway_rest_api.main.id
  resource_id       = each.value.resource_id
  http_method       = aws_api_gateway_method.cors[each.key].http_method
  type              = "MOCK"
  request_templates = { "application/json" = jsonencode({ statusCode = 200 }) }
}

resource "aws_api_gateway_method_response" "cors" {
  for_each = local.cors_routes

  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value.resource_id
  http_method = aws_api_gateway_method.cors[each.key].http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Max-Age"       = true
  }
}

resource "aws_api_gateway_integration_response" "cors" {
  for_each = local.cors_routes

  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value.resource_id
  http_method = aws_api_gateway_method.cors[each.key].http_method
  status_code = aws_api_gateway_method_response.cors[each.key].status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = "'${var.frontend_origin}'"
    "method.response.header.Access-Control-Allow-Methods" = "'${each.value.methods}'"
    "method.response.header.Access-Control-Allow-Headers" = "'${local.cors_allowed_headers}'"
    "method.response.header.Access-Control-Max-Age"       = "'600'"
  }

  depends_on = [aws_api_gateway_integration.cors]
}

resource "aws_api_gateway_gateway_response" "cors" {
  for_each = toset(["DEFAULT_4XX", "DEFAULT_5XX"])

  rest_api_id   = aws_api_gateway_rest_api.main.id
  response_type = each.key

  # API Gateway's default body, stated to avoid a diff.
  response_templates = { "application/json" = "{\"message\":$context.error.messageString}" }

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${var.frontend_origin}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'${local.cors_allowed_headers}'"
  }
}
