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

function Test-RequiredField {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Config,

    [Parameter(Mandatory = $true)]
    [string]$FieldName
  )

  $value = $Config.$FieldName
  return -not [string]::IsNullOrWhiteSpace([string]$value) -and [string]$value -ne 'TODO'
}

$requiredFields = @(
  'projectId',
  'region',
  'appEnv',
  'product',
  'topicName',
  'bucketName',
  'functionServiceAccount'
)

$config = Read-EnvironmentConfig -Path $ConfigPath -Name $Environment
$missing = @()

foreach ($field in $requiredFields) {
  if (-not (Test-RequiredField -Config $config -FieldName $field)) {
    $missing += $field
  }
}

if ($missing.Count -gt 0) {
  Write-Host "Ambiente '$Environment' incompleto." -ForegroundColor Yellow
  Write-Host "Campos pendentes: $($missing -join ', ')" -ForegroundColor Yellow
  exit 1
}

Write-Host "Ambiente '$Environment' valido." -ForegroundColor Green
Write-Host "Project: $($config.projectId)"
Write-Host "Region: $($config.region)"
Write-Host "APP_ENV: $($config.appEnv)"
Write-Host "Product: $($config.product)"
Write-Host "Topic: $($config.topicName)"
Write-Host "Bucket: $($config.bucketName)"
Write-Host "Function service account: $($config.functionServiceAccount)"
