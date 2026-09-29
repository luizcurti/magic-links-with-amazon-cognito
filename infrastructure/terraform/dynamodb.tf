resource "aws_dynamodb_table" "magic_links" {
  name         = "${local.name}-tokens"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # Expired links are purged automatically. TTL deletion is lazy, so the
  # application still checks expiresAt on every verification.
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.magic_links.arn
  }

  point_in_time_recovery {
    enabled = true
  }
}
