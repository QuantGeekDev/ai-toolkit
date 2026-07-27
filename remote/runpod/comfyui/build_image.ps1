param(
  [Parameter(Mandatory = $true)]
  [string]$ImageTag,
  [switch]$BuildOnly,
  [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$dockerfile = Join-Path $PSScriptRoot 'Dockerfile'
if ($ImageTag -notmatch '^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+:[A-Za-z0-9._-]+$') {
  throw 'ImageTag must be a registry/repository:tag reference.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or is not available on PATH.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is installed, but its daemon is not running.' }
$status = git -C $repositoryRoot status --porcelain=v1 --untracked-files=normal
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Git worktree.' }
if ($status -and -not $AllowDirty) { throw 'Production ComfyUI images must be built from a clean committed worktree.' }
$comfyLockHash = (Get-FileHash (Join-Path $PSScriptRoot 'comfy-requirements.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecarLockHash = (Get-FileHash (Join-Path $PSScriptRoot 'requirements.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
$lockContract = "$comfyLockHash.$sidecarLockHash"

docker build `
  --pull=false `
  --platform linux/amd64 `
  --build-arg "REQUIREMENTS_LOCK_SHA256=$lockContract" `
  --file $dockerfile `
  --tag $ImageTag `
  $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI image build failed.' }

docker run --rm --entrypoint python $ImageTag /opt/aitk/scripts/image_contract.py
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI image structure test failed.' }
if ($BuildOnly) {
  Write-Output $ImageTag
  return
}

docker push $ImageTag
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI image push failed. Authenticate to the registry and retry.' }
$repoDigest = docker inspect --format='{{index .RepoDigests 0}}' $ImageTag
if ($LASTEXITCODE -ne 0 -or $repoDigest -notmatch '@sha256:[0-9a-fA-F]{64}$') {
  throw 'The registry did not return an immutable pushed image digest.'
}
Write-Output $repoDigest
