const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require("firebase-admin");
const { PubSub } = require("@google-cloud/pubsub");
const { main: renderDynamicScenes, getFinalDynamicPath } = require("./render-dynamic-scenes");
const { resolveVideoEdition } = require("./src/video-naming");

const TOPIC_NAME = "talk-events";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeBucketName(value) {
  const text = normalizeText(value);
  if (!text) return "";

  return text
    .replace(/^gs:\/\//, "")
    .split("/")[0]
    .trim();
}

function normalizeStoragePrefix(value) {
  const text = normalizeText(value);
  if (!text) return "";

  const withoutScheme = text.startsWith("gs://")
    ? text.slice("gs://".length).split("/").slice(1).join("/")
    : text;

  return withoutScheme.replace(/^\/+/, "").replace(/\/+$/, "") + "/";
}

function relativeObjectName(objectName, prefix) {
  return objectName.slice(prefix.length).replace(/^\/+/, "");
}

async function loadRecordingIndex(db, recId) {
  const snap = await db.doc(`LIVEKIT_EGRESS_INDEX/${recId}`).get();

  if (!snap.exists) {
    throw new Error(`LIVEKIT_EGRESS_INDEX/${recId} nao encontrado`);
  }

  return snap.data() || {};
}

function resolveRecordingStorage(indexData) {
  const bucketName = normalizeBucketName(indexData.bucketName || indexData.storageBucket);
  const storagePrefix = normalizeStoragePrefix(indexData.filepath || indexData.outputPrefix);

  if (!bucketName) {
    throw new Error("Bucket da gravacao nao encontrado em LIVEKIT_EGRESS_INDEX");
  }

  if (!storagePrefix) {
    throw new Error("Prefixo da gravacao nao encontrado em LIVEKIT_EGRESS_INDEX");
  }

  return {
    bucketName,
    storagePrefix,
    manifestStoragePath: `${storagePrefix}manifest.json`,
  };
}

async function downloadRecordingPrefix(bucket, storagePrefix, workdir) {
  const [files] = await bucket.getFiles({ prefix: storagePrefix });
  const realFiles = files.filter((file) => file.name && !file.name.endsWith("/"));

  if (realFiles.length === 0) {
    throw new Error(`Nenhum arquivo encontrado no prefixo ${storagePrefix}`);
  }

  for (const file of realFiles) {
    const relative = relativeObjectName(file.name, storagePrefix);
    if (!relative) continue;

    const destination = path.join(workdir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await file.download({ destination });
    console.log(`Baixado: ${file.name}`);
  }
}

async function uploadFinalVideo(bucket, localFile, finalStoragePath, recId) {
  if (!fs.existsSync(localFile)) {
    throw new Error(`Video final nao encontrado: ${localFile}`);
  }

  await bucket.upload(localFile, {
    destination: finalStoragePath,
    metadata: {
      contentType: "video/mp4",
      metadata: {
        recId,
        type: "track-recording-render",
      },
    },
    resumable: false,
  });
}

async function publishVideoGeneratedEvent(pubsub, { recId, file, status, errorMessage, indexData }) {
  const eventStatus = Number(status) === 200 ? 200 : 500;
  const event = {
    eventId:
      eventStatus === 200
        ? `video-generated:${recId || "unknown"}`
        : `video-generated-failed:${recId || "unknown"}`,
    createdAt: new Date().toISOString(),
    vertical: indexData?.vertical || null,
    slug: indexData?.slug || null,
    eventType: "video-generated",
    source: "recording-render-job",
    payload: {
      recid: recId || null,
      file: file || null,
      status: eventStatus,
      errorMessage: errorMessage || null,
    },
    receivedAt: new Date().toISOString(),
  };

  await pubsub.topic(TOPIC_NAME).publishMessage({
    json: event,
    attributes: {
      source: "recording-render-job",
    },
    orderingKey: event.slug || "global",
  });
}

async function main() {
  const recId = normalizeText(process.env.RECORDING_ID);
  const jobStartedAt = new Date();
  let indexData = null;
  const pubsub = new PubSub();

  admin.initializeApp();

  try {
    if (!recId) {
      throw new Error("RECORDING_ID nao informado");
    }

    const db = admin.firestore();
    const storage = admin.storage();

    indexData = await loadRecordingIndex(db, recId);
    const { bucketName, storagePrefix, manifestStoragePath } = resolveRecordingStorage(indexData);
    const bucket = storage.bucket(bucketName);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `render-${recId}-`));
    const manifestPath = path.join(workdir, "manifest.json");
    const edition = resolveVideoEdition({
      edition: process.env.VIDEO_EDITION,
      product: indexData?.product,
      appEnv: process.env.APP_ENV,
    });
    const finalOutput = getFinalDynamicPath(workdir, {
      edition,
      timestamp: jobStartedAt,
    });
    const finalStoragePath = `${storagePrefix}${path.basename(finalOutput)}`;

    console.log(`Recording: ${recId}`);
    console.log(`Bucket: ${bucketName}`);
    console.log(`Prefixo: ${storagePrefix}`);
    console.log(`Manifest: ${manifestStoragePath}`);
    console.log(`Workdir: ${workdir}`);

    await downloadRecordingPrefix(bucket, storagePrefix, workdir);

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`manifest.json nao encontrado no prefixo ${manifestStoragePath}`);
    }

    renderDynamicScenes(workdir, {
      manifestPath,
      finalOutput,
      edition,
      timestamp: jobStartedAt,
    });

    await uploadFinalVideo(bucket, finalOutput, finalStoragePath, recId);
    await publishVideoGeneratedEvent(pubsub, {
      recId,
      file: finalStoragePath,
      status: 200,
      errorMessage: null,
      indexData,
    });

    console.log(`Video final enviado: ${finalStoragePath}`);
  } catch (error) {
    console.error(error.message || error);

    try {
      await publishVideoGeneratedEvent(pubsub, {
        recId,
        file: null,
        status: 500,
        errorMessage: error.message || String(error),
        indexData,
      });
    } catch (publishError) {
      console.error(`Falha ao publicar evento de erro: ${publishError.message || publishError}`);
    }

    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
