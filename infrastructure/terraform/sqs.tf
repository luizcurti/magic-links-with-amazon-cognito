# Login requests for the worker; failed sends are retried, then parked in the DLQ.
resource "aws_sqs_queue" "login_requests_dlq" {
  name                      = "${local.name}-login-requests-dlq"
  message_retention_seconds = 1209600 # 14 days, to investigate
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "login_requests" {
  name = "${local.name}-login-requests"

  # At least 6x the worker's timeout, as AWS recommends.
  visibility_timeout_seconds = 6 * aws_lambda_function.send_magic_link.timeout
  # Older requests are useless: dropped, not sent late.
  message_retention_seconds = var.magic_link_ttl_seconds
  sqs_managed_sse_enabled   = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.login_requests_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_lambda_event_source_mapping" "send_magic_link" {
  event_source_arn        = aws_sqs_queue.login_requests.arn
  function_name           = aws_lambda_function.send_magic_link.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  # Keeps SES under its sending rate.
  scaling_config {
    maximum_concurrency = var.send_magic_link_max_concurrency
  }
}
