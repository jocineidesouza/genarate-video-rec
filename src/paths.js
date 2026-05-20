const fs = require("fs");
const path = require("path");

function getOutputDir(workdir) {
  return path.join(workdir, "output");
}

function getManifestPath(workdir) {
  return path.join(getOutputDir(workdir), "manifest.json");
}

function getFinalGridPath(workdir) {
  return path.join(getOutputDir(workdir), "final-grid.mp4");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function toPosixRelative(fromDir, targetPath) {
  return path.relative(fromDir, targetPath).replace(/\\/g, "/");
}

function resolveWorkdirRelative(workdir, relativePath) {
  return path.join(workdir, ...String(relativePath).split("/"));
}

function isInsideOutput(workdir, targetPath) {
  const outputDir = getOutputDir(workdir);
  const relative = path.relative(outputDir, targetPath);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

module.exports = {
  ensureDir,
  getFinalGridPath,
  getManifestPath,
  getOutputDir,
  isInsideOutput,
  resolveWorkdirRelative,
  toPosixRelative,
};
