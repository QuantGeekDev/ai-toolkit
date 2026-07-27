$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $repositoryRoot 'venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }

& $python -m unittest `
  testing.test_training_bundle `
  testing.test_runpod_worker `
  testing.test_runpod_provision `
  testing.test_cloud_captioner `
  testing.test_caption_prompt_templates
if ($LASTEXITCODE -ne 0) { throw 'Python remote contract tests failed.' }

& $python -m unittest discover -s (Join-Path $repositoryRoot 'remote\runpod\comfyui\tests') -v
if ($LASTEXITCODE -ne 0) { throw 'Ephemeral ComfyUI image contract tests failed.' }

& $python -m py_compile `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\acceptance.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\preflight.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\provision.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\scripts\bootstrap.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\scripts\capability_probe.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\scripts\download_models.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\scripts\image_contract.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\scripts\sidecar.py') `
  (Join-Path $repositoryRoot 'remote\runpod\comfyui\scripts\status_file.py')
if ($LASTEXITCODE -ne 0) { throw 'Ephemeral ComfyUI Python syntax checks failed.' }

Push-Location (Join-Path $repositoryRoot 'ui')
try {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'UI/RunPod client tests failed.' }
  npx tsc -p tsconfig.worker.json --noEmit
  if ($LASTEXITCODE -ne 0) { throw 'Controller TypeScript check failed.' }
} finally {
  Pop-Location
}
