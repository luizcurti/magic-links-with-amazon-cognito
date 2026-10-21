resource "aws_dynamodb_table" "magic_links" {
  name         = "${local.name}-tokens"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # Purged a day after the write, so the cooldown streak outlives the link.
  # TTL is lazy: the code checks expiresAt.
  ttl {
    attribute_name = "purgeAt"
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
