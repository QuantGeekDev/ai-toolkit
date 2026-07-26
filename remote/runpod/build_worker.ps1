param(
  [Parameter(Mandatory = $true)]
  [string]$ImageTag,
  [Parameter(Mandatory = $true)]
  [string]$BaseImageDigest,
  [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not installed or is not available on PATH.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is installed, but its daemon is not running.' }
if ($BaseImageDigest -notmatch '@sha256:[0-9a-fA-F]{64}$') {
  throw 'BaseImageDigest must be an immutable image@sha256 digest.'
}
$status = git -C $repositoryRoot status --porcelain=v1 --untracked-files=normal
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Git worktree.' }
if ($status) { throw 'Worker images must be built from a clean committed worktree.' }
$commit = git -C $repositoryRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve the source commit.' }
$remotes = @(git -C $repositoryRoot remote)
$sourceRemoteName = if ($remotes -contains 'fork') { 'fork' } else { 'origin' }
$sourceRemote = git -C $repositoryRoot remote get-url $sourceRemoteName
if ($LASTEXITCODE -ne 0 -or -not $sourceRemote) { throw 'Could not resolve the source repository URL.' }

$dependencyFiles = @(
  (Join-Path $repositoryRoot 'requirements.txt'),
  (Join-Path $repositoryRoot 'requirements_base.txt'),
  (Join-Path $repositoryRoot 'remote\runpod\requirements.txt')
)
$dependencyIdentity = ($dependencyFiles | ForEach-Object { "$(Split-Path $_ -Leaf):$((Get-FileHash -Algorithm SHA256 $_).Hash.ToLowerInvariant())" }) -join "`n"
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $dependencyLock = [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dependencyIdentity))).ToLowerInvariant()
} finally {
  $sha.Dispose()
}

docker build --pull=false `
  --platform linux/amd64 `
  --file (Join-Path $repositoryRoot 'remote\runpod\Dockerfile') `
  --build-arg "BASE_IMAGE=$BaseImageDigest" `
  --build-arg "AITK_GIT_COMMIT=$commit" `
  --build-arg "AITK_GIT_REMOTE=$sourceRemote" `
  --build-arg "AITK_DEPENDENCY_LOCK_SHA256=$dependencyLock" `
  --tag $ImageTag `
  $repositoryRoot
if ($LASTEXITCODE -ne 0) { throw 'Docker build failed.' }
if ($BuildOnly) {
  Write-Output $ImageTag
  return
}
docker push $ImageTag
if ($LASTEXITCODE -ne 0) { throw 'Docker push failed.' }
$repoDigest = docker inspect --format='{{index .RepoDigests 0}}' $ImageTag
if ($LASTEXITCODE -ne 0 -or $repoDigest -notmatch '@sha256:[0-9a-fA-F]{64}$') {
  throw 'The registry did not return an immutable pushed image digest.'
}
Write-Output $repoDigest
