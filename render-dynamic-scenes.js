const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { runCli } = require("./src/cli");
const {
  ensureDir,
  getFinalDynamicPath,
  getManifestPath,
  getOutputDir,
  resolveWorkdirRelative,
} = require("./src/paths");
const { resolveVideoEdition } = require("./src/video-naming");

const WIDTH = 854;
const HEIGHT = 480;
const FPS = 8;
const MAX_VIDEOS = 16;
const MAX_SCREEN_SHARES = 2;
const FRAME_DURATION_MS = Math.ceil(1000 / FPS);
const FONT_FILE =
  process.env.FONT_FILE ||
  (process.platform === "win32"
    ? "C\\:/Windows/Fonts/arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
const INTRO_SECONDS = 2;
const VIDEO_PRESET = "ultrafast";
const VIDEO_BITRATE = "800k";
const VIDEO_BUFSIZE = "1600k";
const AUDIO_BITRATE = "48k";
const GRID_GAP = 8;
const SCREEN_SHARE_GAP = 8;
const TILE_BACKGROUND = "2f2d38";
const AVATAR_BACKGROUND = "5b5a66";
const AVATAR_CIRCLE = "\u25CF";
const SCENES_DIR = "dynamic-scenes";
const FILTER_FILE = "filter.txt";
const CONCAT_FILE = "concat-list.txt";

function getGrid(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: 4 };
}

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", args, { stdio: "inherit" });

  if (result.error) {
    throw new Error(`Erro ao executar FFmpeg: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`FFmpeg finalizou com status ${result.status || 1}`);
  }
}

function measureMediaDurationMs(localFile) {
  const result = spawnSync(
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
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `Erro ao medir duracao com ffprobe: ${result.error?.message || result.stderr || "status desconhecido"}`
    );
  }

  const durationSeconds = Number(String(result.stdout || "").trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`Duracao invalida retornada pelo ffprobe: ${result.stdout}`);
  }

  return Math.round(durationSeconds * 1000);
}

function measureStreamDurationMs(localFile, streamSelector) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      streamSelector,
      "-show_entries",
      "stream=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      localFile,
    ],
    { encoding: "utf8" }
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `Erro ao medir stream ${streamSelector} com ffprobe: ${
        result.error?.message || result.stderr || "status desconhecido"
      }`
    );
  }

  const durationSeconds = Number(String(result.stdout || "").trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(
      `Duracao invalida da stream ${streamSelector} retornada pelo ffprobe: ${result.stdout}`
    );
  }

  return Math.round(durationSeconds * 1000);
}

function validateMediaDuration(localFile, expectedDurationMs, label) {
  const actualDurationMs = measureMediaDurationMs(localFile);
  const differenceMs = Math.abs(actualDurationMs - expectedDurationMs);
  const diagnostic = {
    label,
    file: localFile,
    expectedDurationMs,
    actualDurationMs,
    differenceMs,
    toleranceMs: FRAME_DURATION_MS,
  };

  console.log("[render-duration]", diagnostic);

  if (differenceMs > FRAME_DURATION_MS) {
    throw new Error(
      `Duracao invalida em ${label}: esperado ${expectedDurationMs}ms, ` +
        `obtido ${actualDurationMs}ms, diferenca ${differenceMs}ms`
    );
  }

  return actualDurationMs;
}

function assertFfmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });

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

function segmentEndMs(segment) {
  return segment.offsetMs + segment.durationMs;
}

function overlaps(startMs, endMs, segment) {
  return segment.offsetMs < endMs && segmentEndMs(segment) > startMs;
}

function compareScreenShareSegments(a, b) {
  if (a.offsetMs !== b.offsetMs) return a.offsetMs - b.offsetMs;

  const identityComparison = String(a.participantIdentity || "").localeCompare(
    String(b.participantIdentity || "")
  );
  if (identityComparison !== 0) return identityComparison;

  return String(a.trackId || "").localeCompare(String(b.trackId || ""));
}

function getScreenShareTiles(count) {
  if (count <= 1) {
    return [{ x: 0, y: 0, w: WIDTH, h: HEIGHT }];
  }

  const tileWidth = Math.floor((WIDTH - SCREEN_SHARE_GAP) / 2);
  return [
    { x: 0, y: 0, w: tileWidth, h: HEIGHT },
    { x: tileWidth + SCREEN_SHARE_GAP, y: 0, w: tileWidth, h: HEIGHT },
  ];
}

function selectScreenShareSegments(segments) {
  const ordered = [...segments].sort(compareScreenShareSegments);
  return {
    selected: ordered.slice(0, MAX_SCREEN_SHARES),
    ignored: ordered.slice(MAX_SCREEN_SHARES),
  };
}

function timelineMsToFrame(valueMs) {
  return Math.round((valueMs * FPS) / 1000);
}

function getSceneRenderDurationMs(scene) {
  const startFrame = timelineMsToFrame(scene.startMs);
  const endFrame = timelineMsToFrame(scene.endMs);
  return Math.max(0, (endFrame - startFrame) * FRAME_DURATION_MS);
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

  return Array.from(byIdentity.values()).map(sortParticipantSegments).sort(compareParticipants);
}

function sortParticipantSegments(participant) {
  return {
    ...participant,
    videoSegments: [...(participant.videoSegments || [])].sort(
      (a, b) => a.offsetMs - b.offsetMs
    ),
    audioSegments: [...(participant.audioSegments || [])].sort(
      (a, b) => a.offsetMs - b.offsetMs
    ),
    screenShareSegments: [...(participant.screenShareSegments || [])].sort(
      (a, b) => a.offsetMs - b.offsetMs
    ),
  };
}

function compareParticipants(a, b) {
  const firstA = getPresence(a)?.startMs ?? Number.MAX_SAFE_INTEGER;
  const firstB = getPresence(b)?.startMs ?? Number.MAX_SAFE_INTEGER;

  if (firstA !== firstB) return firstA - firstB;
  return a.participantIdentity.localeCompare(b.participantIdentity);
}

function getManifestParticipants(manifest) {
  if (Array.isArray(manifest.participants)) {
    return manifest.participants
      .map((participant) =>
        sortParticipantSegments({
          participantIdentity: participant.participantIdentity,
          name: participant.name || participant.participantIdentity,
          avatarFile: participant.avatarFile || "",
          videoSegments: participant.videoSegments || [],
          audioSegments: participant.audioSegments || [],
          screenShareSegments: participant.screenShareSegments || [],
        })
      )
      .sort(compareParticipants);
  }

  return buildParticipantsFromTracks(manifest.tracks);
}

function getPresence(participant) {
  const segments = [
    ...participant.videoSegments,
    ...participant.audioSegments,
    ...participant.screenShareSegments,
  ];

  if (segments.length === 0) {
    return null;
  }

  return {
    startMs: Math.min(...segments.map((segment) => segment.offsetMs)),
    endMs: Math.max(...segments.map((segment) => segmentEndMs(segment))),
  };
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

function ffconcatPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function seconds(ms) {
  return Math.max(0, ms / 1000);
}

function getDynamicDir(workdir) {
  return path.join(getOutputDir(workdir), SCENES_DIR);
}

function makeFilterScript(dir, name, filters) {
  const filePath = path.join(dir, `${name}-${FILTER_FILE}`);
  fs.writeFileSync(filePath, filters.join(";\n"), "utf8");
  return filePath;
}

function encodeVideoArgs(outputFile) {
  return [
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    VIDEO_PRESET,
    "-b:v",
    VIDEO_BITRATE,
    "-maxrate",
    VIDEO_BITRATE,
    "-bufsize",
    VIDEO_BUFSIZE,
    "-pix_fmt",
    "yuv420p",
    "-an",
    outputFile,
  ];
}

function buildParticipantTiles(workdir, participants, cellW, cellH, cols, gap) {
  let avatarInputIndex = 0;

  return participants.map((participant, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const avatarFile = participant.avatarFile
      ? resolveWorkdirRelative(workdir, participant.avatarFile)
      : "";
    const hasAvatarFile = Boolean(avatarFile && fs.existsSync(avatarFile));

    return {
      identity: participant.participantIdentity,
      name: participant.name || participant.participantIdentity,
      initials: initials(participant.name || participant.participantIdentity),
      avatarFile: hasAvatarFile ? avatarFile : "",
      avatarInputIndex: hasAvatarFile ? avatarInputIndex++ : null,
      x: gap + col * (cellW + gap),
      y: gap + row * (cellH + gap),
      w: cellW,
      h: cellH,
    };
  });
}

function buildStaticGridAssets(workdir, sceneDir, sceneIndex, tiles) {
  const suffix = String(sceneIndex).padStart(4, "0");
  const gridPath = path.join(sceneDir, `grid-${suffix}.png`);
  const labelsPath = path.join(sceneDir, `labels-${suffix}.png`);
  const avatarInputs = tiles.filter((tile) => tile.avatarFile).map((tile) => tile.avatarFile);

  const backgroundFilters = [
    `color=c=0x111111:s=${WIDTH}x${HEIGHT}:r=1:d=1[bg0]`,
  ];
  let currentBackground = "bg0";

  tiles.forEach((tile, index) => {
    const out = `bgtile${index}`;
    const avatarSize = Math.max(40, Math.round(Math.min(tile.w, tile.h) * 0.34));
    const avatarX = tile.x + Math.round((tile.w - avatarSize) / 2);
    const avatarY = tile.y + Math.round((tile.h - avatarSize) / 2);
    const initialsFont = Math.max(16, Math.round(avatarSize * 0.38));

    backgroundFilters.push(
      `[${currentBackground}]` +
        `drawbox=x=${tile.x}:y=${tile.y}:w=${tile.w}:h=${tile.h}:color=0x${TILE_BACKGROUND}@1:t=fill,` +
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

  tiles.forEach((tile, index) => {
    if (tile.avatarInputIndex === null) {
      return;
    }

    const avatarSize = Math.max(40, Math.round(Math.min(tile.w, tile.h) * 0.34));
    const avatarX = tile.x + Math.round((tile.w - avatarSize) / 2);
    const avatarY = tile.y + Math.round((tile.h - avatarSize) / 2);
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

  runFfmpeg([
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
  ]);

  const labelFilters = [
    `color=c=black@0.0:s=${WIDTH}x${HEIGHT}:r=1:d=1,format=rgba[label0]`,
  ];
  let currentLabel = "label0";

  tiles.forEach((tile, index) => {
    const out = `labeltile${index}`;
    const labelH = Math.max(20, Math.round(tile.h * 0.11));
    const labelFont = Math.max(10, Math.round(labelH * 0.46));

    labelFilters.push(
      `[${currentLabel}]` +
        `drawbox=x=${tile.x}:y=${
          tile.y + tile.h - labelH
        }:w=${tile.w}:h=${labelH}:color=black@0.55:t=fill,` +
        `drawtext=fontfile='${FONT_FILE}':text='${escapeDrawtext(
          displayName(tile.name)
        )}':x=${tile.x + Math.max(8, Math.round(tile.w * 0.025))}:y=${
          tile.y + tile.h - Math.round(labelH * 0.72)
        }:fontsize=${labelFont}:fontcolor=white:shadowcolor=black:shadowx=1:shadowy=1` +
        `[${out}]`
    );

    currentLabel = out;
  });

  runFfmpeg([
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
  ]);

  return { gridPath, labelsPath };
}

function createSceneParticipants(participants, startMs, endMs) {
  return participants.filter((participant) => {
    const presence = getPresence(participant);
    return presence && presence.startMs < endMs && presence.endMs > startMs;
  });
}

function createScenes(participants, screenShareSegments, durationMs) {
  const points = new Set([0, Math.max(0, Math.round(durationMs))]);

  participants.forEach((participant) => {
    const presence = getPresence(participant);

    if (!presence) {
      return;
    }

    points.add(Math.max(0, Math.round(presence.startMs)));
    points.add(Math.max(0, Math.round(presence.endMs)));
  });

  screenShareSegments.forEach((segment) => {
    points.add(Math.max(0, Math.round(segment.offsetMs)));
    points.add(Math.max(0, Math.round(segmentEndMs(segment))));
  });

  const sorted = [...points].sort((a, b) => a - b);
  const scenes = [];

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const startMs = sorted[index];
    const endMs = sorted[index + 1];

    if (endMs <= startMs) {
      continue;
    }

    const activeScreens = screenShareSegments
      .filter((segment) => overlaps(startMs, endMs, segment))
      .sort(compareScreenShareSegments);
    const participantsInScene = createSceneParticipants(participants, startMs, endMs);
    const kind = activeScreens.length > 0 ? "screen" : "grid";
    const key =
      kind === "screen"
        ? `screen:${activeScreens.map((segment) => segment.trackId).join("|")}`
        : `grid:${participantsInScene
            .map((participant) => participant.participantIdentity)
            .join("|")}`;
    const previous = scenes[scenes.length - 1];

    if (previous && previous.kind === kind && previous.key === key) {
      previous.endMs = endMs;
      continue;
    }

    scenes.push({
      kind,
      key,
      startMs,
      endMs,
      participants: participantsInScene,
      screenShareSegments: activeScreens,
    });
  }

  return scenes;
}

function renderIntroPart(
  sceneDir,
  manifest,
  outputFile = path.join(sceneDir, "part-0000.mp4")
) {
  const filters = [];
  addIntroFilters(filters, manifest, "introbase");
  filters.unshift(
    `color=c=0x111111:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${INTRO_SECONDS}[introbase]`
  );

  const filterScript = makeFilterScript(sceneDir, "intro", filters);

  runFfmpeg([
    "-y",
    "-filter_complex_script",
    filterScript,
    "-map",
    "[vout]",
    "-t",
    String(INTRO_SECONDS),
    ...encodeVideoArgs(outputFile),
  ]);

  validateMediaDuration(outputFile, INTRO_SECONDS * 1000, "intro");

  return outputFile;
}

function renderGridScene(workdir, sceneDir, scene, sceneIndex, videoSegments) {
  const renderDurationMs = getSceneRenderDurationMs(scene);
  const durationSec = seconds(renderDurationMs);
  const { cols, rows } = getGrid(Math.max(1, scene.participants.length));
  const gap = GRID_GAP;
  const cellW = Math.floor((WIDTH - gap * (cols + 1)) / cols);
  const cellH = Math.floor((HEIGHT - gap * (rows + 1)) / rows);
  const tiles = buildParticipantTiles(workdir, scene.participants, cellW, cellH, cols, gap);
  const tileByIdentity = new Map(tiles.map((tile) => [tile.identity, tile]));
  const staticAssets = buildStaticGridAssets(workdir, sceneDir, sceneIndex, tiles);
  const sceneVideos = videoSegments
    .filter((segment) => overlaps(scene.startMs, scene.endMs, segment))
    .filter((segment) => tileByIdentity.has(segment.participantIdentity));
  const inputs = [
    "-loop",
    "1",
    "-i",
    staticAssets.gridPath,
    "-loop",
    "1",
    "-i",
    staticAssets.labelsPath,
    ...sceneVideos.flatMap((segment) => ["-i", absFile(workdir, segment)]),
  ];
  const filters = [`[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT},setsar=1[base]`];
  let current = "base";

  sceneVideos.forEach((segment, index) => {
    const inputIndex = 2 + index;
    const tile = tileByIdentity.get(segment.participantIdentity);
    const startMs = Math.max(scene.startMs, segment.offsetMs);
    const endMs = Math.min(scene.endMs, segmentEndMs(segment));
    const sourceStartSec = seconds(startMs - segment.offsetMs);
    const duration = seconds(endMs - startMs);
    const delay = seconds(startMs - scene.startMs);
    const scaled = `v${index}`;
    const out = `tmp${index}`;

    filters.push(
      `[${inputIndex}:v]` +
        `trim=start=${sourceStartSec}:duration=${duration},` +
        `setpts=PTS-STARTPTS+${delay}/TB,` +
        `scale=${tile.w}:${tile.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `setsar=1,` +
        `pad=${tile.w}:${tile.h}:(ow-iw)/2:(oh-ih)/2:color=black` +
        `[${scaled}]`
    );

    filters.push(
      `[${current}][${scaled}]` +
        `overlay=x=${tile.x}:y=${tile.y}:eof_action=pass:enable='between(t,${delay},${
          delay + duration
        })'` +
        `[${out}]`
    );

    current = out;
  });

  filters.push(`[1:v]fps=${FPS},format=rgba[labels]`);
  filters.push(`[${current}][labels]overlay=x=0:y=0:eof_action=pass[vout]`);

  const filterScript = makeFilterScript(sceneDir, `scene-${sceneIndex}`, filters);
  const outputFile = path.join(
    sceneDir,
    `part-${String(sceneIndex + 1).padStart(4, "0")}.mp4`
  );

  runFfmpeg([
    "-y",
    ...inputs,
    "-filter_complex_script",
    filterScript,
    "-map",
    "[vout]",
    "-t",
    String(durationSec),
    ...encodeVideoArgs(outputFile),
  ]);

  validateMediaDuration(
    outputFile,
    renderDurationMs,
    `scene-${sceneIndex + 1}-grid`
  );

  return outputFile;
}

function renderScreenScene(workdir, sceneDir, scene, sceneIndex) {
  const renderDurationMs = getSceneRenderDurationMs(scene);
  const durationSec = seconds(renderDurationMs);
  const { selected: selectedSegments, ignored: ignoredSegments } =
    selectScreenShareSegments(scene.screenShareSegments);
  const orderedSegments = [...selectedSegments, ...ignoredSegments];
  const tiles = getScreenShareTiles(selectedSegments.length);
  const filters = [
    `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${durationSec}[sharebase]`,
  ];
  let current = "sharebase";

  console.log("[render-screen] scene", {
    sceneIndex: sceneIndex + 1,
    startMs: scene.startMs,
    endMs: scene.endMs,
    manifestDurationMs: scene.endMs - scene.startMs,
    renderDurationMs,
    activeShares: orderedSegments.map((segment) => ({
      participantIdentity: segment.participantIdentity || null,
      trackId: segment.trackId || null,
      offsetMs: segment.offsetMs,
      durationMs: segment.durationMs,
    })),
    selectedTrackIds: selectedSegments.map((segment) => segment.trackId || null),
    ignoredTrackIds: ignoredSegments.map((segment) => segment.trackId || null),
  });

  selectedSegments.forEach((segment, index) => {
    const tile = tiles[index];
    const startMs = Math.max(scene.startMs, segment.offsetMs);
    const sourceStartSec = seconds(startMs - segment.offsetMs);
    const shareLabel = `share${index}`;
    const outputLabel = `sharetmp${index}`;

    console.log("[render-screen] input", {
      index,
      participantIdentity: segment.participantIdentity || null,
      trackId: segment.trackId || null,
      file: segment.file,
      sourceStartSec,
      expectedDurationMs: renderDurationMs,
      tile,
    });

    filters.push(
      `[${index}:v]trim=start=${sourceStartSec}:duration=${durationSec},` +
        `setpts=PTS-STARTPTS,fps=${FPS},` +
        `tpad=stop_mode=clone:stop_duration=${durationSec},` +
        `trim=duration=${durationSec},setpts=PTS-STARTPTS,` +
        `scale=${tile.w}:${tile.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `setsar=1,pad=${tile.w}:${tile.h}:(ow-iw)/2:(oh-ih)/2:color=black` +
        `[${shareLabel}]`
    );
    filters.push(
      `[${current}][${shareLabel}]overlay=x=${tile.x}:y=${tile.y}:eof_action=pass` +
        `[${outputLabel}]`
    );
    current = outputLabel;
  });

  filters.push(`[${current}]trim=duration=${durationSec},setpts=PTS-STARTPTS[vout]`);
  const filterScript = makeFilterScript(sceneDir, `scene-${sceneIndex}`, filters);
  const outputFile = path.join(
    sceneDir,
    `part-${String(sceneIndex + 1).padStart(4, "0")}.mp4`
  );

  runFfmpeg([
    "-y",
    ...selectedSegments.flatMap((segment) => ["-i", absFile(workdir, segment)]),
    "-filter_complex_script",
    filterScript,
    "-map",
    "[vout]",
    "-t",
    String(durationSec),
    ...encodeVideoArgs(outputFile),
  ]);

  validateMediaDuration(
    outputFile,
    renderDurationMs,
    `scene-${sceneIndex + 1}-screen`
  );

  return outputFile;
}

function renderAudio(workdir, sceneDir, audioSegments, outputDurationSec) {
  const outputFile = path.join(sceneDir, "audio.m4a");
  console.log(
    "[render-audio] segments",
    JSON.stringify(
      audioSegments.map((segment) => ({
        source: segment.source || "unknown",
        trackId: segment.trackId || null,
        file: segment.file,
        startedAtNs: segment.startedAtNs || null,
        endedAtNs: segment.endedAtNs || null,
        offsetMs: segment.offsetMs,
        durationMs: segment.durationMs,
      }))
    )
  );
  console.log("[render-audio] segmentCount", audioSegments.length);

  const filters = [
    `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${outputDurationSec},asetpts=PTS-STARTPTS[silence]`,
  ];
  const inputs = [];
  const labels = ["silence"];

  audioSegments.forEach((segment, index) => {
    const inputIndex = index;
    const delayMs = Math.max(0, Math.round(segment.offsetMs + INTRO_SECONDS * 1000));
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

    inputs.push("-i", absFile(workdir, segment));
    filters.push(
      `[${inputIndex}:a]aresample=async=1:first_pts=0,` +
        `asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[${label}]`
    );
    labels.push(label);
  });

  filters.push(
    `${labels.map((label) => `[${label}]`).join("")}` +
      `amix=inputs=${labels.length}:duration=longest:normalize=0,` +
      `atrim=0:${outputDurationSec},asetpts=PTS-STARTPTS[aout]`
  );

  console.log("[render-audio] amix", {
    inputs: ["silence", ...audioSegments.map((segment) => segment.file)],
    labels,
    outputDurationSec,
  });

  const filterScript = makeFilterScript(sceneDir, "audio", filters);

  runFfmpeg([
    "-y",
    ...inputs,
    "-filter_complex_script",
    filterScript,
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    outputFile,
  ]);

  const outputDurationMs = measureMediaDurationMs(outputFile);
  console.log("[render-audio] output", {
    file: outputFile,
    outputDurationMs,
    requestedDurationMs: Math.round(outputDurationSec * 1000),
  });

  return outputFile;
}

function concatVideoParts(sceneDir, parts, expectedDurationMs) {
  const listPath = path.join(sceneDir, CONCAT_FILE);
  const outputFile = path.join(sceneDir, "video-only.mp4");

  fs.writeFileSync(
    listPath,
    parts.map((part) => `file '${ffconcatPath(part)}'`).join("\n") + "\n",
    "utf8"
  );

  runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputFile,
  ]);

  validateMediaDuration(outputFile, expectedDurationMs, "video-concatenado");

  return outputFile;
}

function muxFinal(videoFile, audioFile, finalOutput, expectedDurationMs) {
  runFfmpeg([
    "-y",
    "-i",
    videoFile,
    "-i",
    audioFile,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-shortest",
    finalOutput,
  ]);

  const videoDurationMs = measureStreamDurationMs(finalOutput, "v:0");
  const audioDurationMs = measureStreamDurationMs(finalOutput, "a:0");
  const videoDifferenceMs = Math.abs(videoDurationMs - expectedDurationMs);
  const audioDifferenceMs = Math.abs(audioDurationMs - expectedDurationMs);
  const avDifferenceMs = Math.abs(videoDurationMs - audioDurationMs);

  console.log("[render-final] durations", {
    file: finalOutput,
    expectedDurationMs,
    videoDurationMs,
    audioDurationMs,
    videoDifferenceMs,
    audioDifferenceMs,
    avDifferenceMs,
    toleranceMs: FRAME_DURATION_MS,
  });

  if (
    videoDifferenceMs > FRAME_DURATION_MS ||
    audioDifferenceMs > FRAME_DURATION_MS ||
    avDifferenceMs > FRAME_DURATION_MS
  ) {
    throw new Error(
      `Duracao final invalida: esperado ${expectedDurationMs}ms, ` +
        `video ${videoDurationMs}ms, audio ${audioDurationMs}ms`
    );
  }
}

function main(workdir, options = {}) {
  const manifestPath = options.manifestPath || getManifestPath(workdir);
  const outputDir = getOutputDir(workdir);
  const sceneDir = getDynamicDir(workdir);
  const finalOutput =
    options.finalOutput ||
    getFinalDynamicPath(workdir, {
      edition: resolveVideoEdition({
        edition: options.edition || process.env.VIDEO_EDITION,
        product: options.product || process.env.PRODUCT,
        appEnv: options.appEnv || process.env.APP_ENV,
      }),
      title: options.title,
      includeTitle: Boolean(options.includeTitle),
      timestamp: options.timestamp,
    });

  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json nao encontrado, rode generate-manifest primeiro");
  }

  assertFfmpegAvailable();
  ensureDir(outputDir);
  ensureDir(sceneDir);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestParticipants = getManifestParticipants(manifest);
  const participants = manifestParticipants
    .filter((participant) => getPresence(participant))
    .slice(0, MAX_VIDEOS);
  const videoSegments = [];

  participants.forEach((participant) => {
    participant.videoSegments.forEach((segment) => {
      videoSegments.push({
        ...segment,
        participantIdentity: participant.participantIdentity,
      });
    });
  });

  const audioSegments = manifestParticipants.flatMap(
    (participant) => participant.audioSegments || []
  );
  const screenShareSegments = participants
    .flatMap((participant) =>
      (participant.screenShareSegments || []).map((segment) => ({
        ...segment,
        participantIdentity: participant.participantIdentity,
      }))
    )
    .sort(compareScreenShareSegments);

  const hasUsefulMedia =
    videoSegments.length > 0 ||
    screenShareSegments.length > 0 ||
    audioSegments.length > 0;

  if (!hasUsefulMedia) {
    console.log("Nenhuma midia util no manifest. Gerando fallback intro-only...");
    renderIntroPart(sceneDir, manifest, finalOutput);
    console.log("");
    console.log("Video gerado:");
    console.log(finalOutput);
    return finalOutput;
  }

  const outputDurationSec = manifest.durationMs / 1000 + INTRO_SECONDS;
  const scenes = createScenes(participants, screenShareSegments, manifest.durationMs);
  const parts = [];

  console.log(`Cenas: ${scenes.length}`);
  console.log(`Video bitrate: ${VIDEO_BITRATE}`);
  console.log(`Audio bitrate: ${AUDIO_BITRATE}`);

  console.log("Gerando audio final...");
  const audioFile = renderAudio(workdir, sceneDir, audioSegments, outputDurationSec);

  console.log("Gerando intro...");
  parts.push(renderIntroPart(sceneDir, manifest));

  scenes.forEach((scene, index) => {
    const renderDurationMs = getSceneRenderDurationMs(scene);
    const label = `${String(index + 1).padStart(4, "0")} ${scene.kind} ${seconds(
      scene.endMs - scene.startMs
    ).toFixed(3)}s`;
    console.log(`Gerando cena ${label}...`);

    if (renderDurationMs === 0) {
      console.log("[render-duration] scene skipped below frame resolution", {
        sceneIndex: index + 1,
        kind: scene.kind,
        startMs: scene.startMs,
        endMs: scene.endMs,
        manifestDurationMs: scene.endMs - scene.startMs,
        fps: FPS,
      });
      return;
    }

    if (scene.kind === "screen") {
      parts.push(renderScreenScene(workdir, sceneDir, scene, index));
    } else {
      parts.push(renderGridScene(workdir, sceneDir, scene, index, videoSegments));
    }
  });

  console.log("Concatenando cenas...");
  const expectedOutputDurationMs = Math.round(outputDurationSec * 1000);
  const expectedVideoDurationMs =
    INTRO_SECONDS * 1000 + timelineMsToFrame(manifest.durationMs) * FRAME_DURATION_MS;
  const videoFile = concatVideoParts(sceneDir, parts, expectedVideoDurationMs);

  console.log("Muxando audio final...");
  muxFinal(videoFile, audioFile, finalOutput, expectedOutputDurationMs);

  console.log("");
  console.log("Video gerado:");
  console.log(finalOutput);

  return finalOutput;
}

if (require.main === module) {
  runCli(main, "render-dynamic-scenes.js");
}

module.exports = {
  __test: {
    compareScreenShareSegments,
    createScenes,
    getSceneRenderDurationMs,
    getScreenShareTiles,
    selectScreenShareSegments,
    timelineMsToFrame,
  },
  getFinalDynamicPath,
  main,
};
