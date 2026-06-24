const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFinalVideoFileName,
  resolveVideoEdition,
  slugifyFilePart,
} = require("../src/video-naming");

test("resolveVideoEdition maps connect and talk", () => {
  assert.equal(resolveVideoEdition({ edition: "connect-dev" }), "ellevo_connect");
  assert.equal(resolveVideoEdition({ edition: "talk-prod" }), "talk");
  assert.equal(resolveVideoEdition({ product: "connect" }), "ellevo_connect");
  assert.equal(resolveVideoEdition({ appEnv: "stg" }), "unknown");
});

test("slugifyFilePart normalizes accents and punctuation", () => {
  assert.equal(slugifyFilePart("Reunião com o time!"), "reuniao_com_o_time");
  assert.equal(slugifyFilePart("   "), "");
});

test("buildFinalVideoFileName uses edition and timestamp", () => {
  const name = buildFinalVideoFileName({
    edition: "talk",
    timestamp: new Date("2026-06-24T09:02:59Z"),
  });

  assert.equal(name, "talk_260624_090259.mp4");
});

test("buildFinalVideoFileName can append a title slug", () => {
  const name = buildFinalVideoFileName({
    product: "connect",
    timestamp: new Date("2026-06-24T09:02:59Z"),
    title: "Reunião de alinhamento",
    includeTitle: true,
  });

  assert.equal(name, "ellevo_connect_260624_090259_reuniao_de_alinhamento.mp4");
});
