const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCli } = require("./src/cli");
const {
  ensureDir,
  getFinalGridPath,
  getManifestPath,
  getOutputDir,
  resolveWorkdirRelative,
} = require("./src/paths");

const WIDTH = 854;
const HEIGHT = 480;
const FPS = 10;
const MAX_VIDEOS = 16;
const FONT_FILE = "C\\:/Windows/Fonts/arial.ttf";
const INTRO_SECONDS = 2;
const VIDEO_PRESET = "ultrafast";
const VIDEO_CRF = "35";
const AUDIO_BITRATE = "64k";
const GRID_GAP = 8;
const TILE_BACKGROUND = "2f2d38";
const AVATAR_BACKGROUND = "5b5a66";
const AVATAR_CIRCLE = "\u25CF";
const STATIC_GRID_FILE = "grid-background.png";
const STATIC_LABELS_FILE = "grid-labels.png";

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
    source: track.source,
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
    const isScreenShareAudio =
      track.kind === "audio" && track.source === "screen_share_audio";

    if (!isCamera && !isMicrophone && !isScreenShare && !isScreenShareAudio) {
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
    } else if (isMicrophone || isScreenShareAudio) {
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
      avatarFile: participant.avatarFile || "",
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

function escapeDrawtext(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function initials(name) {
  const value = String(name || "unknown")
    .replace(/[_-]+/g, " ")
    .trim();
  const words = value.split(/\s+/).filter(Boolean);

  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  return value.slice(0, 2).toUpperCase() || "?";
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
  const scaleX = (value) => Math.round((value / 1920) * WIDTH);
  const scaleY = (value) => Math.round((value / 1080) * HEIGHT);
  const font = (value) => Math.max(10, Math.round((value / 1080) * HEIGHT));
  const titleY = titleLines.length > 1 ? scaleY(282) : scaleY(326);
  let current = "introbg";

  filters.push(
    `color=c=0x2f2d38:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${INTRO_SECONDS}[introbg]`
  );

  filters.push(
    `[${current}]` +
      `drawtext=fontfile='${FONT_FILE}':text='Ellevo Connect':x=${WIDTH}-${scaleX(
        420
      )}:y=${scaleY(86)}:fontsize=${font(30)}:fontcolor=white@0.9` +
      `[introbrand]`
  );
  current = "introbrand";

  titleLines.forEach((line, index) => {
    const out = `introtitle${index}`;
    filters.push(
      `[${current}]` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          line
        )}':x=${scaleX(130)}:y=${titleY + index * scaleY(
          76
        )}:fontsize=${font(62)}:fontcolor=white` +
        `[${out}]`
    );
    current = out;
  });

  if (metadata.startedAt) {
    filters.push(
      `[${current}]` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          metadata.startedAt
        )}':x=${scaleX(132)}:y=${
          titleY + titleLines.length * scaleY(76) + scaleY(2)
        }:fontsize=${font(28)}:fontcolor=white@0.86` +
        `[introdate]`
    );
    current = "introdate";
  }

  if (metadata.description) {
    filters.push(
      `[${current}]` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          truncate(metadata.description, 92)
        )}':x=${scaleX(132)}:y=${
          titleY + titleLines.length * scaleY(76) + scaleY(48)
        }:fontsize=${font(24)}:fontcolor=white@0.72` +
        `[introdesc]`
    );
    current = "introdesc";
  }

  filters.push(
    `[${current}]` +
      `drawtext=fontfile='${FONT_FILE}':text='Recorded by':x=${scaleX(
        132
      )}:y=${scaleY(700)}:fontsize=${font(15)}:fontcolor=white@0.55,` +
      `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
        metadata.recorderBy
      )}':x=${scaleX(132)}:y=${scaleY(730)}:fontsize=${font(
        27
      )}:fontcolor=white@0.92,` +
      `drawtext=fontfile='${FONT_FILE}':text='Organized by':x=${scaleX(
        132
      )}:y=${scaleY(820)}:fontsize=${font(15)}:fontcolor=white@0.55,` +
      `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
        metadata.organizedBy
      )}':x=${scaleX(132)}:y=${scaleY(850)}:fontsize=${font(
        27
      )}:fontcolor=white@0.92` +
      `[intro]`
  );

  filters.push(`[${baseLabel}][intro]overlay=x=0:y=0:eof_action=pass[vout]`);
}

function renderIntroOnly(workdir, manifest, finalOutput) {
  const outputDir = getOutputDir(workdir);
  const filters = [];

  filters.unshift(
    `color=c=0x111111:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${INTRO_SECONDS}[introbase]`
  );
  addIntroFilters(filters, manifest, "introbase");

  const filterScript = makeFilterScript(outputDir, "intro-only", filters);

  runFfmpeg([
    "-y",
    "-filter_complex_script",
    filterScript,
    "-map",
    "[vout]",
    "-t",
    String(INTRO_SECONDS),
    ...encodeVideoArgs(finalOutput),
  ]);

  return finalOutput;
}

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", args, {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function buildStaticGridAssets(workdir, participantTiles, cellW, cellH) {
  const outputDir = getOutputDir(workdir);
  const gridPath = path.join(outputDir, STATIC_GRID_FILE);
  const labelsPath = path.join(outputDir, STATIC_LABELS_FILE);
  const avatarInputs = participantTiles
    .filter((tile) => tile.avatarFile)
    .map((tile) => tile.avatarFile);

  const backgroundFilters = [
    `color=c=0x111111:s=${WIDTH}x${HEIGHT}:r=1:d=1[bg0]`,
  ];
  let currentBackground = "bg0";

  participantTiles.forEach((tile, index) => {
    const out = `bgtile${index}`;
    const avatarSize = Math.max(40, Math.round(Math.min(cellW, cellH) * 0.34));
    const avatarX = tile.x + Math.round((cellW - avatarSize) / 2);
    const avatarY = tile.y + Math.round((cellH - avatarSize) / 2);
    const initialsFont = Math.max(16, Math.round(avatarSize * 0.38));

    backgroundFilters.push(
      `[${currentBackground}]` +
        `drawbox=x=${tile.x}:y=${tile.y}:w=${cellW}:h=${cellH}:color=0x${TILE_BACKGROUND}@1:t=fill,` +
        `drawtext=fontfile='${FONT_FILE}':text='${AVATAR_CIRCLE}':x=${avatarX}+(${avatarSize}-text_w)/2:y=${avatarY}+(${avatarSize}-text_h)/2:fontsize=${Math.round(
          avatarSize * 1.2
        )}:fontcolor=0x${AVATAR_BACKGROUND},` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          tile.initials
        )}':x=${avatarX}+(${avatarSize}-text_w)/2:y=${avatarY}+(${avatarSize}-text_h)/2:fontsize=${initialsFont}:fontcolor=white@0.95` +
        `[${out}]`
    );

    currentBackground = out;
  });

  participantTiles.forEach((tile, index) => {
    if (tile.avatarInputIndex === null) {
      return;
    }

    const avatarSize = Math.max(40, Math.round(Math.min(cellW, cellH) * 0.34));
    const avatarX = tile.x + Math.round((cellW - avatarSize) / 2);
    const avatarY = tile.y + Math.round((cellH - avatarSize) / 2);
    const avatarLabel = `bgavatar${index}`;
    const out = `bgwithavatar${index}`;

    backgroundFilters.push(
      `[${tile.avatarInputIndex}:v]` +
        `scale=${avatarSize}:${avatarSize}:force_original_aspect_ratio=increase:force_divisible_by=2,` +
        `crop=${avatarSize}:${avatarSize},setsar=1` +
        `[${avatarLabel}]`
    );

    backgroundFilters.push(
      `[${currentBackground}][${avatarLabel}]overlay=x=${avatarX}:y=${avatarY}:eof_action=pass[${out}]`
    );

    currentBackground = out;
  });

  const backgroundArgs = [
    "-y",
    ...avatarInputs.flatMap((avatarFile) => ["-i", avatarFile]),
    "-filter_complex",
    backgroundFilters.join(";"),
    "-map",
    `[${currentBackground}]`,
    "-frames:v",
    "1",
    "-update",
    "1",
    gridPath,
  ];

  const labelFilters = [
    `color=c=black@0.0:s=${WIDTH}x${HEIGHT}:r=1:d=1,format=rgba[label0]`,
  ];
  let currentLabel = "label0";

  participantTiles.forEach((tile, index) => {
    const out = `labeltile${index}`;
    const escapedName = escapeDrawtext(displayName(tile.name));
    const labelH = Math.max(20, Math.round(cellH * 0.11));
    const labelFont = Math.max(10, Math.round(labelH * 0.48));

    labelFilters.push(
      `[${currentLabel}]` +
        `drawbox=x=${tile.x}:y=${
          tile.y + cellH - labelH
        }:w=${cellW}:h=${labelH}:color=black@0.55:t=fill,` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapedName}':x=${
          tile.x + Math.max(8, Math.round(cellW * 0.025))
        }:y=${
          tile.y + cellH - Math.round(labelH * 0.72)
        }:fontsize=${labelFont}:fontcolor=white:shadowcolor=black:shadowx=1:shadowy=1` +
        `[${out}]`
    );

    currentLabel = out;
  });

  const labelArgs = [
    "-y",
    "-filter_complex",
    labelFilters.join(";"),
    "-map",
    `[${currentLabel}]`,
    "-frames:v",
    "1",
    "-update",
    "1",
    labelsPath,
  ];

  console.log("Gerando imagens estaticas do grid...");
  runFfmpeg(backgroundArgs);
  runFfmpeg(labelArgs);

  return { gridPath, labelsPath };
}

function main(workdir) {
  const manifestPath = getManifestPath(workdir);
  const finalOutput = getFinalGridPath(workdir);
  const outputDir = getOutputDir(workdir);

  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json nao encontrado, rode generate-manifest primeiro");
  }

  assertFfmpegAvailable();
  ensureDir(outputDir);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestParticipants = getManifestParticipants(manifest);

  const videoParticipants = manifestParticipants
    .filter(
      (participant) =>
        participant.videoSegments.length > 0 ||
        participant.audioSegments.length > 0 ||
        participant.screenShareSegments.length > 0
    )
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

  const hasUsefulMedia =
    videoSegments.length > 0 ||
    screenShareSegments.length > 0 ||
    audioSegments.length > 0;

  if (!hasUsefulMedia) {
    console.log("Nenhuma midia util no manifest. Gerando fallback intro-only...");
    renderIntroOnly(workdir, manifest, finalOutput);
    console.log("");
    console.log("Video gerado:");
    console.log(finalOutput);
    return finalOutput;
  }

  const { cols, rows } = getGrid(Math.max(1, videoParticipants.length));

  const gap = GRID_GAP;
  const cellW = Math.floor((WIDTH - gap * (cols + 1)) / cols);
  const cellH = Math.floor((HEIGHT - gap * (rows + 1)) / rows);

  const filters = [];
  const outputDurationSec = manifest.durationMs / 1000 + INTRO_SECONDS;

  const participantTiles = [];
  let avatarInputIndex = 0;
  videoParticipants.forEach((participant, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const avatarFile = participant.avatarFile
      ? resolveWorkdirRelative(workdir, participant.avatarFile)
      : "";
    const hasAvatarFile = Boolean(avatarFile && fs.existsSync(avatarFile));

    participantTiles.push({
      identity: participant.participantIdentity,
      name: participant.name || participant.participantIdentity,
      initials: initials(participant.name || participant.participantIdentity),
      avatarFile: hasAvatarFile ? avatarFile : "",
      avatarInputIndex: hasAvatarFile ? avatarInputIndex++ : null,
      x: gap + col * (cellW + gap),
      y: gap + row * (cellH + gap),
    });
  });

  const staticAssets = buildStaticGridAssets(workdir, participantTiles, cellW, cellH);
  const inputs = [
    "-loop",
    "1",
    "-i",
    staticAssets.gridPath,
    "-loop",
    "1",
    "-i",
    staticAssets.labelsPath,
  ];
  const videoInputStart = 2;

  for (const segment of videoSegments) {
    inputs.push("-i", absFile(workdir, segment));
  }

  for (const segment of screenShareSegments) {
    inputs.push("-i", absFile(workdir, segment));
  }

  for (const segment of audioSegments) {
    inputs.push("-i", absFile(workdir, segment));
  }

  let currentVideoBase = "base";

  filters.push(`[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT},setsar=1[base]`);

  videoSegments.forEach((segment, index) => {
    const delaySec = segment.offsetMs / 1000 + INTRO_SECONDS;
    const endSec = (segment.offsetMs + segment.durationMs) / 1000 + INTRO_SECONDS;
    const scaled = `v${index}`;
    const out = `tmpv${index}`;
    const tile = participantTiles[segment.participantIndex];

    filters.push(
      `[${videoInputStart + index}:v]` +
        `setpts=PTS-STARTPTS+${delaySec}/TB,` +
        `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `setsar=1,` +
        `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=black` +
        `[${scaled}]`
    );

    filters.push(
      `[${currentVideoBase}][${scaled}]` +
        `overlay=x=${tile.x}:y=${tile.y}:eof_action=pass:enable='between(t,${delaySec},${endSec})'` +
        `[${out}]`
    );

    currentVideoBase = out;
  });

  filters.push(`[1:v]fps=${FPS},format=rgba[labels]`);
  filters.push(`[${currentVideoBase}][labels]overlay=x=0:y=0:eof_action=pass[gridwithlabels]`);

  let currentOutputBase = "gridwithlabels";
  const screenShareInputStart = videoInputStart + videoSegments.length;

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
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
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
  const audioInputStart =
    videoInputStart + videoSegments.length + screenShareSegments.length;

  console.log("[render-audio] segmentCount", audioSegments.length);

  if (audioSegments.length > 0) {
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,` +
        `atrim=0:${outputDurationSec},asetpts=PTS-STARTPTS[silence]`
    );
    audioLabels.push("silence");
  }

  audioSegments.forEach((segment, index) => {
    const inputIndex = audioInputStart + index;
    const delayMs = Math.max(
      0,
      Math.round(segment.offsetMs + INTRO_SECONDS * 1000)
    );
    const label = `a${index}`;

    console.log("[render-audio] input", {
      index,
      source: segment.source || "unknown",
      trackId: segment.trackId || null,
      file: segment.file,
      offsetMs: segment.offsetMs,
      durationMs: segment.durationMs,
      delayMs,
    });

    filters.push(
      `[${inputIndex}:a]` +
        `aresample=async=1:first_pts=0,` +
        `asetpts=PTS-STARTPTS,` +
        `adelay=${delayMs}|${delayMs}` +
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
    console.log("[render-audio] amix", {
      inputs: ["silence", ...audioSegments.map((segment) => segment.file)],
      labels: audioLabels,
      outputDurationSec,
    });

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
    VIDEO_PRESET,
    "-crf",
    VIDEO_CRF,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
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
