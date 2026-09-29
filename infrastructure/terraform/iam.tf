data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  # One role per function, each with only the permissions it needs.
  lambda_roles = toset([
    "login",
    "auth-callback",
    "me",
    "define-auth-challenge",
    "create-auth-challenge",
    "verify-auth-challenge",
  ])
}

resource "aws_iam_role" "lambda" {
  for_each = local.lambda_roles

  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  for_each = local.lambda_roles

  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_xray" {
  for_each = local.lambda_roles

  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Access to the customer-managed key, only when called through DynamoDB.
data "aws_iam_policy_document" "table_kms" {
  statement {
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = [aws_kms_key.magic_links.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.region}.amazonaws.com"]
    }
  }
}

# login: create the Cognito user, store the token hash, send the email.
data "aws_iam_policy_document" "login" {
  source_policy_documents = [data.aws_iam_policy_document.table_kms.json]

  statement {
    actions   = ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword"]
    resources = [aws_cognito_user_pool.main.arn]
  }

  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.magic_links.arn]
  }

  statement {
    actions   = ["ses:SendEmail"]
    resources = [aws_ses_email_identity.sender.arn]
  }
}

resource "aws_iam_role_policy" "login" {
  name   = "login"
  role   = aws_iam_role.lambda["login"].id
  policy = data.aws_iam_policy_document.login.json
}

# verify-auth-challenge: read the link and atomically mark it as used.
data "aws_iam_policy_document" "verify_auth_challenge" {
  source_policy_documents = [data.aws_iam_policy_document.table_kms.json]

  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.magic_links.arn]
  }
}

resource "aws_iam_role_policy" "verify_auth_challenge" {
  name   = "verify-auth-challenge"
  role   = aws_iam_role.lambda["verify-auth-challenge"].id
  policy = data.aws_iam_policy_document.verify_auth_challenge.json
}

# auth-callback only calls InitiateAuth / RespondToAuthChallenge, which are
# public (unauthenticated) Cognito APIs, so it needs no extra permissions.
# define/create-auth-challenge and me are pure functions: logs only.
