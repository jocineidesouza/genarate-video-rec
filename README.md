# generate-video-rec

Ferramenta Node.js para gerar um `manifest.json` a partir de arquivos de TrackEgress e renderizar um vídeo final em grid com FFmpeg.

## Requisitos

- Node.js 18 ou superior
- FFmpeg instalado e disponível no `PATH`

## Instalar Node.js no Windows

1. Acesse https://nodejs.org/
2. Baixe a versão LTS para Windows.
3. Execute o instalador mantendo a opção de adicionar Node.js ao `PATH`.
4. Abra um novo PowerShell e valide:

```powershell
node -v
npm -v
```

## Instalar FFmpeg no Windows

Uma forma simples é usar o WinGet:

```powershell
winget install Gyan.FFmpeg
```

Depois feche e abra o PowerShell novamente e valide:

```powershell
ffmpeg -version
```

Se o comando não for encontrado, adicione a pasta `bin` do FFmpeg ao `PATH` do Windows.

## Instalar dependências do projeto

No diretório do repositório:

```powershell
npm install
```

## Organizar a pasta da gravação

A pasta informada para os scripts deve conter os arquivos baixados do Storage. Os JSONs de TrackEgress podem estar diretamente na pasta ou em subpastas. A pasta `output` é ignorada durante a busca.

Exemplo:

```text
recording-123/
  participant-camera-TR_xxx.webm
  participant-microphone-TR_yyy.webm
  track-egress-camera.json
  nested/
    track-egress-audio.json
```

## Copiar arquivos do Firebase Storage

O script `copyst.js` copia todos os arquivos abaixo de um prefixo do Storage para uma pasta local.

Ele usa o login atual do Firebase CLI (`firebase login`) e, por padrão, aponta para:

```text
project: ellevo-connect-dev
bucket: ellevo-connect-dev.firebasestorage.app
```

Exemplo:

```powershell
npm run copyst -- "/recordings/talk/next/ellevo-connect__dev__conv_9bp2BYgKT1WaFbXUuDel/track-ellevo-connect__dev__conv_9bp2BYgKT1WaFbXUuDel-1779206304138" "C:\invoke\Livekit\Recorder\rec1"
```

Para conferir o que seria copiado sem baixar:

```powershell
npm run copyst -- "/recordings/talk/next/ellevo-connect__dev__conv_9bp2BYgKT1WaFbXUuDel/track-ellevo-connect__dev__conv_9bp2BYgKT1WaFbXUuDel-1779206304138" "C:\invoke\Livekit\Recorder\rec1" --dry-run
```

Se precisar apontar para outro bucket:

```powershell
npm run copyst -- "/recordings/talk/next/minha-pasta" "C:\invoke\Livekit\Recorder\rec2" --project "outro-projeto" --bucket "outro-bucket.firebasestorage.app"
```

Os arquivos gerados serão gravados apenas dentro da própria pasta de gravação:

```text
recording-123/
  output/
    manifest.json
    final-grid.mp4
```

## Gerar o manifest

Use um path absoluto ou relativo para a pasta da gravação.

```powershell
npm run manifest -- "C:\Users\me\Downloads\recording-123"
```

Forma equivalente:

```powershell
npm run manifest -- --workdir "C:\Users\me\Downloads\recording-123"
```

O script:

- procura arquivos `.json` no diretório informado e em subpastas;
- ignora `output`;
- usa apenas JSONs válidos de TrackEgress com `started_at`, `ended_at`, `track_id` e `files`;
- resolve o arquivo de mídia pelo basename de `files[0].filename` ou `files[0].location`;
- salva paths relativos com `/` em `output/manifest.json`.

## Gerar o vídeo final

Depois de gerar o manifest:

```powershell
npm run render:grid -- "C:\Users\me\Downloads\recording-123"
```

Forma equivalente:

```powershell
npm run render:grid -- --workdir "C:\Users\me\Downloads\recording-123"
```

O vídeo final será salvo em:

```text
C:\Users\me\Downloads\recording-123\output\final-grid.mp4
```

## Uso direto com Node.js

```powershell
node generate-manifest.js "C:\Users\me\Downloads\recording-123"
node render-grid.js "C:\Users\me\Downloads\recording-123"
```

Ou:

```powershell
node generate-manifest.js --workdir "C:\Users\me\Downloads\recording-123"
node render-grid.js --workdir "C:\Users\me\Downloads\recording-123"
```

## Erros comuns

- `Diretório de trabalho não informado`: informe o path da gravação.
- `Diretório não encontrado`: confira se o path existe.
- `Nenhum JSON válido de TrackEgress encontrado`: confira se os JSONs baixados do Storage estão na pasta informada.
- `manifest.json não encontrado, rode generate-manifest primeiro`: rode o script de manifest antes do render.
- `FFmpeg não encontrado no PATH`: instale o FFmpeg e abra um novo PowerShell.
