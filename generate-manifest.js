const fs = require("fs");
const path = require("path");
const { runCli } = require("./src/cli");
const {
  ensureDir,
  getManifestPath,
  getOutputDir,
  toPosixRelative,
} = require("./src/paths");
const {
  basenameFromStoragePath,
  findFileByBasename,
  findFilesRecursive,
} = require("./src/utils");

function normalizeSource(source) {
  const value = String(source || "").toLowerCase();

  if (value === "camera" || value === "cam") return "camera";
  if (value === "microphone" || value === "mic" || value === "audio") return "microphone";

  if (
    value === "screen" ||
    value === "screenshare" ||
    value === "screen_share" ||
    value === "screen-share"
  ) {
    return "screen_share";
  }

  if (
    value === "screen_share_audio" ||
    value === "screen-share-audio"
  ) {
    return "screen_share_audio";
  }

  return value;
}

function inferFromFilename(fileBaseName, trackId) {
  const withoutExt = fileBaseName.replace(/\.[^.]+$/, "");

  const trackSuffix = `-${trackId}`;
  const trackIndex = withoutExt.lastIndexOf(trackSuffix);

  const beforeTrack =
    trackIndex >= 0 ? withoutExt.slice(0, trackIndex) : withoutExt;

  const parts = beforeTrack.split("-");

  const rawSource = parts.pop() || "unknown";
  const participantIdentity = parts.join("-") || "unknown";

  return {
    participantIdentity,
    source: normalizeSource(rawSource),
  };
}

function inferKind(source, fileBaseName) {
  const ext = path.extname(fileBaseName).toLowerCase();

  if (source === "microphone" || source === "screen_share_audio") {
    return "audio";
  }

  if ([".ogg", ".opus", ".m4a", ".aac", ".mp3", ".wav"].includes(ext)) {
    return "audio";
  }

  return "video";
}

function nsToMs(ns) {
  return Number(ns / 1_000_000n);
}

function isValidTrackEgress(data) {
  return Boolean(
    data &&
      data.started_at &&
      data.ended_at &&
      data.track_id &&
      Array.isArray(data.files) &&
      data.files.length > 0
  );
}

function readJsonIfValid(fullPath, workdir) {
  const jsonFile = toPosixRelative(workdir, fullPath);

  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const data = JSON.parse(raw);

    if (!isValidTrackEgress(data)) {
      console.warn(`Ignorando JSON inválido: ${jsonFile}`);
      return null;
    }

    return { jsonFile, data };
  } catch (error) {
    console.warn(`Ignorando JSON inválido: ${jsonFile} (${error.message})`);
    return null;
  }
}

function main(workdir) {
  const manifestPath = getManifestPath(workdir);

  const jsonFiles = findFilesRecursive(
    workdir,
    (entry) => entry.name.toLowerCase().endsWith(".json")
  );

  if (jsonFiles.length === 0) {
    throw new Error("Nenhum JSON válido de TrackEgress encontrado");
  }

  const egressItems = jsonFiles
    .map((fullPath) => readJsonIfValid(fullPath, workdir))
    .filter(Boolean);

  if (egressItems.length === 0) {
    throw new Error("Nenhum JSON válido de TrackEgress encontrado");
  }

  const recordingStartNs = egressItems.reduce((min, item) => {
    const startedAt = BigInt(item.data.started_at);
    return startedAt < min ? startedAt : min;
  }, BigInt(egressItems[0].data.started_at));

  const recordingEndNs = egressItems.reduce((max, item) => {
    const endedAt = BigInt(item.data.ended_at);
    return endedAt > max ? endedAt : max;
  }, BigInt(egressItems[0].data.ended_at));

  const tracks = [];

  for (const item of egressItems) {
    const data = item.data;
    const fileInfo = data.files[0];

    const fileBaseName = basenameFromStoragePath(
      fileInfo.filename || fileInfo.location
    );

    const localFile = findFileByBasename(workdir, fileBaseName);

    if (!localFile) {
      throw new Error(`Arquivo de mídia não encontrado: ${fileBaseName}`);
    }

    const { participantIdentity, source } = inferFromFilename(
      fileBaseName,
      data.track_id
    );

    const kind = inferKind(source, fileBaseName);

    const startedAtNs = BigInt(data.started_at);
    const endedAtNs = BigInt(data.ended_at);

    const offsetMs = nsToMs(startedAtNs - recordingStartNs);
    const durationMs = nsToMs(endedAtNs - startedAtNs);

    tracks.push({
      jsonFile: item.jsonFile,
      egressId: data.egress_id,
      roomId: data.room_id,
      roomName: data.room_name,
      trackId: data.track_id,
      participantIdentity,
      source,
      kind,
      file: toPosixRelative(workdir, localFile),
      fileName: fileBaseName,
      startedAtNs: String(startedAtNs),
      endedAtNs: String(endedAtNs),
      offsetMs,
      durationMs,
    });
  }

  tracks.sort((a, b) => {
    if (a.offsetMs !== b.offsetMs) return a.offsetMs - b.offsetMs;
    return a.participantIdentity.localeCompare(b.participantIdentity);
  });

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    recordingStartNs: String(recordingStartNs),
    recordingEndNs: String(recordingEndNs),
    durationMs: nsToMs(recordingEndNs - recordingStartNs),
    tracks,
  };

  ensureDir(getOutputDir(workdir));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("Manifest gerado:");
  console.log(manifestPath);
  console.log("");
  console.log(`Tracks totais: ${tracks.length}`);
  console.log(`Vídeos: ${tracks.filter((t) => t.kind === "video").length}`);
  console.log(`Áudios: ${tracks.filter((t) => t.kind === "audio").length}`);
  console.log(`Câmeras: ${tracks.filter((t) => t.source === "camera").length}`);
  console.log(`Microfones: ${tracks.filter((t) => t.source === "microphone").length}`);
  console.log(`Screen shares: ${tracks.filter((t) => t.source === "screen_share").length}`);
}

runCli(main, "generate-manifest.js");
