param(
  [Parameter(Mandatory = $true)]
  [string]$Environment,

  [string]$ProjectRoot,

  [string]$ConfigPath,

  [string]$TestRecordingId,

  [switch]$SkipBuild,

  [switch]$SkipRun,

  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $PSScriptRoot 'cloud-run-video-job.environments.json'
}

$JobName = 'generate-video-rec'
$RepositoryName = 'video-jobs'
$ServiceAccountId = 'video-generator-job'
$ImageName = 'generate-video-rec'
$RequiredApis = @(
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
  'pubsub.googleapis.com',
  'storage.googleapis.com',
  'firestore.googleapis.com',
  'datastore.googleapis.com'
)

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando '$Name' nao encontrado no PATH. Instale o Google Cloud CLI e reabra o PowerShell."
  }
}

function Invoke-Gcloud {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [switch]$AllowFailure,

    [switch]$CaptureOutput
  )

  $display = "gcloud $($Arguments -join ' ')"

  if ($DryRun) {
    Write-Host "[DRY RUN] $display" -ForegroundColor DarkYellow
    if ($CaptureOutput) {
      return ''
    }
    return $null
  }

  Write-Host $display -ForegroundColor DarkGray
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  try {
    $output = & gcloud @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw ($output | Out-String)
  }

  if ($CaptureOutput) {
    return ($output | Out-String).Trim()
  }

  if ($output) {
    $output | ForEach-Object { Write-Host $_ }
  }

  return $exitCode
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

function Assert-ConfigField {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Config,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $value = [string]$Config.$Name
  if ([string]::IsNullOrWhiteSpace($value) -or $value -eq 'TODO') {
    throw "Campo obrigatorio pendente no JSON para '$Environment': $Name"
  }
}

function Assert-ProjectRoot {
  param([Parameter(Mandatory = $true)][string]$Root)

  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "ProjectRoot nao existe: $Root"
  }

  foreach ($requiredFile in @('package.json', 'Dockerfile', 'render-job.js')) {
    $path = Join-Path $Root $requiredFile
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "ProjectRoot invalido. Arquivo nao encontrado: $path"
    }
  }
}

function Assert-NodeModulesIgnored {
  param([Parameter(Mandatory = $true)][string]$Root)

  # Cloud Build envia o contexto local. Este check evita subir node_modules por engano.
  $ignoreFiles = @('.gcloudignore', '.gitignore', '.dockerignore')
  foreach ($file in $ignoreFiles) {
    $path = Join-Path $Root $file
    if ((Test-Path -LiteralPath $path -PathType Leaf) -and
      (Select-String -LiteralPath $path -Pattern '(^|/|\\)node_modules/?$' -Quiet)) {
      return
    }
  }

  throw "Nenhum .gcloudignore/.gitignore/.dockerignore com node_modules encontrado em $Root."
}

function Test-GcloudResourceExists {
  param([Parameter(Mandatory = $true)][string[]]$DescribeArguments)

  if ($DryRun) {
    Invoke-Gcloud -Arguments $DescribeArguments -AllowFailure | Out-Null
    return $false
  }

  $exitCode = Invoke-Gcloud -Arguments $DescribeArguments -AllowFailure
  return $exitCode -eq 0
}

function Ensure-ProjectSelected {
  param([Parameter(Mandatory = $true)][string]$ProjectId)

  # Mantem todos os comandos seguintes no projeto do ambiente escolhido.
  Invoke-Gcloud -Arguments @('config', 'set', 'project', $ProjectId) | Out-Null
}

function Assert-GcloudLogin {
  # Exige uma conta ativa no gcloud para chamadas IAM, Cloud Build e Cloud Run.
  $account = Invoke-Gcloud -Arguments @(
    'auth',
    'list',
    '--filter=status:ACTIVE',
    '--format=value(account)'
  ) -CaptureOutput

  if (-not $DryRun -and [string]::IsNullOrWhiteSpace($account)) {
    throw "Nenhuma conta ativa no gcloud. Rode: gcloud auth login"
  }
}

function Ensure-ServicesEnabled {
  param([Parameter(Mandatory = $true)][string]$ProjectId)

  # Habilita as APIs necessarias para build, repositorio, Job, Pub/Sub, Storage e Firestore.
  foreach ($api in $RequiredApis) {
    Invoke-Gcloud -Arguments @('services', 'enable', $api, '--project', $ProjectId) | Out-Null
  }
}

function Ensure-ArtifactRegistryRepository {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Region
  )

  # Reutiliza o repositorio Docker se ele ja existir; caso contrario, cria.
  $exists = Test-GcloudResourceExists -DescribeArguments @(
    'artifacts',
    'repositories',
    'describe',
    $RepositoryName,
    '--location',
    $Region,
    '--project',
    $ProjectId
  )

  if ($exists) {
    Write-Host "Artifact Registry '$RepositoryName' ja existe."
    return
  }

  Invoke-Gcloud -Arguments @(
    'artifacts',
    'repositories',
    'create',
    $RepositoryName,
    '--repository-format=docker',
    '--location',
    $Region,
    '--description',
    'Cloud Run video generation jobs',
    '--project',
    $ProjectId
  ) | Out-Null
}

function Ensure-JobServiceAccount {
  param([Parameter(Mandatory = $true)][string]$ProjectId)

  $email = "$ServiceAccountId@$ProjectId.iam.gserviceaccount.com"

  # A service account e o runtime identity do Job de renderizacao.
  $exists = Test-GcloudResourceExists -DescribeArguments @(
    'iam',
    'service-accounts',
    'describe',
    $email,
    '--project',
    $ProjectId
  )

  if ($exists) {
    Write-Host "Service account '$email' ja existe."
    return $email
  }

  Invoke-Gcloud -Arguments @(
    'iam',
    'service-accounts',
    'create',
    $ServiceAccountId,
    '--display-name',
    'Video generator Cloud Run Job',
    '--project',
    $ProjectId
  ) | Out-Null

  return $email
}

function Add-ProjectIamBinding {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Member,
    [Parameter(Mandatory = $true)][string]$Role
  )

  Invoke-Gcloud -Arguments @(
    'projects',
    'add-iam-policy-binding',
    $ProjectId,
    '--member',
    $Member,
    '--role',
    $Role,
    '--condition=None',
    '--quiet'
  ) | Out-Null
}

function Add-TopicIamBinding {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$TopicName,
    [Parameter(Mandatory = $true)][string]$Member,
    [Parameter(Mandatory = $true)][string]$Role
  )

  Invoke-Gcloud -Arguments @(
    'pubsub',
    'topics',
    'add-iam-policy-binding',
    $TopicName,
    '--project',
    $ProjectId,
    '--member',
    $Member,
    '--role',
    $Role
  ) | Out-Null
}

function Add-BucketIamBinding {
  param(
    [Parameter(Mandatory = $true)][string]$BucketName,
    [Parameter(Mandatory = $true)][string]$Member,
    [Parameter(Mandatory = $true)][string]$Role
  )

  Invoke-Gcloud -Arguments @(
    'storage',
    'buckets',
    'add-iam-policy-binding',
    "gs://$BucketName",
    '--member',
    $Member,
    '--role',
    $Role
  ) | Out-Null
}

function Build-ContainerImage {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Region,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $imageUri = "$Region-docker.pkg.dev/$ProjectId/$RepositoryName/$ImageName`:latest"

  # Cloud Build monta a imagem a partir da raiz do projeto, onde estao Dockerfile e package.json.
  Invoke-Gcloud -Arguments @(
    'builds',
    'submit',
    $Root,
    '--tag',
    $imageUri,
    '--project',
    $ProjectId
  ) | Out-Null

  return $imageUri
}

function Ensure-CloudRunJob {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Region,
    [Parameter(Mandatory = $true)][string]$ImageUri,
    [Parameter(Mandatory = $true)][string]$ServiceAccountEmail,
    [Parameter(Mandatory = $true)][string]$TopicName,
    [Parameter(Mandatory = $true)][string]$AppEnv
  )

  $commonArgs = @(
    '--region',
    $Region,
    '--project',
    $ProjectId,
    '--image',
    $ImageUri,
    '--service-account',
    $ServiceAccountEmail,
    '--cpu',
    '2',
    '--memory',
    '4Gi',
    '--task-timeout',
    '3600s',
    '--max-retries',
    '1',
    '--tasks',
    '1',
    '--set-env-vars',
    "TOPIC_NAME=$TopicName,APP_ENV=$AppEnv"
  )

  # Atualiza o Job quando existir e cria quando ainda nao existir.
  $exists = Test-GcloudResourceExists -DescribeArguments @(
    'run',
    'jobs',
    'describe',
    $JobName,
    '--region',
    $Region,
    '--project',
    $ProjectId
  )

  if ($exists) {
    Invoke-Gcloud -Arguments (@('run', 'jobs', 'update', $JobName) + $commonArgs) | Out-Null
    return
  }

  Invoke-Gcloud -Arguments (@('run', 'jobs', 'create', $JobName) + $commonArgs) | Out-Null
}

function Add-CloudRunInvoker {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Region,
    [Parameter(Mandatory = $true)][string]$FunctionServiceAccount
  )

  # Permite que a Function configurada execute o Job.
  Invoke-Gcloud -Arguments @(
    'run',
    'jobs',
    'add-iam-policy-binding',
    $JobName,
    '--region',
    $Region,
    '--project',
    $ProjectId,
    '--member',
    "serviceAccount:$FunctionServiceAccount",
    '--role',
    'roles/run.invoker'
  ) | Out-Null
}

function Execute-TestJob {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$Region,
    [Parameter(Mandatory = $true)][string]$RecordingId
  )

  # Execucao opcional para validar uma gravacao especifica.
  Invoke-Gcloud -Arguments @(
    'run',
    'jobs',
    'execute',
    $JobName,
    '--region',
    $Region,
    '--project',
    $ProjectId,
    '--update-env-vars',
    "RECORDING_ID=$RecordingId",
    '--wait'
  ) | Out-Null
}

$config = Read-EnvironmentConfig -Path $ConfigPath -Name $Environment

foreach ($field in @('projectId', 'region', 'appEnv', 'topicName', 'bucketName', 'functionServiceAccount')) {
  Assert-ConfigField -Config $config -Name $field
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
Assert-ProjectRoot -Root $resolvedProjectRoot
Assert-NodeModulesIgnored -Root $resolvedProjectRoot

$projectId = [string]$config.projectId
$region = [string]$config.region
$topicName = [string]$config.topicName
$bucketName = [string]$config.bucketName
$appEnv = [string]$config.appEnv
$functionServiceAccount = [string]$config.functionServiceAccount
$jobServiceAccount = "$ServiceAccountId@$projectId.iam.gserviceaccount.com"
$imageUri = "$region-docker.pkg.dev/$projectId/$RepositoryName/$ImageName`:latest"

Write-Step "Validando gcloud e login"
Assert-CommandExists -Name 'gcloud'
Assert-GcloudLogin
Ensure-ProjectSelected -ProjectId $projectId

Write-Step "Habilitando APIs necessarias"
Ensure-ServicesEnabled -ProjectId $projectId

Write-Step "Validando Artifact Registry"
Ensure-ArtifactRegistryRepository -ProjectId $projectId -Region $region

Write-Step "Validando service account do Job"
$jobServiceAccount = Ensure-JobServiceAccount -ProjectId $projectId
$jobMember = "serviceAccount:$jobServiceAccount"

Write-Step "Aplicando permissoes do Job"
Add-TopicIamBinding -ProjectId $projectId -TopicName $topicName -Member $jobMember -Role 'roles/pubsub.publisher'
Add-ProjectIamBinding -ProjectId $projectId -Member $jobMember -Role 'roles/datastore.user'
Add-BucketIamBinding -BucketName $bucketName -Member $jobMember -Role 'roles/storage.objectAdmin'

if ($SkipBuild) {
  Write-Step "Build ignorado por -SkipBuild"
  Write-Host "Usando imagem existente: $imageUri"
} else {
  Write-Step "Fazendo build e push da imagem via Cloud Build"
  $imageUri = Build-ContainerImage -ProjectId $projectId -Region $region -Root $resolvedProjectRoot
}

Write-Step "Criando ou atualizando Cloud Run Job"
Ensure-CloudRunJob `
  -ProjectId $projectId `
  -Region $region `
  -ImageUri $imageUri `
  -ServiceAccountEmail $jobServiceAccount `
  -TopicName $topicName `
  -AppEnv $appEnv

Write-Step "Aplicando permissao Cloud Run Invoker para a Function"
Add-CloudRunInvoker -ProjectId $projectId -Region $region -FunctionServiceAccount $functionServiceAccount

if (-not [string]::IsNullOrWhiteSpace($TestRecordingId) -and -not $SkipRun) {
  Write-Step "Executando Job de teste com RECORDING_ID"
  Execute-TestJob -ProjectId $projectId -Region $region -RecordingId $TestRecordingId
} elseif (-not [string]::IsNullOrWhiteSpace($TestRecordingId) -and $SkipRun) {
  Write-Step "Execucao de teste ignorada por -SkipRun"
} else {
  Write-Step "Execucao de teste nao solicitada"
}

Write-Host ""
Write-Host "Concluido para '$Environment'." -ForegroundColor Green
Write-Host "Job: $JobName"
Write-Host "Project: $projectId"
Write-Host "Region: $region"
Write-Host "Image: $imageUri"
