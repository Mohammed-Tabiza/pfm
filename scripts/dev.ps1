param(
  [string]$OllamaBaseUrl = "",
  [string]$OllamaApiKey = "",
  [string]$OllamaModel = "",
  [int]$BackendPort = 0,
  [int]$FrontendPort = 0
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $repoRoot "backend"
$backendPython = Join-Path $backendDir ".venv\Scripts\python.exe"

function Import-EnvFile {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $pair = $line -split "=", 2
    $name = $pair[0].Trim()
    $value = $pair[1].Trim().Trim("'`"")
    if ($name -and -not [string]::IsNullOrWhiteSpace($value) -and -not (Test-Path "Env:$name")) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

Import-EnvFile (Join-Path $repoRoot ".env")
Import-EnvFile (Join-Path $repoRoot ".env.local")

if ([string]::IsNullOrWhiteSpace($OllamaBaseUrl)) {
  $OllamaBaseUrl = if ($env:OLLAMA_BASE_URL) { $env:OLLAMA_BASE_URL } else { "http://localhost:11434/v1" }
}
if ([string]::IsNullOrWhiteSpace($OllamaApiKey)) {
  $OllamaApiKey = if ($env:OLLAMA_API_KEY) { $env:OLLAMA_API_KEY } else { "ollama" }
}
if ([string]::IsNullOrWhiteSpace($OllamaModel)) {
  $OllamaModel = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { "minimax-m2.5:cloud" }
}
if ($BackendPort -le 0) {
  $BackendPort = if ($env:BACKEND_PORT) { [int]$env:BACKEND_PORT } else { 8123 }
}
if ($FrontendPort -le 0) {
  $FrontendPort = if ($env:FRONTEND_PORT) { [int]$env:FRONTEND_PORT } else { 3000 }
}

if (-not (Test-Path $backendPython)) {
  Write-Error "Python backend introuvable: $backendPython"
}

Write-Output "Demarrage du backend et du frontend..."
Write-Output "Backend:  http://localhost:$BackendPort"
Write-Output "Frontend: http://localhost:$FrontendPort"
Write-Output "Modele Ollama: $OllamaModel"

$backendJob = Start-Job -Name "pfm-backend" -ArgumentList @(
  $backendDir,
  $OllamaBaseUrl,
  $OllamaApiKey,
  $OllamaModel,
  $BackendPort
) -ScriptBlock {
  param($backendDir, $OllamaBaseUrl, $OllamaApiKey, $OllamaModel, $BackendPort)
  Set-Location $backendDir
  $env:OLLAMA_BASE_URL = $OllamaBaseUrl
  $env:OLLAMA_API_KEY = $OllamaApiKey
  $env:OLLAMA_MODEL = $OllamaModel
  $env:PORT = "$BackendPort"
  & ".\.venv\Scripts\python.exe" "main.py" 2>&1
}

$frontendJob = Start-Job -Name "pfm-frontend" -ArgumentList @(
  $repoRoot,
  $FrontendPort
) -ScriptBlock {
  param($repoRoot, $FrontendPort)
  Set-Location $repoRoot
  $env:PORT = "$FrontendPort"
  npm run dev 2>&1
}

try {
  while ($true) {
    Receive-Job -Job $backendJob -Keep | ForEach-Object { "[backend] $_" }
    Receive-Job -Job $frontendJob -Keep | ForEach-Object { "[frontend] $_" }

    if ($backendJob.State -in @("Failed", "Stopped", "Completed")) {
      Write-Output "Le backend s'est arrete (etat: $($backendJob.State))."
      break
    }
    if ($frontendJob.State -in @("Failed", "Stopped", "Completed")) {
      Write-Output "Le frontend s'est arrete (etat: $($frontendJob.State))."
      break
    }

    Start-Sleep -Milliseconds 300
  }
}
finally {
  foreach ($job in @($backendJob, $frontendJob)) {
    if ($job -and $job.State -eq "Running") {
      Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
    }
  }

  Receive-Job -Job $backendJob -Keep | ForEach-Object { "[backend] $_" }
  Receive-Job -Job $frontendJob -Keep | ForEach-Object { "[frontend] $_" }

  if ($backendJob) { Remove-Job -Job $backendJob -ErrorAction SilentlyContinue | Out-Null }
  if ($frontendJob) { Remove-Job -Job $frontendJob -ErrorAction SilentlyContinue | Out-Null }
}
