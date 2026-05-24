param(
  [Parameter(Mandatory = $true)]
  [string]$Environment,

  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'cloud-run-video-job.environments.json'
}

function Read-EnvironmentConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Arquivo de configuracao nao encontrado: $Path"
  }

  $allConfig = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if (-not $allConfig.PSObject.Properties.Name.Contains($Name)) {
    $available = ($allConfig.PSObject.Properties.Name | Sort-Object) -join ', '
    throw "Ambiente '$Name' nao existe no JSON. Ambientes disponiveis: $available"
  }

  return $allConfig.$Name
}

function Assert-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando '$Name' nao encontrado no PATH."
  }
}

function Invoke-Gcloud {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  Write-Host "gcloud $($Arguments -join ' ')" -ForegroundColor DarkGray
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  try {
    $output = & gcloud @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0) {
    throw ($output | Out-String)
  }

  return ($output | Out-String).Trim()
}

$config = Read-EnvironmentConfig -Path $ConfigPath -Name $Environment

if ([string]::IsNullOrWhiteSpace([string]$config.functionName) -or [string]$config.functionName -eq 'TODO') {
  Write-Host "functionName esta TODO para '$Environment'." -ForegroundColor Yellow
  Write-Host "Preencha functionName no JSON antes de descobrir a service account."
  exit 1
}

Assert-CommandExists -Name 'gcloud'

if ([string]::IsNullOrWhiteSpace([string]$config.projectId) -or [string]$config.projectId -eq 'TODO') {
  throw "projectId esta pendente para '$Environment'."
}

if ([string]::IsNullOrWhiteSpace([string]$config.region) -or [string]$config.region -eq 'TODO') {
  throw "region esta pendente para '$Environment'."
}

Invoke-Gcloud -Arguments @('config', 'set', 'project', $config.projectId) | Out-Null

$serviceAccount = Invoke-Gcloud -Arguments @(
  'functions',
  'describe',
  $config.functionName,
  '--gen2',
  '--region',
  $config.region,
  '--format=value(serviceConfig.serviceAccountEmail)'
)

if ([string]::IsNullOrWhiteSpace($serviceAccount)) {
  throw "Nao foi possivel descobrir serviceConfig.serviceAccountEmail para $($config.functionName)."
}

Write-Host "Service account da Function '$($config.functionName)' em '$Environment':" -ForegroundColor Green
Write-Host $serviceAccount
Write-Host ""
Write-Host "Atualize cloud-run-video-job.environments.json:"
Write-Host """functionServiceAccount"": ""$serviceAccount"""
