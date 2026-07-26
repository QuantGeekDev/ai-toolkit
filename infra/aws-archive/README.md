# Optional AWS archive infrastructure

This Terraform root creates the private, versioned S3 bucket used by AI Toolkit's optional post-training archive. It does not create or receive AWS access keys. Terraform and the local AI Toolkit controller use the standard AWS credential chain with the `echoflicks` profile by default; no AWS credential is sent to RunPod.

The bucket has public access blocked, bucket-owner-enforced ownership, enforced SSE-S3 encryption, TLS-only access, versioning, one-day incomplete multipart cleanup, and one-year retention for old noncurrent versions. Current bundles and artifacts do not expire automatically. Temporary objects under `ai-toolkit/_acceptance/` expire after seven days. `force_destroy` defaults to false and Terraform has `prevent_destroy` enabled.

The selected controller principal receives object access only under the configured prefix and an explicit deny on deleting archive objects or versions. If `echoflicks` already has broad account permissions, those still exist for other buckets; use `controller_principal_arn` with a dedicated assumable role when you want strict separation from the human account.

## Plan and apply

```powershell
cd C:\Users\Usuario\Documents\ai-toolkit\infra\aws-archive
Copy-Item terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -check
terraform validate
terraform plan -out archive.tfplan
terraform apply archive.tfplan
terraform output -json controller_environment
```

Review the plan before applying it. By default the bucket policy grants the IAM principal behind `echoflicks` the exact archive-prefix permissions the application uses. No access key is created or exported.

After apply, restart the local UI with the non-secret output values in its environment. Do not copy the AWS profile or its credential files into the worker image, RunPod template, training bundle, or browser settings.

## Destroy behavior

`terraform destroy` will refuse to remove a non-empty archive bucket because `force_destroy` is false. That is intentional. Archive deletion requires a separate, explicit retention decision.
