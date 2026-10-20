# Least-privilege-ish permissions for the deploy role: everything the stack in
# ../infrastructure/terraform needs to create, update and destroy, plus what the post-deploy
# smoke tests (tests/aws) call. Scoped by the `${var.project_name}` name prefix, or by the
# `Project` tag the provider puts on every resource (default_tags), wherever AWS allows it.
#
# Unavoidably broader:
#   - API Gateway REST APIs, Cognito user pools and KMS keys are addressed by generated IDs.
#     API Gateway is scoped to the region; KMS keys to the Project tag; Cognito to the region.
#   - SES identities are named after the sender address, not the project.
#   - WAFv2 managed rule groups live outside the project prefix.
#   - A handful of Describe/List calls only accept "*".

locals {
  p      = var.project_name
  region = var.aws_region
  acct   = local.account_id

  # The only AWS-managed policies the stack attaches. Restricting attachments to these stops
  # the deploy role from attaching e.g. AdministratorAccess to a role it creates.
  attachable_managed_policies = [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
    "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs",
  ]
}

data "aws_iam_policy_document" "deploy_permissions" {
  statement {
    sid       = "StateBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tfstate.arn]
  }

  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/*"]
  }

  statement {
    sid       = "LambdaFunctions"
    actions   = ["lambda:*"]
    resources = ["arn:aws:lambda:${local.region}:${local.acct}:function:${local.p}-*"]
  }

  statement {
    sid = "LambdaEventSourceMappings"
    actions = [
      "lambda:CreateEventSourceMapping",
      "lambda:GetEventSourceMapping",
      "lambda:UpdateEventSourceMapping",
      "lambda:DeleteEventSourceMapping",
      "lambda:ListEventSourceMappings",
      "lambda:TagResource",
      "lambda:ListTags",
    ]
    resources = ["*"]
  }

  statement {
    sid = "IamProjectRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${local.acct}:role/${local.p}-*"]
  }

  statement {
    sid       = "IamAttachStackManagedPoliciesOnly"
    actions   = ["iam:AttachRolePolicy", "iam:DetachRolePolicy"]
    resources = ["arn:aws:iam::${local.acct}:role/${local.p}-*"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = local.attachable_managed_policies
    }
  }

  statement {
    sid       = "IamPassProjectRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.acct}:role/${local.p}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com", "apigateway.amazonaws.com"]
    }
  }

  statement {
    sid = "ApiGateway"
    actions = [
      "apigateway:GET",
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:PATCH",
      "apigateway:DELETE",
      "apigateway:SetWebACL", # wafv2:AssociateWebACL / DisassociateWebACL on a REST API stage
    ]
    resources = ["arn:aws:apigateway:${local.region}::/*"]
  }

  statement {
    sid       = "Waf"
    actions   = ["wafv2:*"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  statement {
    sid       = "Cognito"
    actions   = ["cognito-idp:*"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  # The sender identity (var.ses_from_address of the stack), plus the verification status the
  # deploy job reports.
  statement {
    sid = "SesIdentity"
    actions = [
      "ses:VerifyEmailIdentity",
      "ses:DeleteIdentity",
      "ses:GetIdentityVerificationAttributes",
      "ses:ListIdentities",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [local.region]
    }
  }

  statement {
    sid     = "DynamoDb"
    actions = ["dynamodb:*"]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.acct}:table/${local.p}-*",
      "arn:aws:dynamodb:${local.region}:${local.acct}:table/${local.p}-*/index/*",
    ]
  }

  statement {
    sid       = "Sqs"
    actions   = ["sqs:*"]
    resources = ["arn:aws:sqs:${local.region}:${local.acct}:${local.p}-*"]
  }

  statement {
    sid       = "Sns"
    actions   = ["sns:*"]
    resources = ["arn:aws:sns:${local.region}:${local.acct}:${local.p}-*"]
  }

  # The table's customer-managed key. Keys have generated IDs, so access is scoped by the
  # Project tag the provider adds on creation (default_tags).
  statement {
    sid       = "KmsCreateTaggedKey"
    actions   = ["kms:CreateKey", "kms:TagResource"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [local.p]
    }
  }

  statement {
    sid = "KmsProjectKeys"
    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:EnableKeyRotation",
      "kms:ListResourceTags",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CreateGrant",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:UpdateAlias",
      # DynamoDB items are encrypted with this key: the smoke tests write and delete items.
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["arn:aws:kms:${local.region}:${local.acct}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [local.p]
    }
  }

  statement {
    sid       = "KmsProjectAlias"
    actions   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
    resources = ["arn:aws:kms:${local.region}:${local.acct}:alias/${local.p}*"]
  }

  statement {
    sid     = "LogGroups"
    actions = ["logs:*"]
    resources = [
      "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/lambda/${local.p}-*",
      "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/apigateway/${local.p}-*",
      "arn:aws:logs:${local.region}:${local.acct}:log-group:aws-waf-logs-${local.p}*",
    ]
  }

  statement {
    sid       = "Alarms"
    actions   = ["cloudwatch:*"]
    resources = ["arn:aws:cloudwatch:${local.region}:${local.acct}:alarm:${local.p}-*"]
  }

  statement {
    sid = "AccountWideReadsAndLogDelivery"
    actions = [
      "sts:GetCallerIdentity",
      "cloudwatch:DescribeAlarms",
      "logs:DescribeLogGroups",
      "logs:DescribeResourcePolicies",
      "logs:PutResourcePolicy",
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "lambda:GetAccountSettings",
      "kms:ListAliases",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = ["*"]
  }

  # The deploy role matches the `${var.project_name}-*` prefix itself; never let it rewrite its
  # own trust or permissions.
  statement {
    sid    = "DenySelfModification"
    effect = "Deny"
    actions = [
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = [aws_iam_role.github_deploy.arn]
  }
}
