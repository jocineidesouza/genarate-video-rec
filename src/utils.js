const fs = require("fs");
const path = require("path");
const { isInsideOutput } = require("./paths");

function basenameFromStoragePath(value) {
  try {
    const url = new URL(value);
    return path.basename(url.pathname);
  } catch {
    return path.basename(value || "");
  }
}

function findFilesRecursive(workdir, predicate) {
  const matches = [];

  function walk(dir) {
    if (isInsideOutput(workdir, dir)) {
      return;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (predicate(entry, fullPath)) {
        matches.push(fullPath);
      }
    }
  }

  walk(workdir);

  return matches;
}

function findFileByBasename(workdir, fileBaseName) {
  const directPath = path.join(workdir, fileBaseName);

  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const matches = findFilesRecursive(
    workdir,
    (entry) => entry.name === fileBaseName
  );

  return matches[0] || null;
}

module.exports = {
  basenameFromStoragePath,
  findFileByBasename,
  findFilesRecursive,
};
