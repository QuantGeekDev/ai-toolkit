variable "aws_profile" {
  description = "Local AWS CLI profile used by Terraform and the AI Toolkit controller."
  type        = string
  default     = "echoflicks"

  validation {
    condition     = length(trimspace(var.aws_profile)) > 0
    error_message = "aws_profile must not be empty."
  }
}

variable "aws_region" {
  description = "AWS region for the optional immutable training archive."
  type        = string
  default     = "eu-west-1"
}

variable "bucket_name" {
  description = "Optional globally unique bucket name. Null uses ai-toolkit-training-<account>-<region>."
  type        = string
  default     = null

  validation {
    condition = var.bucket_name == null || can(regex(
      "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      var.bucket_name,
    ))
    error_message = "bucket_name must be a valid lowercase S3 bucket name."
  }
}

variable "archive_prefix" {
  description = "Object prefix passed to AWS_ARCHIVE_PREFIX."
  type        = string
  default     = "ai-toolkit"

  validation {
    condition = can(regex(
      "^[A-Za-z0-9][A-Za-z0-9._/-]{0,126}[A-Za-z0-9]$|^[A-Za-z0-9]$",
      var.archive_prefix,
    )) && !strcontains(var.archive_prefix, "..") && !strcontains(var.archive_prefix, "//")
    error_message = "archive_prefix must be a safe relative S3 prefix without '..', empty components, or leading/trailing slashes."
  }
}

variable "force_destroy" {
  description = "Allow Terraform to delete a non-empty archive bucket. Keep false for safety."
  type        = bool
  default     = false
}

variable "abort_incomplete_upload_days" {
  description = "Days before incomplete multipart uploads are removed."
  type        = number
  default     = 1

  validation {
    condition     = var.abort_incomplete_upload_days >= 1
    error_message = "abort_incomplete_upload_days must be at least 1."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Days to retain noncurrent object versions. Current artifacts are retained indefinitely."
  type        = number
  default     = 365

  validation {
    condition     = var.noncurrent_version_retention_days >= 1
    error_message = "noncurrent_version_retention_days must be at least 1."
  }
}

variable "controller_principal_arn" {
  description = "IAM user/role allowed to archive. Null uses the caller behind aws_profile."
  type        = string
  default     = null

  validation {
    condition     = var.controller_principal_arn == null || can(regex("^arn:[^:]+:iam::[0-9]{12}:(user|role)/.+$", var.controller_principal_arn))
    error_message = "controller_principal_arn must be an IAM user or role ARN."
  }
}

variable "tags" {
  description = "Additional tags for archive resources."
  type        = map(string)
  default     = {}
}
