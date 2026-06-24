const DEFAULT_EDITION = "unknown";

function normalizeText(value) {
  return String(value || "").trim();
}

function slugifyFilePart(value, maxLength = 48) {
  const normalized = normalizeText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const slug = normalized
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!slug) {
    return "";
  }

  return slug.slice(0, maxLength);
}

function resolveVideoEdition({ edition, product, appEnv } = {}) {
  const candidate = normalizeText(edition || product || appEnv).toLowerCase();

  if (!candidate) {
    return DEFAULT_EDITION;
  }

  if (candidate.includes("connect")) {
    return "ellevo_connect";
  }

  if (candidate.includes("talk")) {
    return "talk";
  }

  return DEFAULT_EDITION;
}

function formatTimestampForFileName(date = new Date()) {
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function buildFinalVideoFileName({
  edition,
  product,
  appEnv,
  title,
  timestamp = new Date(),
  includeTitle = false,
} = {}) {
  const resolvedEdition = resolveVideoEdition({ edition, product, appEnv });
  const resolvedTimestamp = formatTimestampForFileName(timestamp);
  const titleSlug = includeTitle ? slugifyFilePart(title, 40) : "";
  const titleSuffix = titleSlug ? `_${titleSlug}` : "";

  return `${resolvedEdition}_${resolvedTimestamp}${titleSuffix}.mp4`;
}

module.exports = {
  buildFinalVideoFileName,
  formatTimestampForFileName,
  resolveVideoEdition,
  slugifyFilePart,
};
