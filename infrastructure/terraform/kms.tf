# Encrypts the table (emails and token hashes): auditable, revocable, rotated.
resource "aws_kms_key" "magic_links" {
  description             = "Encrypts the ${local.name} DynamoDB table"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "magic_links" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.magic_links.key_id
}
