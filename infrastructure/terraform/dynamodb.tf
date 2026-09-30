resource "aws_dynamodb_table" "magic_links" {
  name         = "${local.name}-tokens"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # Items are purged automatically a day after they were written: long enough
  # to keep the growing cooldown's streak, which must outlive the 10-minute
  # link. TTL deletion is lazy anyway, so expiry is always checked against
  # expiresAt.
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
