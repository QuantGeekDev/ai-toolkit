mock_provider "aws" {}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
    arn        = "arn:aws:iam::123456789012:user/ai-toolkit-test"
  }
}

override_resource {
  target          = aws_s3_bucket.archive
  override_during = plan
  values = {
    id  = "ai-toolkit-training-123456789012-eu-west-1"
    arn = "arn:aws:s3:::ai-toolkit-training-123456789012-eu-west-1"
  }
}

run "secure_archive_defaults" {
  command = plan

  assert {
    condition     = aws_s3_bucket.archive.bucket == "ai-toolkit-training-123456789012-eu-west-1"
    error_message = "The default bucket name must be deterministic and account-scoped."
  }

  assert {
    condition     = aws_s3_bucket.archive.force_destroy == false
    error_message = "Archive force_destroy must remain disabled."
  }

  assert {
    condition     = aws_s3_bucket_versioning.archive.versioning_configuration[0].status == "Enabled"
    error_message = "Archive versioning must be enabled."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.archive.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "The archive must default to SSE-S3 AES256."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.archive.block_public_acls,
      aws_s3_bucket_public_access_block.archive.block_public_policy,
      aws_s3_bucket_public_access_block.archive.ignore_public_acls,
      aws_s3_bucket_public_access_block.archive.restrict_public_buckets,
    ])
    error_message = "Every public-access block must be enabled."
  }

  assert {
    condition = length([
      for rule in aws_s3_bucket_lifecycle_configuration.archive.rule : rule
      if rule.id == "expire-acceptance-fixtures" && rule.expiration[0].days == 7
    ]) == 1
    error_message = "Only the acceptance fixture prefix should receive a current-object expiration rule."
  }

  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.archive.rule : length(rule.expiration) == 0
      if rule.id != "expire-acceptance-fixtures"
    ])
    error_message = "Current bundles and artifacts must not expire automatically."
  }

  assert {
    condition = output.controller_environment == {
      AI_TOOLKIT_AWS_ARCHIVE_ENABLED = "1"
      AWS_ARCHIVE_BUCKET             = "ai-toolkit-training-123456789012-eu-west-1"
      AWS_ARCHIVE_PREFIX             = "ai-toolkit"
      AWS_ARCHIVE_REGION             = "eu-west-1"
      AWS_PROFILE                    = "echoflicks"
    }
    error_message = "Terraform outputs must match the AI Toolkit controller environment contract."
  }
}
