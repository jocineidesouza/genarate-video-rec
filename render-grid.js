const fs = require("fs");
const { spawnSync } = require("child_process");
const { runCli } = require("./src/cli");
const {
  getFinalGridPath,
  getManifestPath,
  resolveWorkdirRelative,
} = require("./src/paths");

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const MAX_VIDEOS = 16;
const FONT_FILE = "C\\:/Windows/Fonts/arial.ttf";
const INTRO_SECONDS = 2;

function getGrid(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: 4 };
}

function assertFfmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], {
    stdio: "ignore",
  });

  if (result.error || result.status !== 0) {
    throw new Error("FFmpeg nao encontrado no PATH");
  }
}

function absFile(workdir, segment) {
  return resolveWorkdirRelative(workdir, segment.file);
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

function buildParticipantsFromTracks(tracks) {
  const byIdentity = new Map();

  for (const track of tracks || []) {
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

function getManifestParticipants(manifest) {
  if (Array.isArray(manifest.participants)) {
    return manifest.participants.map((participant) => ({
      participantIdentity: participant.participantIdentity,
      name: participant.name || participant.participantIdentity,
      videoSegments: [...(participant.videoSegments || [])].sort(
        (a, b) => a.offsetMs - b.offsetMs
      ),
      audioSegments: [...(participant.audioSegments || [])].sort(
        (a, b) => a.offsetMs - b.offsetMs
      ),
      screenShareSegments: [...(participant.screenShareSegments || [])].sort(
        (a, b) => a.offsetMs - b.offsetMs
      ),
    }));
  }

  return buildParticipantsFromTracks(manifest.tracks);
}

function displayName(name) {
  const value = String(name || "unknown");
  return value.length > 34 ? `${value.slice(0, 31)}...` : value;
}

function participantColor(identity) {
  const palette = [
    "1f4e5f",
    "2f4858",
    "3d405b",
    "31572c",
    "5a3e36",
    "4c3a70",
    "26547c",
    "6d597a",
  ];
  const value = String(identity || "unknown");
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return palette[hash % palette.length];
}

function escapeDrawtext(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function splitTitle(title) {
  const text = String(title || "Untitled meeting").trim();
  const maxLineLength = 48;
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (next.length <= maxLineLength || current.length === 0) {
      current = next;
      continue;
    }

    lines.push(current);
    current = word;

    if (lines.length === 1) {
      break;
    }
  }

  if (current && lines.length < 2) {
    lines.push(current);
  }

  return lines.length > 0
    ? lines.map((line) => truncate(line, 58))
    : ["Untitled meeting"];
}

function formatUtcFromNs(ns) {
  if (!ns) return "";

  const millis = Number(BigInt(ns) / 1_000_000n);
  const date = new Date(millis);

  if (Number.isNaN(date.getTime())) return "";

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

function getCallMetadata(manifest) {
  const call = manifest.call || {};
  const firstTrack = Array.isArray(manifest.tracks) ? manifest.tracks[0] || {} : {};

  return {
    title: call.title || firstTrack.roomName || "Untitled meeting",
    description: call.description || "",
    recorderBy: call.recorderBy || call.recordedBy || "unknown",
    organizedBy: call.organizedBy || call.OrganizedBy || "unknown",
    startedAt: formatUtcFromNs(manifest.recordingStartNs),
  };
}

function addIntroFilters(filters, manifest, baseLabel) {
  const metadata = getCallMetadata(manifest);
  const titleLines = splitTitle(metadata.title);
  const titleY = titleLines.length > 1 ? 282 : 326;
  let current = "introbg";

  filters.push(
    `color=c=0x2f2d38:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${INTRO_SECONDS}[introbg]`
  );

  filters.push(
    `[${current}]` +
      `drawtext=fontfile='${FONT_FILE}':text='Ellevo Connect':x=${WIDTH}-420:y=86:fontsize=30:fontcolor=white@0.9` +
      `[introbrand]`
  );
  current = "introbrand";

  titleLines.forEach((line, index) => {
    const out = `introtitle${index}`;
    filters.push(
      `[${current}]` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          line
        )}':x=130:y=${titleY + index * 76}:fontsize=62:fontcolor=white` +
        `[${out}]`
    );
    current = out;
  });

  if (metadata.startedAt) {
    filters.push(
      `[${current}]` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          metadata.startedAt
        )}':x=132:y=${titleY + titleLines.length * 76 + 2}:fontsize=28:fontcolor=white@0.86` +
        `[introdate]`
    );
    current = "introdate";
  }

  if (metadata.description) {
    filters.push(
      `[${current}]` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          truncate(metadata.description, 92)
        )}':x=132:y=${titleY + titleLines.length * 76 + 48}:fontsize=24:fontcolor=white@0.72` +
        `[introdesc]`
    );
    current = "introdesc";
  }

  filters.push(
    `[${current}]` +
      `drawtext=fontfile='${FONT_FILE}':text='Recorded by':x=132:y=760:fontsize=15:fontcolor=white@0.55,` +
      `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
        truncate(metadata.recorderBy, 38)
      )}':x=132:y=788:fontsize=27:fontcolor=white@0.92,` +
      `drawtext=fontfile='${FONT_FILE}':text='Organized by':x=520:y=760:fontsize=15:fontcolor=white@0.55,` +
      `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
        truncate(metadata.organizedBy, 38)
      )}':x=520:y=788:fontsize=27:fontcolor=white@0.92` +
      `[intro]`
  );

  filters.push(`[${baseLabel}][intro]overlay=x=0:y=0:eof_action=pass[vout]`);
}

function main(workdir) {
  const manifestPath = getManifestPath(workdir);
  const finalOutput = getFinalGridPath(workdir);

  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json nao encontrado, rode generate-manifest primeiro");
  }

  assertFfmpegAvailable();

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestParticipants = getManifestParticipants(manifest);

  const videoParticipants = manifestParticipants
    .filter((participant) => participant.videoSegments.length > 0)
    .slice(0, MAX_VIDEOS);

  const videoSegments = [];
  videoParticipants.forEach((participant, participantIndex) => {
    for (const segment of participant.videoSegments) {
      videoSegments.push({
        ...segment,
        participantIndex,
      });
    }
  });

  const audioSegments = manifestParticipants.flatMap(
    (participant) => participant.audioSegments || []
  );
  const screenShareSegments = manifestParticipants
    .flatMap((participant) => participant.screenShareSegments || [])
    .sort((a, b) => a.offsetMs - b.offsetMs);

  if (videoSegments.length === 0 && screenShareSegments.length === 0) {
    throw new Error("Nenhum video encontrado no manifest.");
  }

  const inputs = [];

  for (const segment of videoSegments) {
    inputs.push("-i", absFile(workdir, segment));
  }

  for (const segment of screenShareSegments) {
    inputs.push("-i", absFile(workdir, segment));
  }

  for (const segment of audioSegments) {
    inputs.push("-i", absFile(workdir, segment));
  }

  const { cols, rows } = getGrid(Math.max(1, videoParticipants.length));

  const cellW = Math.floor(WIDTH / cols);
  const cellH = Math.floor(HEIGHT / rows);

  const filters = [];
  const outputDurationSec = manifest.durationMs / 1000 + INTRO_SECONDS;

  filters.push(
    `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${outputDurationSec}[base]`
  );

  const participantTiles = [];
  videoParticipants.forEach((participant, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    participantTiles.push({
      identity: participant.participantIdentity,
      name: participant.name || participant.participantIdentity,
      x: col * cellW,
      y: row * cellH,
    });
  });

  let currentVideoBase = "base";

  participantTiles.forEach((tile, index) => {
    const out = `tmptile${index}`;

    filters.push(
      `[${currentVideoBase}]` +
        `drawbox=x=${tile.x}:y=${tile.y}:w=${cellW}:h=${cellH}:color=0x${participantColor(
          tile.identity
        )}@1:t=fill` +
        `[${out}]`
    );

    currentVideoBase = out;
  });

  videoSegments.forEach((segment, index) => {
    const delaySec = segment.offsetMs / 1000 + INTRO_SECONDS;
    const endSec = (segment.offsetMs + segment.durationMs) / 1000 + INTRO_SECONDS;
    const scaled = `v${index}`;
    const out = `tmpv${index}`;

    const col = segment.participantIndex % cols;
    const row = Math.floor(segment.participantIndex / cols);
    const x = col * cellW;
    const y = row * cellH;

    filters.push(
      `[${index}:v]` +
        `setpts=PTS-STARTPTS+${delaySec}/TB,` +
        `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,` +
        `setsar=1,` +
        `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black` +
        `[${scaled}]`
    );

    filters.push(
      `[${currentVideoBase}][${scaled}]` +
        `overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${delaySec},${endSec})'` +
        `[${out}]`
    );

    currentVideoBase = out;
  });

  participantTiles.forEach((tile, index) => {
    const out = `tmpname${index}`;
    const escapedName = escapeDrawtext(displayName(tile.name));

    filters.push(
      `[${currentVideoBase}]` +
        `drawbox=x=${tile.x}:y=${tile.y + cellH - 56}:w=${cellW}:h=56:color=black@0.55:t=fill,` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapedName}':x=${tile.x + 24}:y=${tile.y + cellH - 40}:fontsize=28:fontcolor=white:shadowcolor=black:shadowx=1:shadowy=1` +
        `[${out}]`
    );

    currentVideoBase = out;
  });

  let currentOutputBase = currentVideoBase;
  const screenShareInputStart = videoSegments.length;

  screenShareSegments.forEach((segment, index) => {
    const inputIndex = screenShareInputStart + index;
    const delaySec = segment.offsetMs / 1000 + INTRO_SECONDS;
    const endSec = (segment.offsetMs + segment.durationMs) / 1000 + INTRO_SECONDS;
    const fitted = `ss${index}`;
    const padded = `ssp${index}`;
    const out = `tmpss${index}`;

    filters.push(
      `[${inputIndex}:v]` +
        `setpts=PTS-STARTPTS+${delaySec}/TB,` +
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
        `setsar=1` +
        `[${fitted}]`
    );

    filters.push(
      `[${fitted}]` +
        `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black` +
        `[${padded}]`
    );

    filters.push(
      `[${currentOutputBase}][${padded}]` +
        `overlay=x=0:y=0:eof_action=pass:enable='between(t,${delaySec},${endSec})'` +
        `[${out}]`
    );

    currentOutputBase = out;
  });

  addIntroFilters(filters, manifest, currentOutputBase);

  const audioLabels = [];
  const audioInputStart = videoSegments.length + screenShareSegments.length;

  audioSegments.forEach((segment, index) => {
    const inputIndex = audioInputStart + index;
    const delayMs = Math.max(
      0,
      Math.round(segment.offsetMs + INTRO_SECONDS * 1000)
    );
    const label = `a${index}`;

    filters.push(
      `[${inputIndex}:a]` +
        `asetpts=PTS-STARTPTS,` +
        `adelay=${delayMs}|${delayMs},` +
        `apad` +
        `[${label}]`
    );

    audioLabels.push(label);
  });

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
  ];

  if (audioLabels.length > 0) {
    filters.push(
      `${audioLabels.map((label) => `[${label}]`).join("")}` +
        `amix=inputs=${audioLabels.length}:duration=longest:normalize=0,` +
        `atrim=0:${outputDurationSec},` +
        `asetpts=PTS-STARTPTS` +
        `[aout]`
    );

    args.length = 0;

    args.push(
      "-y",
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[vout]",
      "-map",
      "[aout]"
    );
  }

  args.push(
    "-t",
    String(outputDurationSec),
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    finalOutput
  );

  console.log("Gerando video...");
  console.log("");
  console.log("ffmpeg " + args.join(" "));
  console.log("");

  const result = spawnSync("ffmpeg", args, {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  console.log("");
  console.log("Video gerado:");
  console.log(finalOutput);
}

runCli(main, "render-grid.js");
