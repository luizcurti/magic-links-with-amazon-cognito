resource "aws_cognito_user_pool" "main" {
  name = "${local.name}-users"

  # Users sign in with their email; there are no passwords to manage.
  username_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 5
      max_length = 254
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  lambda_config {
    define_auth_challenge          = aws_lambda_function.define_auth_challenge.arn
    create_auth_challenge          = aws_lambda_function.create_auth_challenge.arn
    verify_auth_challenge_response = aws_lambda_function.verify_auth_challenge.arn
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # Public client (browser / API Lambda): no secret, only custom auth.
  generate_secret = false
  explicit_auth_flows = [
    "ALLOW_CUSTOM_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Do not reveal whether an account exists.
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_lambda_permission" "cognito_triggers" {
  for_each = {
    define = aws_lambda_function.define_auth_challenge.function_name
    create = aws_lambda_function.create_auth_challenge.function_name
    verify = aws_lambda_function.verify_auth_challenge.function_name
  }

  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
