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
  # One least-privilege role per function.
  lambda_roles = toset([
    "login",
    "send-magic-link",
    "auth-callback",
    "me",
    "logout",
    "refresh",
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

# The table's key, only through DynamoDB.
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

# login: queue the request.
data "aws_iam_policy_document" "login" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.login_requests.arn]
  }
}

resource "aws_iam_role_policy" "login" {
  name   = "login"
  role   = aws_iam_role.lambda["login"].id
  policy = data.aws_iam_policy_document.login.json
}

# send-magic-link: consume the queue, read/write the link, send the email.
data "aws_iam_policy_document" "send_magic_link" {
  source_policy_documents = [data.aws_iam_policy_document.table_kms.json]

  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.login_requests.arn]
  }

  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.magic_links.arn]
  }

  statement {
    actions   = ["ses:SendEmail"]
    resources = [aws_ses_email_identity.sender.arn]
  }
}

resource "aws_iam_role_policy" "send_magic_link" {
  name   = "send-magic-link"
  role   = aws_iam_role.lambda["send-magic-link"].id
  policy = data.aws_iam_policy_document.send_magic_link.json
}

# auth-callback: read the link, create or repair the user. The auth calls are public APIs.
data "aws_iam_policy_document" "auth_callback" {
  source_policy_documents = [data.aws_iam_policy_document.table_kms.json]

  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.magic_links.arn]
  }

  statement {
    actions   = ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminSetUserPassword"]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

resource "aws_iam_role_policy" "auth_callback" {
  name   = "auth-callback"
  role   = aws_iam_role.lambda["auth-callback"].id
  policy = data.aws_iam_policy_document.auth_callback.json
}

# verify-auth-challenge: read the link and mark it used.
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

# refresh and logout call public Cognito APIs; define/create-auth-challenge and
# me call no AWS API: logs and X-Ray only.
