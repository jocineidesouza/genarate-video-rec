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

function isAudioExt(fileBaseName) {
  const ext = path.extname(fileBaseName).toLowerCase();
  return [".ogg", ".opus", ".m4a", ".aac", ".mp3", ".wav"].includes(ext);
}

function inferSource(source, trackId, fileBaseName) {
  const normalized = normalizeSource(source);

  if (normalized && normalized !== "unknown") {
    return normalized;
  }

  const track = String(trackId || "").toUpperCase();
  const ext = path.extname(fileBaseName).toLowerCase();

  if (track.startsWith("TR_VC")) return "camera";
  if (track.startsWith("TR_AM")) return "microphone";
  if (ext === ".webm") return "camera";
  if (isAudioExt(fileBaseName)) return "microphone";

  return normalized || "unknown";
}

function inferFromFilename(fileBaseName, trackId) {
  const withoutExt = fileBaseName.replace(/\.[^.]+$/, "");

  const trackSuffix = `-${trackId}`;
  const trackIndex = withoutExt.lastIndexOf(trackSuffix);

  const beforeTrack =
    trackIndex >= 0 ? withoutExt.slice(0, trackIndex) : withoutExt;

  const screenShareSuffix = "-screen-share";
  if (beforeTrack.endsWith(screenShareSuffix)) {
    return {
      participantIdentity:
        beforeTrack.slice(0, -screenShareSuffix.length) || "unknown",
      source: "screen_share",
    };
  }

  const parts = beforeTrack.split("-");

  const rawSource = parts.pop() || "unknown";
  const participantIdentity = parts.join("-") || "unknown";

  return {
    participantIdentity,
    source: inferSource(rawSource, trackId, fileBaseName),
  };
}

function inferKind(source, fileBaseName) {
  if (source === "microphone" || source === "screen_share_audio") {
    return "audio";
  }

  if (isAudioExt(fileBaseName)) {
    return "audio";
  }

  return "video";
}

function toSegment(track) {
  return {
    file: track.file,
    fileName: track.fileName,
    trackId: track.trackId,
    offsetMs: track.offsetMs,
    durationMs: track.durationMs,
    startedAtNs: track.startedAtNs,
    endedAtNs: track.endedAtNs,
  };
}

function buildParticipants(tracks) {
  const byIdentity = new Map();

  for (const track of tracks) {
    const isCamera = track.kind === "video" && track.source === "camera";
    const isMicrophone = track.kind === "audio" && track.source === "microphone";
    const isScreenShare = track.kind === "video" && track.source === "screen_share";

    if (!isCamera && !isMicrophone && !isScreenShare) {
      continue;
    }

    if (!byIdentity.has(track.participantIdentity)) {
      byIdentity.set(track.participantIdentity, {
        participantIdentity: track.participantIdentity,
        name: track.participantIdentity,
        videoSegments: [],
        audioSegments: [],
        screenShareSegments: [],
      });
    }

    const participant = byIdentity.get(track.participantIdentity);

    if (isCamera) {
      participant.videoSegments.push(toSegment(track));
    } else if (isMicrophone) {
      participant.audioSegments.push(toSegment(track));
    } else {
      participant.screenShareSegments.push(toSegment(track));
    }
  }

  const participants = Array.from(byIdentity.values()).map((participant) => ({
    ...participant,
    videoSegments: participant.videoSegments.sort((a, b) => a.offsetMs - b.offsetMs),
    audioSegments: participant.audioSegments.sort((a, b) => a.offsetMs - b.offsetMs),
    screenShareSegments: participant.screenShareSegments.sort(
      (a, b) => a.offsetMs - b.offsetMs
    ),
  }));

  participants.sort((a, b) => {
    const firstA = Math.min(
      ...[
        ...a.videoSegments,
        ...a.audioSegments,
        ...a.screenShareSegments,
      ].map((segment) => segment.offsetMs)
    );
    const firstB = Math.min(
      ...[
        ...b.videoSegments,
        ...b.audioSegments,
        ...b.screenShareSegments,
      ].map((segment) => segment.offsetMs)
    );

    if (firstA !== firstB) return firstA - firstB;
    return a.participantIdentity.localeCompare(b.participantIdentity);
  });

  return participants;
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

  const firstTrack = tracks[0] || {};

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    recordingStartNs: String(recordingStartNs),
    recordingEndNs: String(recordingEndNs),
    durationMs: nsToMs(recordingEndNs - recordingStartNs),
    call: {
      roomId: firstTrack.roomId || "",
      roomName: firstTrack.roomName || "",
      title: firstTrack.roomName || "Untitled meeting",
      description: "",
      recorderBy: "unknown",
      organizedBy: "unknown",
    },
    tracks,
    participants: buildParticipants(tracks),
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
  console.log(`Participantes: ${manifest.participants.length}`);
}

runCli(main, "generate-manifest.js");
