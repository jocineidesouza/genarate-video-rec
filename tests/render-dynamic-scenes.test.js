const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../render-dynamic-scenes");

const {
  compareScreenShareSegments,
  createScenes,
  getSceneRenderDurationMs,
  getScreenShareTiles,
  selectScreenShareSegments,
  timelineMsToFrame,
  getVideoQualityProfile,
} = __test;

function share(trackId, participantIdentity, offsetMs, durationMs) {
  return {
    trackId,
    participantIdentity,
    offsetMs,
    durationMs,
  };
}

test("getScreenShareTiles uses full screen for one share", () => {
  assert.deepEqual(getScreenShareTiles(1), [{ x: 0, y: 0, w: 1280, h: 720 }]);
});

test("getScreenShareTiles uses two 636px columns with an 8px gap", () => {
  assert.deepEqual(getScreenShareTiles(2), [
    { x: 0, y: 0, w: 636, h: 720 },
    { x: 644, y: 0, w: 636, h: 720 },
  ]);
  assert.equal(getScreenShareTiles(3).length, 2);
});

test("selects the configured video quality profile for every scene type", () => {
  assert.deepEqual(getVideoQualityProfile("intro"), {
    name: "intro",
    bitrate: "400k",
    bufsize: "800k",
  });
  assert.deepEqual(getVideoQualityProfile("grid"), {
    name: "grid",
    bitrate: "450k",
    bufsize: "900k",
  });
  assert.deepEqual(getVideoQualityProfile("screen", 1), {
    name: "screen-single",
    bitrate: "1200k",
    bufsize: "2400k",
  });
  assert.deepEqual(getVideoQualityProfile("screen", 2), {
    name: "screen-multiple",
    bitrate: "1600k",
    bufsize: "3200k",
  });
  assert.deepEqual(getVideoQualityProfile("screen", 3), {
    name: "screen-multiple",
    bitrate: "1600k",
    bufsize: "3200k",
  });
});

test("compareScreenShareSegments provides stable ordering", () => {
  const segments = [
    share("track-z", "user-b", 1000, 5000),
    share("track-b", "user-a", 1000, 5000),
    share("track-a", "user-a", 1000, 5000),
    share("track-later", "user-c", 2000, 5000),
  ];

  assert.deepEqual(
    segments.sort(compareScreenShareSegments).map((segment) => segment.trackId),
    ["track-a", "track-b", "track-z", "track-later"]
  );
});

test("selectScreenShareSegments limits rendering to two stable shares", () => {
  const result = selectScreenShareSegments([
    share("track-c", "user-c", 3000, 5000),
    share("track-a", "user-a", 1000, 5000),
    share("track-b", "user-b", 2000, 5000),
  ]);

  assert.deepEqual(
    result.selected.map((segment) => segment.trackId),
    ["track-a", "track-b"]
  );
  assert.deepEqual(
    result.ignored.map((segment) => segment.trackId),
    ["track-c"]
  );
});

test("createScenes splits one and two simultaneous shares at exact boundaries", () => {
  const first = share("track-a", "user-a", 1000, 7000);
  const second = share("track-b", "user-b", 3000, 3000);
  const scenes = createScenes([], [first, second], 10000);

  assert.deepEqual(
    scenes.map((scene) => ({
      kind: scene.kind,
      startMs: scene.startMs,
      endMs: scene.endMs,
      trackIds: scene.screenShareSegments.map((segment) => segment.trackId),
    })),
    [
      { kind: "grid", startMs: 0, endMs: 1000, trackIds: [] },
      { kind: "screen", startMs: 1000, endMs: 3000, trackIds: ["track-a"] },
      {
        kind: "screen",
        startMs: 3000,
        endMs: 6000,
        trackIds: ["track-a", "track-b"],
      },
      { kind: "screen", startMs: 6000, endMs: 8000, trackIds: ["track-a"] },
      { kind: "grid", startMs: 8000, endMs: 10000, trackIds: [] },
    ]
  );
});

test("scene frame rounding does not accumulate across transitions", () => {
  const scenes = [
    { startMs: 0, endMs: 20037 },
    { startMs: 20037, endMs: 36064 },
    { startMs: 36064, endMs: 48983 },
  ];
  const renderedDurationMs = scenes.reduce(
    (total, scene) => total + getSceneRenderDurationMs(scene),
    0
  );

  assert.equal(renderedDurationMs, timelineMsToFrame(48983) * 125);
  assert.equal(renderedDurationMs, 49000);
});
