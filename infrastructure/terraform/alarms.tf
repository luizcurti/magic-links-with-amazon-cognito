# Every alarm notifies one SNS topic; alarm_email subscribes to it.

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]

  lambda_functions = {
    login                   = aws_lambda_function.login
    "send-magic-link"       = aws_lambda_function.send_magic_link
    "auth-callback"         = aws_lambda_function.auth_callback
    me                      = aws_lambda_function.me
    logout                  = aws_lambda_function.logout
    refresh                 = aws_lambda_function.refresh
    "define-auth-challenge" = aws_lambda_function.define_auth_challenge
    "create-auth-challenge" = aws_lambda_function.create_auth_challenge
    "verify-auth-challenge" = aws_lambda_function.verify_auth_challenge
  }

  api_dimensions = {
    ApiName = aws_api_gateway_rest_api.main.name
    Stage   = aws_api_gateway_stage.main.stage_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.lambda_functions

  alarm_name          = "${each.value.function_name}-errors"
  alarm_description   = "${each.key} threw an unhandled error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = local.lambda_functions

  alarm_name          = "${each.value.function_name}-throttles"
  alarm_description   = "${each.key} was throttled: the account's concurrency limit was reached."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = each.value.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  for_each = local.lambda_functions

  alarm_name          = "${each.value.function_name}-duration"
  alarm_description   = "${each.key} p99 duration is above 80% of its ${each.value.timeout}s timeout."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = each.value.function_name }
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = each.value.timeout * 1000 * 0.8
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "The API answered 5xx."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5XXError"
  dimensions          = local.api_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# 4xx are normal traffic: alarm on a sustained share, not single errors.
resource "aws_cloudwatch_metric_alarm" "api_4xx" {
  alarm_name          = "${local.name}-api-4xx-rate"
  alarm_description   = "More than ${var.api_4xx_rate_threshold * 100}% of API requests answered 4xx for 15 minutes."
  namespace           = "AWS/ApiGateway"
  metric_name         = "4XXError"
  dimensions          = local.api_dimensions
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.api_4xx_rate_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Someone asked for a link and never got it.
resource "aws_cloudwatch_metric_alarm" "login_dlq" {
  alarm_name          = "${local.name}-login-requests-dlq"
  alarm_description   = "Sign-in emails could not be sent and were parked in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.login_requests_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
