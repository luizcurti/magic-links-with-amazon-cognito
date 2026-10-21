# On LocalStack, sent emails are at GET http://localhost:4566/_aws/ses
resource "aws_ses_email_identity" "sender" {
  email = var.ses_from_address
}
