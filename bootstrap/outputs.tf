# Copy these into the repo's `production` GitHub environment (Settings → Environments).

output "AWS_DEPLOY_ROLE_ARN" {
  description = "GitHub environment variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}

output "TF_STATE_BUCKET" {
  description = "GitHub environment variable TF_STATE_BUCKET."
  value       = aws_s3_bucket.tfstate.bucket
}

output "AWS_REGION" {
  description = "GitHub environment variable AWS_REGION."
  value       = var.aws_region
}
