output "archive_bucket" {
  description = "Value for AWS_ARCHIVE_BUCKET."
  value       = aws_s3_bucket.archive.id
}

output "archive_region" {
  description = "Value for AWS_ARCHIVE_REGION."
  value       = var.aws_region
}

output "archive_prefix" {
  description = "Value for AWS_ARCHIVE_PREFIX."
  value       = var.archive_prefix
}

output "controller_principal_arn" {
  description = "IAM principal granted prefix-scoped archive access and denied archive deletion."
  value       = local.controller_principal_arn
}

output "controller_environment" {
  description = "Non-secret environment values for the local AI Toolkit controller."
  value = {
    AI_TOOLKIT_AWS_ARCHIVE_ENABLED = "1"
    AWS_PROFILE                    = var.aws_profile
    AWS_ARCHIVE_BUCKET             = aws_s3_bucket.archive.id
    AWS_ARCHIVE_REGION             = var.aws_region
    AWS_ARCHIVE_PREFIX             = var.archive_prefix
  }
}
