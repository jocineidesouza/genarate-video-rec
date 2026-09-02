const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require("firebase-admin");
const { PubSub } = require("@google-cloud/pubsub");
const { execFileSync } = require("node:child_process");
const { main: renderDynamicScenes } = require("./render-dynamic-scenes");
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

function getRenderExecutionId() {
  return normalizeText(process.env.RENDER_EXECUTION_ID) || `render-${Date.now()}`;
}

function measureVideoDurationMs(localFile) {
  const output = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      localFile,
    ],
    { encoding: "utf8" }
  ).trim();
  const durationSeconds = Number(output);

  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`Duracao invalida no video final: ${output}`);
  }

  return Math.round(durationSeconds * 1000);
}

async function loadRecordingIndex(db, recId) {
  const snap = await db.doc(`LIVEKIT_EGRESS_INDEX/${recId}`).get();

  if (!snap.exists) {
    throw new Error(`LIVEKIT_EGRESS_INDEX/${recId} nao encontrado`);
  }

  return snap.data() || {};
}

function resolveRecordingStorage(indexData, recId) {
  const bucketName = normalizeBucketName(indexData.bucketName || indexData.storageBucket);
  const storagePrefix = normalizeStoragePrefix(indexData.filepath || indexData.outputPrefix);

  if (!bucketName) {
    throw new Error("Bucket da gravacao nao encontrado em LIVEKIT_EGRESS_INDEX");
  }

  if (!storagePrefix) {
    throw new Error("Prefixo da gravacao nao encontrado em LIVEKIT_EGRESS_INDEX");
  }

  if (normalizeText(indexData.mode) !== "track") {
    throw new Error("A gravacao nao esta no modo track");
  }

  if (normalizeText(indexData.manifestStatus) !== "ready") {
    throw new Error("O manifesto da gravacao ainda nao esta pronto");
  }

  const manifestSegments = `${storagePrefix}manifest.json`.split("/").filter(Boolean);
  const [vertical, slug, feature, artifactType, entityId, artifactId, fileName] = manifestSegments;
  const callId = normalizeText(indexData.callId);
  if (
    feature !== "call" ||
    artifactType !== "recordings" ||
    entityId !== callId ||
    artifactId !== recId ||
    fileName !== "manifest.json"
  ) {
    throw new Error("Prefixo da gravacao nao corresponde ao indice canonico");
  }

  return {
    bucketName,
    storagePrefix,
    manifestStoragePath: `${storagePrefix}manifest.json`,
    vertical,
    slug,
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
    if (!relative || relative === "final.mp4") continue;

    const destination = path.join(workdir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await file.download({ destination });
    console.log(`Baixado: ${file.name}`);
  }
}

async function uploadFinalVideo(bucket, localFile, finalStoragePath, { recId, indexData }) {
  if (!fs.existsSync(localFile)) {
    throw new Error(`Video final nao encontrado: ${localFile}`);
  }

  const videoSizeBytes = fs.statSync(localFile).size;
  const callId = normalizeText(indexData?.callId);
  const roomId = normalizeText(indexData?.roomId || indexData?.room_id);
  await bucket.upload(localFile, {
    destination: finalStoragePath,
    metadata: {
      contentType: "video/mp4",
      metadata: {
        recId,
        vertical: normalizeText(indexData?.vertical),
        slug: normalizeText(indexData?.slug),
        feature: "call",
        artifactType: "recordings",
        entityId: callId,
        artifactId: recId,
        producer: "recording-render-job",
        objectRole: "rendered-video",
        callId,
        recordingId: recId,
        ...(roomId ? { roomId } : {}),
      },
    },
    resumable: false,
  });

  return videoSizeBytes;
}

async function publishVideoGeneratedEvent(
  pubsub,
  {
    recId,
    file,
    status,
    errorMessage,
    indexData,
    renderExecutionId,
    renderStartedAt,
    renderFinishedAt,
    renderDurationMs,
    videoDurationMs,
    videoSizeBytes,
  }
) {
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
      renderExecutionId: renderExecutionId || null,
      renderStartedAt: renderStartedAt || null,
      renderFinishedAt: renderFinishedAt || null,
      renderDurationMs: Number.isFinite(renderDurationMs) ? renderDurationMs : null,
      videoDurationMs: Number.isFinite(videoDurationMs) ? videoDurationMs : null,
      videoSizeBytes: Number.isFinite(videoSizeBytes) ? videoSizeBytes : null,
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
  const renderExecutionId = getRenderExecutionId();
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
    const { bucketName, storagePrefix, manifestStoragePath } = resolveRecordingStorage(indexData, recId);
    const bucket = storage.bucket(bucketName);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `render-${recId}-`));
    const manifestPath = path.join(workdir, "manifest.json");
    const edition = resolveVideoEdition({
      edition: process.env.VIDEO_EDITION,
      product: indexData?.product,
      appEnv: process.env.APP_ENV,
    });
    const finalOutput = path.join(workdir, "final.mp4");
    const finalStoragePath = `${storagePrefix}final.mp4`;

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

    const videoDurationMs = measureVideoDurationMs(finalOutput);
    const videoSizeBytes = await uploadFinalVideo(bucket, finalOutput, finalStoragePath, {
      recId,
      indexData,
    });
    const renderFinishedAt = new Date();
    await publishVideoGeneratedEvent(pubsub, {
      recId,
      file: finalStoragePath,
      status: 200,
      errorMessage: null,
      indexData,
      renderExecutionId,
      renderStartedAt: jobStartedAt.toISOString(),
      renderFinishedAt: renderFinishedAt.toISOString(),
      renderDurationMs: renderFinishedAt.getTime() - jobStartedAt.getTime(),
      videoDurationMs,
      videoSizeBytes,
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
        renderExecutionId,
        renderStartedAt: jobStartedAt.toISOString(),
        renderFinishedAt: new Date().toISOString(),
        renderDurationMs: Date.now() - jobStartedAt.getTime(),
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
