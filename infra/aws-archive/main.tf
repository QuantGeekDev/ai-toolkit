locals {
  bucket_name = coalesce(
    var.bucket_name,
    "ai-toolkit-training-${data.aws_caller_identity.current.account_id}-${var.aws_region}",
  )
  common_tags = merge(
    {
      Application = "ai-toolkit"
      ManagedBy   = "terraform"
      Purpose     = "remote-training-archive"
    },
    var.tags,
  )
  controller_principal_arn = coalesce(var.controller_principal_arn, data.aws_caller_identity.current.arn)
}

resource "aws_s3_bucket" "archive" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy
  tags          = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket = aws_s3_bucket.archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket     = aws_s3_bucket.archive.id
  depends_on = [aws_s3_bucket_versioning.archive]

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_incomplete_upload_days
    }
  }

  rule {
    id     = "expire-old-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = var.noncurrent_version_retention_days
      newer_noncurrent_versions = 5
    }
  }

  rule {
    id     = "expire-acceptance-fixtures"
    status = "Enabled"

    filter {
      prefix = "${var.archive_prefix}/_acceptance/"
    }

    expiration {
      days = 7
    }
  }
}

data "aws_iam_policy_document" "secure_transport" {
  statement {
    sid    = "AllowControllerBucketInspection"
    effect = "Allow"
    actions = [
      "s3:GetBucketLocation",
      "s3:GetBucketVersioning",
    ]
    resources = [aws_s3_bucket.archive.arn]

    principals {
      type        = "AWS"
      identifiers = [local.controller_principal_arn]
    }
  }

  statement {
    sid     = "AllowControllerPrefixListing"
    effect  = "Allow"
    actions = ["s3:ListBucket"]
    resources = [
      aws_s3_bucket.archive.arn,
    ]

    principals {
      type        = "AWS"
      identifiers = [local.controller_principal_arn]
    }

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        var.archive_prefix,
        "${var.archive_prefix}/*",
      ]
    }
  }

  statement {
    sid    = "AllowControllerArchiveAccess"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.archive.arn}/${var.archive_prefix}/*"]

    principals {
      type        = "AWS"
      identifiers = [local.controller_principal_arn]
    }
  }

  statement {
    sid    = "DenyControllerArchiveDeletion"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.archive.arn}/${var.archive_prefix}/*"]

    principals {
      type        = "AWS"
      identifiers = [local.controller_principal_arn]
    }
  }

  statement {
    sid     = "DenyUnencryptedUploads"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.archive.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Null"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["true"]
    }
  }

  statement {
    sid     = "DenyIncorrectEncryption"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.archive.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["AES256"]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    actions = [
      "s3:*",
    ]
    resources = [
      aws_s3_bucket.archive.arn,
      "${aws_s3_bucket.archive.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "secure_transport" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.secure_transport.json

  depends_on = [aws_s3_bucket_public_access_block.archive]
}
