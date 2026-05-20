const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_PROJECT = 'ellevo-connect-dev';
const DEFAULT_BUCKET = 'ellevo-connect-dev.firebasestorage.app';

function printUsage() {
  console.log(`
Uso:
  node copyst.js "<storage-path>" "<destino>" [--project <projectId>] [--bucket <bucket>] [--dry-run]

Exemplo:
  node copyst.js "/recordings/talk/next/tenant/session" "C:\\invoke\\Livekit\\Recorder\\rec1"

Atalhos npm:
  npm run copyst -- "/recordings/talk/next/tenant/session" "C:\\invoke\\Livekit\\Recorder\\rec1"

Padroes:
  project: ${DEFAULT_PROJECT}
  bucket:  ${DEFAULT_BUCKET}
`);
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    project: DEFAULT_PROJECT,
    bucket: DEFAULT_BUCKET,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--project') {
      options.project = argv[++i];
    } else if (arg === '--bucket') {
      options.bucket = argv[++i];
    } else if (arg.startsWith('--project=')) {
      options.project = arg.slice('--project='.length);
    } else if (arg.startsWith('--bucket=')) {
      options.bucket = arg.slice('--bucket='.length);
    } else {
      positional.push(arg);
    }
  }

  return {
    storagePath: positional[0],
    destRoot: positional[1],
    ...options,
  };
}

function normalizeStoragePath(input) {
  if (!input) return '';

  if (input.startsWith('gs://')) {
    const withoutScheme = input.slice('gs://'.length);
    const firstSlash = withoutScheme.indexOf('/');
    if (firstSlash === -1) return '';
    return withoutScheme.slice(firstSlash + 1).replace(/^\/+/, '').replace(/\/+$/, '');
  }

  return input.replace(/^\/+/, '').replace(/\/+$/, '');
}

function getAccessToken() {
  let output;

  try {
    output = execFileSync('firebase.cmd', ['login:list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
  } catch (error) {
    throw new Error(`Nao consegui ler o login do Firebase CLI. Rode "firebase login".\n${error.stderr || error.message}`);
  }

  const parsed = JSON.parse(output);
  const account = parsed.result && parsed.result[0];
  const token = account && account.tokens && account.tokens.access_token;

  if (!token) {
    throw new Error('Firebase CLI nao retornou access_token. Rode "firebase login" novamente.');
  }

  return token;
}

async function googleStorageRequest(url, token, responseType = 'json') {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Google Storage retornou HTTP ${response.status} para ${url}\n${body}`);
  }

  if (responseType === 'arrayBuffer') {
    return response.arrayBuffer();
  }

  return response.json();
}

async function listObjects({ bucket, prefix, token }) {
  const objects = [];
  let pageToken = '';

  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`);
    url.searchParams.set('prefix', prefix);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const page = await googleStorageRequest(url, token);
    if (Array.isArray(page.items)) {
      objects.push(...page.items.filter((item) => item.name && !item.name.endsWith('/')));
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  return objects;
}

function relativeOutputName(objectName, prefix) {
  let relative = objectName.slice(prefix.length).replace(/^\/+/, '');
  if (!relative) relative = path.basename(objectName);
  return relative;
}

async function downloadObject({ bucket, object, outputFile, token }) {
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object.name)}`);
  url.searchParams.set('alt', 'media');

  const data = Buffer.from(await googleStorageRequest(url, token, 'arrayBuffer'));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, data);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const prefix = normalizeStoragePath(args.storagePath);
  const destRoot = args.destRoot ? path.resolve(args.destRoot) : '';

  if (!prefix || !destRoot) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!args.bucket) {
    throw new Error('Bucket nao informado.');
  }

  console.log(`Projeto: ${args.project}`);
  console.log(`Bucket:  ${args.bucket}`);
  console.log(`Prefixo: ${prefix}`);
  console.log(`Destino: ${destRoot}`);

  const token = getAccessToken();
  const objects = await listObjects({ bucket: args.bucket, prefix, token });

  if (objects.length === 0) {
    throw new Error(`Nenhum objeto encontrado para o prefixo: ${prefix}`);
  }

  let totalBytes = 0;
  for (const object of objects) {
    totalBytes += Number(object.size || 0);
  }

  console.log(`Encontrados: ${objects.length} arquivo(s), ${totalBytes} bytes`);

  if (args.dryRun) {
    for (const object of objects) {
      console.log(`DRY-RUN ${relativeOutputName(object.name, prefix)} (${object.size || 0} bytes)`);
    }
    return;
  }

  fs.mkdirSync(destRoot, { recursive: true });

  let downloaded = 0;
  for (const object of objects) {
    const relative = relativeOutputName(object.name, prefix);
    const outputFile = path.join(destRoot, relative);
    await downloadObject({ bucket: args.bucket, object, outputFile, token });
    downloaded += 1;
    console.log(`OK ${relative} (${object.size || 0} bytes)`);
  }

  console.log(`Concluido: ${downloaded} arquivo(s) copiado(s) para ${destRoot}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
