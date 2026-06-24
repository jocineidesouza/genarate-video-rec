# Cloud Run Job de geracao de video

Scripts locais para criar ou atualizar o Cloud Run Job `generate-video-rec` nos ambientes Connect e Talk.

## Pre-requisitos

- Windows PowerShell.
- Google Cloud CLI (`gcloud`) instalado.
- Login no `gcloud` com uma conta que possa administrar Cloud Run, IAM, Cloud Build, Artifact Registry, Pub/Sub e Storage no projeto alvo.
- O projeto local do renderer em `C:\invoke\Livekit\Recorder\genarate-video-rec`.
- O arquivo `cloud-run-video-job.environments.json` preenchido para o ambiente que sera configurado.

## Instalar e autenticar o gcloud no Windows

Instale o Google Cloud CLI pelo instalador oficial:

```powershell
winget install Google.CloudSDK
```

Feche e reabra o PowerShell, depois valide:

```powershell
gcloud --version
```

Autentique sua conta:

```powershell
gcloud auth login
```

Tambem configure Application Default Credentials, util para ferramentas e testes locais que usam SDKs Google:

```powershell
gcloud auth application-default login
```

## Configuracao dos ambientes

Edite:

```text
C:\invoke\Livekit\Recorder\genarate-video-rec\scripts\cloud-run-job\cloud-run-video-job.environments.json
```

Campos principais:

- `projectId`: projeto Google Cloud/Firebase.
- `region`: regiao do Cloud Run Job e da Function, hoje `us-central1`.
- `appEnv`: valor passado ao container em `APP_ENV`.
- `product`: valor passado ao container em `VIDEO_EDITION`, usado para nomear o arquivo final.
- `topicName`: topico Pub/Sub usado pelo pipeline, hoje `talk-events`.
- `bucketName`: bucket do Firebase Storage sem `gs://`.
- `functionName`: nome da Firebase Function Gen2 que deve invocar o Job.
- `functionServiceAccount`: service account runtime da Function. Se estiver `TODO`, descubra com `get-function-service-account.ps1`.

Validar um ambiente:

```powershell
cd C:\invoke\Livekit\Recorder\genarate-video-rec\scripts\cloud-run-job
.\validate-environment.ps1 -Environment connect-stage
```

Descobrir a service account da Function:

```powershell
.\get-function-service-account.ps1 -Environment connect-stage
```

Se o script retornar um e-mail, copie esse valor para `functionServiceAccount` no JSON.

Observacao: `talk-prod` ficou com `projectId` e `bucketName` como `TODO` porque o arquivo
`C:\invoke\Atendo.Core\.env.production.talk` aponta para o projeto de dev (`dev-atendo`).
Preencha esses dois campos com os valores reais antes de configurar Talk Prod.

## Criar ou atualizar o Job

Rode a partir da pasta dos scripts:

```powershell
cd C:\invoke\Livekit\Recorder\genarate-video-rec\scripts\cloud-run-job

.\setup-video-job.ps1 `
  -Environment connect-stage `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec"
```

Para `dev-atendo`, use o ambiente `talk-dev`:

```powershell
cd C:\invoke\Livekit\Recorder\genarate-video-rec\scripts\cloud-run-job

.\setup-video-job.ps1 `
  -Environment talk-dev `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec"
```

Para testar sem executar nenhum comando `gcloud`:

```powershell
.\setup-video-job.ps1 `
  -Environment connect-stage `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec" `
  -DryRun
```

Para reutilizar uma imagem ja publicada e apenas atualizar IAM/Job:

```powershell
.\setup-video-job.ps1 `
  -Environment connect-stage `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec" `
  -SkipBuild
```

Para executar com uma gravacao especifica:

```powershell
.\setup-video-job.ps1 `
  -Environment connect-stage `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec" `
  -TestRecordingId "track-..."
```

## Atualizar codigo e publicar nova imagem

Quando alterar arquivos do projeto local, como `render-job.js`, `render-grid.js`,
`render-dynamic-scenes.js`, `Dockerfile` ou `package.json`, rode o setup sem
`-SkipBuild`. Isso faz um novo Cloud Build, publica a imagem `latest` e atualiza
o Cloud Run Job para apontar para essa imagem.

Fluxo para `dev-atendo`:

```powershell
cd C:\invoke\Livekit\Recorder\genarate-video-rec

# altere e salve os arquivos do projeto
# opcional: faca testes locais aqui

cd .\scripts\cloud-run-job

.\setup-video-job.ps1 `
  -Environment talk-dev `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec"
```

Imagem publicada no `talk-dev`:

```text
us-central1-docker.pkg.dev/dev-atendo/video-jobs/generate-video-rec:latest
```

Use `-SkipBuild` quando quiser apenas reaplicar IAM/configuracao do Job ou
executar um teste usando a imagem que ja esta publicada:

```powershell
.\setup-video-job.ps1 `
  -Environment talk-dev `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec" `
  -SkipBuild
```

Depois de publicar uma nova imagem, teste uma gravacao sem rebuildar de novo:

```powershell
.\setup-video-job.ps1 `
  -Environment talk-dev `
  -ProjectRoot "C:\invoke\Livekit\Recorder\genarate-video-rec" `
  -SkipBuild `
  -TestRecordingId "track-..."
```

Resumo pratico:

- Alterou codigo e quer publicar nova imagem: rode sem `-SkipBuild`.
- Nao alterou codigo e quer so ajustar IAM/config do Job: rode com `-SkipBuild`.
- Quer executar uma gravacao de teste depois do build: rode com `-SkipBuild -TestRecordingId "..."`.

O script configura o Job com:

- CPU: `2`
- Memoria: `4Gi`
- Timeout: `3600s`
- Max retries: `1`
- Tasks: `1`
- Env vars: `TOPIC_NAME`, `APP_ENV`, `VIDEO_EDITION`

## Ver logs

Execucoes do Job:

```powershell
gcloud run jobs executions list `
  --job generate-video-rec `
  --region us-central1 `
  --project PROJECT_ID
```

Logs recentes:

```powershell
gcloud logging read `
  "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"generate-video-rec\"" `
  --project PROJECT_ID `
  --limit 50 `
  --format "table(timestamp,severity,textPayload)"
```

Tambem e possivel abrir o projeto no Console do Google Cloud, entrar em Cloud Run, selecionar Jobs e abrir `generate-video-rec`.

## Problemas comuns

### PERMISSION_DENIED Firestore

Sintoma: erro ao ler ou atualizar `LIVEKIT_EGRESS_INDEX`.

Verifique se a service account `video-generator-job@PROJECT_ID.iam.gserviceaccount.com` recebeu:

```text
roles/datastore.user
```

### storage.objects.list denied

Sintoma: erro ao listar arquivos da gravacao no bucket.

Verifique se a service account do Job recebeu no bucket:

```text
roles/storage.objectAdmin
```

O bucket no JSON deve ser somente o nome, por exemplo:

```text
ellevo-connect-stg.firebasestorage.app
```

### Pub/Sub publish denied

Sintoma: o Job gera o video mas falha ao publicar o evento final.

Verifique se a service account do Job recebeu no topico `talk-events`:

```text
roles/pubsub.publisher
```

### LIVEKIT_EGRESS_INDEX nao encontrado

Sintoma: o Job nao encontra a gravacao para o `RECORDING_ID`.

Confirme se o valor passado em `-TestRecordingId` e o id correto do documento pai em `LIVEKIT_EGRESS_INDEX`. Um id de TrackEgress filho ou um id de outro ambiente pode falhar mesmo com IAM correto.

## Observacoes de seguranca

- Os scripts nao apagam recursos.
- Os scripts nao usam credencial JSON.
- Os scripts nao criam chaves de service account.
- Antes do build, o script valida `ProjectRoot` e exige que `node_modules` esteja ignorado por `.gcloudignore`, `.gitignore` ou `.dockerignore`.
