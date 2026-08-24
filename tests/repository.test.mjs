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

test("approved low-fidelity concept remains private-preview and exact-specification bounded", async () => {
  const concept = await json("source/concept-selection.json");
  assert.equal(concept.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(concept.selection.conceptId, "concept-03-functional");
  assert.equal(concept.selection.previewSha256, "cd7456afb5c9c10ebf3d4a16fdb5173af2c68a9faf9ce2798ec8238e257309c7");
  assert.equal(concept.layoutIntent.seatCount, 8);
  assert.equal(concept.layoutIntent.chairOrientation, "seat-facing-table-back-facing-outward");
  assert.deepEqual(concept.layoutIntent.roomEnvelopeM, { width: 7, height: 3.1, depth: 5 });
  assert.deepEqual(concept.layoutIntent.conferenceTable, {
    center: { x: -0.45, y: 0.74, z: 0.05 },
    dimensionsM: { width: 4, height: 0.74, depth: 1.18 },
    yawRadians: 0
  });
  assert.equal(concept.layoutIntent.presentationWall, "west");
  assert.equal(concept.layoutIntent.mainWindowWall, "north");
  assert.equal(concept.layoutIntent.entranceWall, "south");
  assert.equal(concept.layoutIntent.composition, "offset-straight-table-axis-with-clear-east-entry-route");
  assert.equal(concept.boundaries.approvedCandidateSpecificationCreated, true);
  assert.equal(concept.boundaries.assetRightsCleared, false);
  assert.equal(concept.boundaries.releaseArtifactsCreated, false);
  assert.equal(concept.boundaries.previewBinaryIncluded, false);
  assert.equal(concept.boundaries.publicationReady, false);
});

test("exact candidate specification is locked to validated routes and neutral placeholder ledgers", async () => {
  const scene = await json("source/scene-spec.json");
  const lock = await json("source/scene-contract-lock.json");
  const generationLedger = await json("provenance/generation-ledger.json");
  assert.equal(scene.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(scene.components.length, 11);
  assert.equal(scene.seats.length, 8);
  assert.equal(scene.clearance.routes.length, 10);
  assert.equal(scene.clearance.minimumRouteWidthM, 0.9);
  assert.equal(scene.components.find(({ id }) => id === "conference-table").transform.yaw, 0);
  assert.equal(lock.status, "approved-candidate-specification-valid");
  assert.equal(lock.validatorCommit, "fa9767913fc3cc2b1d06fc00c44ed6a26369b219");
  assert.equal(lock.specificationSha256, "29d76ca0feaefd4bf9cac9ebd25113c601e358c939778c4a0f43f3f94b58e0dd");
  assert.equal(lock.assetRecordCount, 1);
  assert.equal(lock.generationRecordCount, 0);
  assert.deepEqual(generationLedger.records, []);
  assert.equal(lock.boundaries.releaseAssetsApproved, false);
  assert.equal(lock.boundaries.publicationReady, false);
});
