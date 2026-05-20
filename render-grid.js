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
    throw new Error("FFmpeg não encontrado no PATH");
  }
}

function absFile(workdir, track) {
  return resolveWorkdirRelative(workdir, track.file);
}

function main(workdir) {
  const manifestPath = getManifestPath(workdir);
  const finalOutput = getFinalGridPath(workdir);

  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json não encontrado, rode generate-manifest primeiro");
  }

  assertFfmpegAvailable();

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const cameraTracks = manifest.tracks
    .filter((track) => track.kind === "video" && track.source === "camera")
    .slice(0, MAX_VIDEOS);

  const audioTracks = manifest.tracks
    .filter((track) => track.kind === "audio" && track.source === "microphone");

  if (cameraTracks.length === 0) {
    throw new Error("Nenhuma câmera encontrada no manifest.");
  }

  const inputs = [];

  for (const track of cameraTracks) {
    inputs.push("-i", absFile(workdir, track));
  }

  for (const track of audioTracks) {
    inputs.push("-i", absFile(workdir, track));
  }

  const { cols, rows } = getGrid(cameraTracks.length);

  const cellW = Math.floor(WIDTH / cols);
  const cellH = Math.floor(HEIGHT / rows);

  const filters = [];

  filters.push(
    `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${manifest.durationMs / 1000}[base]`
  );

  let currentVideoBase = "base";

  cameraTracks.forEach((track, index) => {
    const delaySec = track.offsetMs / 1000;
    const scaled = `v${index}`;
    const out = index === cameraTracks.length - 1 ? "vout" : `tmpv${index}`;

    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * cellW;
    const y = row * cellH;

    filters.push(
      `[${index}:v]` +
        `setpts=PTS-STARTPTS+${delaySec}/TB,` +
        `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,` +
        `crop=${cellW}:${cellH},` +
        `setsar=1` +
        `[${scaled}]`
    );

    filters.push(
      `[${currentVideoBase}][${scaled}]overlay=x=${x}:y=${y}:eof_action=pass[${out}]`
    );

    currentVideoBase = out;
  });

  const audioLabels = [];
  const audioInputStart = cameraTracks.length;

  audioTracks.forEach((track, index) => {
    const inputIndex = audioInputStart + index;
    const delayMs = Math.max(0, Math.round(track.offsetMs));
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
        `atrim=0:${manifest.durationMs / 1000},` +
        `asetpts=PTS-STARTPTS` +
        `[aout]`
    );

    // Recria args porque adicionamos filtro de áudio depois.
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
    String(manifest.durationMs / 1000),
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

  console.log("Gerando vídeo...");
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
  console.log("Vídeo gerado:");
  console.log(finalOutput);
}

runCli(main, "render-grid.js");
