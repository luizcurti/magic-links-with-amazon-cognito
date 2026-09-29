output "api_url" {
  description = "Base URL of the API on LocalStack."
  value       = "${var.localstack_endpoint}/restapis/${aws_api_gateway_rest_api.main.id}/${var.stage_name}/_user_request_"
}

output "api_id" {
  value = aws_api_gateway_rest_api.main.id
}

output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "magic_links_table" {
  value = aws_dynamodb_table.magic_links.name
}

output "kms_key_arn" {
  value = aws_kms_key.magic_links.arn
}

output "ses_from_address" {
  value = aws_ses_email_identity.sender.email
}
