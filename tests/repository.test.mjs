import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

test("repository is pinned to one neutral scene", async () => {
  const config = await json("scene-repository.json");
  assert.equal(config.oneSceneOnly, true);
  assert.equal(config.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(config.reviewIdentity, "neutral-candidate-01");
});

test("empty release manifest is locked to the same scene and validator", async () => {
  const config = await json("scene-repository.json");
  const manifest = await json("manifest.json");
  assert.equal(manifest.sceneId, config.sceneId);
  assert.equal(manifest.platformValidatorCommit, config.platformValidatorCommit);
  assert.deepEqual(manifest.releases, []);
});

test("approved low-fidelity concept remains private-preview and pre-specification", async () => {
  const concept = await json("source/concept-selection.json");
  assert.equal(concept.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(concept.selection.conceptId, "concept-03-corrected");
  assert.equal(concept.selection.previewSha256, "f52b3722e71dd231ebe80424f0411e9771670fa37aff01eebbce42ff7d4c0a21");
  assert.equal(concept.layoutIntent.seatCount, 8);
  assert.equal(concept.layoutIntent.chairOrientation, "seat-facing-table-back-facing-outward");
  assert.deepEqual(concept.layoutIntent.roomEnvelopeM, { width: 7, height: 3.1, depth: 5 });
  assert.deepEqual(concept.layoutIntent.conferenceTable, {
    center: { x: -0.45, y: 0.74, z: 0.05 },
    dimensionsM: { width: 4, height: 0.74, depth: 1.18 },
    yawRadians: -0.20943951
  });
  assert.equal(concept.layoutIntent.presentationWall, "west");
  assert.equal(concept.layoutIntent.mainWindowWall, "north");
  assert.equal(concept.layoutIntent.entranceWall, "south");
  assert.equal(concept.layoutIntent.composition, "offset-table-axis-with-clear-east-entry-route");
  assert.equal(concept.boundaries.approvedCandidateSpecificationCreated, false);
  assert.equal(concept.boundaries.assetRightsCleared, false);
  assert.equal(concept.boundaries.releaseArtifactsCreated, false);
  assert.equal(concept.boundaries.previewBinaryIncluded, false);
  assert.equal(concept.boundaries.publicationReady, false);
});
