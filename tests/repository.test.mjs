import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const validatorCommit = "c3157b65c739bf784d5b8654e0808a3c3a84f611";
const constructionRawSha256 = "f32327442d015f4c89942bf752e959d6c0abc24613c72f32a8ba4c2b2b29d5d1";
const mediaSurfaceRawSha256 = "0bdf11ca588d700c8a721d60cb503215c29ce021b48708302b8b9da45ec1036b";

async function text(path) {
  return readFile(resolve(root, path), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return sha256(stableJson(value));
}

function part(id, dimensions, position, bevelWidthM, materialSlotId) {
  const [widthM, heightM, depthM] = dimensions;
  const [x, y, z] = position;
  return {
    id,
    geometry: "beveled-box",
    dimensions: { widthM, heightM, depthM },
    localTransform: { position: { x, y, z }, yaw: 0 },
    bevel: { widthM: bevelWidthM, segments: 3, clampOverlap: true },
    materialSlotId
  };
}

test("repository is pinned to one neutral scene", async () => {
  const config = await json("scene-repository.json");
  assert.equal(config.oneSceneOnly, true);
  assert.equal(config.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(config.reviewIdentity, "neutral-candidate-01");
});

test("source-only manifest remains empty and uses the platform validator lock", async () => {
  const config = await json("scene-repository.json");
  const manifest = await json("manifest.json");
  assert.equal(manifest.sceneId, config.sceneId);
  assert.equal(manifest.platformValidatorCommit, config.platformValidatorCommit);
  assert.deepEqual(manifest.releases, []);
  assert.deepEqual(await readdir(resolve(root, "assets/scenes/warm-modern-meeting-room-candidate-01")), [".gitkeep"]);
});

test("approved concept remains private-preview and release bounded", async () => {
  const concept = await json("source/concept-selection.json");
  assert.equal(concept.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(concept.selection.conceptId, "concept-03-functional");
  assert.equal(concept.selection.previewSha256, "cd7456afb5c9c10ebf3d4a16fdb5173af2c68a9faf9ce2798ec8238e257309c7");
  assert.equal(concept.selection.previewIncludedInRepository, false);
  assert.equal(concept.layoutIntent.seatCount, 8);
  assert.equal(concept.layoutIntent.chairOrientation, "seat-facing-table-back-facing-outward");
  assert.deepEqual(concept.layoutIntent.roomEnvelopeM, { width: 7, height: 3.1, depth: 5 });
  assert.deepEqual(concept.layoutIntent.conferenceTable, {
    center: { x: -0.45, y: 0.74, z: 0.05 },
    dimensionsM: { width: 4, height: 0.74, depth: 1.18 },
    yawRadians: 0
  });
  assert.equal(concept.boundaries.approvedCandidateSpecificationCreated, true);
  for (const key of ["assetRightsCleared", "releaseArtifactsCreated", "previewBinaryIncluded", "publicationReady"]) {
    assert.equal(concept.boundaries[key], false, key);
  }
});

test("exact component families use the approved minimal construction", async () => {
  const construction = await json("source/component-constructions.json");
  assert.equal(construction.schemaVersion, 1);
  assert.equal(construction.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(construction.sourceRecordId, "asset-component-constructions-project");
  assert.equal(construction.materialSourceRecordId, "asset-layout-project");
  assert.deepEqual(construction.families.map(({ id }) => id), [
    "conference-table", "task-chair", "conference-av", "pendant-luminaire"
  ]);

  const families = new Map(construction.families.map((family) => [family.id, family]));
  assert.deepEqual(families.get("conference-table"), {
    id: "conference-table",
    defaultMaterials: [
      { slot: "surface", materialRecipeId: "warm-oak" },
      { slot: "frame", materialRecipeId: "graphite-metal" }
    ],
    parts: [
      part("top", [3.6, 0.12, 1.18], [0, 0.68, 0], 0.03, "surface"),
      part("leg-negative-x", [0.18, 0.62, 0.9], [-1.35, 0.31, 0], 0.025, "frame"),
      part("leg-positive-x", [0.18, 0.62, 0.9], [1.35, 0.31, 0], 0.025, "frame")
    ]
  });
  assert.deepEqual(families.get("task-chair"), {
    id: "task-chair",
    defaultMaterials: [
      { slot: "upholstery", materialRecipeId: "sand-fabric" },
      { slot: "frame", materialRecipeId: "graphite-metal" }
    ],
    parts: [
      part("seat", [0.56, 0.11, 0.52], [0, 0.47, 0], 0.03, "upholstery"),
      part("back", [0.56, 0.6, 0.1], [0, 0.75, -0.24], 0.025, "upholstery"),
      part("leg-negative-x", [0.08, 0.415, 0.46], [-0.22, 0.2075, 0], 0.02, "frame"),
      part("leg-positive-x", [0.08, 0.415, 0.46], [0.22, 0.2075, 0], 0.02, "frame")
    ]
  });
  assert.deepEqual(families.get("conference-av"), {
    id: "conference-av",
    defaultMaterials: [{ slot: "body", materialRecipeId: "graphite-metal" }],
    parts: [part("body", [0.4, 0.12, 0.25], [0, 0.06, 0], 0.02, "body")]
  });
  assert.deepEqual(families.get("pendant-luminaire"), {
    id: "pendant-luminaire",
    defaultMaterials: [{ slot: "housing", materialRecipeId: "graphite-metal" }],
    parts: [
      part("bar-negative-x", [0.8, 0.1, 0.12], [-0.65, 0.09, 0], 0.025, "housing"),
      part("bar-positive-x", [0.8, 0.1, 0.12], [0.65, 0.09, 0], 0.025, "housing")
    ]
  });
  assert.deepEqual(construction.instanceMaterialOverrides, [
    { componentId: "chair-02", slot: "upholstery", materialRecipeId: "muted-grey-green-fabric" },
    { componentId: "chair-07", slot: "upholstery", materialRecipeId: "muted-grey-green-fabric" }
  ]);
});

test("all parts remain inside component envelopes and resolve to 38 objects", async () => {
  const scene = await json("source/scene-spec.json");
  const construction = await json("source/component-constructions.json");
  const families = new Map(construction.families.map((family) => [family.id, family]));
  let resolvedParts = 0;
  for (const component of scene.components) {
    const family = families.get(component.family);
    assert.ok(family, component.family);
    resolvedParts += family.parts.length;
    for (const componentPart of family.parts) {
      const { dimensions, localTransform } = componentPart;
      assert.ok(Math.abs(localTransform.position.x) + dimensions.widthM / 2 <= component.dimensions.widthM / 2 + 1e-9, `${component.id}:${componentPart.id}:x`);
      assert.ok(Math.abs(localTransform.position.z) + dimensions.depthM / 2 <= component.dimensions.depthM / 2 + 1e-9, `${component.id}:${componentPart.id}:z`);
      assert.ok(localTransform.position.y - dimensions.heightM / 2 >= -1e-9, `${component.id}:${componentPart.id}:bottom`);
      assert.ok(localTransform.position.y + dimensions.heightM / 2 <= component.dimensions.heightM + 1e-9, `${component.id}:${componentPart.id}:top`);
    }
  }
  assert.equal(resolvedParts, 38);
});

test("media surfaces define exact runtime semantics without physical scene data", async () => {
  const constructionText = await text("source/media-surface-constructions.json");
  const construction = JSON.parse(constructionText);
  assert.equal(constructionText, `${JSON.stringify(construction, null, 2)}\n`);
  assert.deepEqual(construction, {
    schemaVersion: 1,
    sceneId: "warm-modern-meeting-room-candidate-01",
    sourceRecordId: "asset-media-surface-constructions-project",
    surfaces: [
      {
        surfaceId: "debug-main",
        purpose: "presentation-display",
        representation: "platform-runtime-plane",
        pixelDimensions: { width: 1920, height: 1080 },
        frontFace: "local-positive-z",
        input: { enabled: true, maxDistanceM: 0.05 }
      },
      {
        surfaceId: "whiteboard-wall",
        purpose: "collaboration-whiteboard",
        representation: "platform-runtime-plane",
        pixelDimensions: { width: 1920, height: 1000 },
        frontFace: "local-positive-z",
        input: { enabled: true, maxDistanceM: 0.05 }
      }
    ]
  });
  for (const surface of construction.surfaces) {
    for (const key of ["widthM", "heightM", "position", "yaw"]) assert.equal(Object.hasOwn(surface, key), false, `${surface.surfaceId}:${key}`);
  }
});

test("scene binds components, materials, and accepted inputs to project-authored records", async () => {
  const scene = await json("source/scene-spec.json");
  assert.equal(scene.generator.commit, validatorCommit);
  assert.deepEqual(scene.generator.acceptedInputSha256, [
    "978d0c7d75dd73d9c4d4419daa2f1530b0fdfac26c0eee1bcd7ef4e76501272a",
    constructionRawSha256,
    mediaSurfaceRawSha256
  ]);
  assert.ok(scene.components.every(({ sourceRecordId }) => sourceRecordId === "asset-component-constructions-project"));
  assert.ok(scene.components.every(({ generationRecordId }) => generationRecordId === null));
  assert.equal(scene.materialRecipes.length, 5);
  assert.ok(scene.materialRecipes.every(({ sourceRecordId }) => sourceRecordId === "asset-layout-project"));
  assert.deepEqual(scene.materialRecipes.find(({ id }) => id === "muted-grey-green-fabric"), {
    id: "muted-grey-green-fabric",
    category: "fabric",
    baseColorSrgb: "#77877B",
    roughness: 0.8,
    metalness: 0,
    textureScaleM: 0.003,
    sourceRecordId: "asset-layout-project"
  });
});

test("asset provenance binds all raw source files to project-owned non-production rights", async () => {
  const ledger = await json("provenance/asset-ledger.json");
  assert.deepEqual(ledger.records.map(({ id }) => id), [
    "asset-layout-project",
    "asset-component-constructions-project",
    "asset-media-surface-constructions-project"
  ]);
  const expectedSources = new Map([
    ["asset-layout-project", ["source/concept-selection.json", "978d0c7d75dd73d9c4d4419daa2f1530b0fdfac26c0eee1bcd7ef4e76501272a"]],
    ["asset-component-constructions-project", ["source/component-constructions.json", constructionRawSha256]],
    ["asset-media-surface-constructions-project", ["source/media-surface-constructions.json", mediaSurfaceRawSha256]]
  ]);
  for (const record of ledger.records) {
    const [repositoryPath, digest] = expectedSources.get(record.id);
    assert.equal(record.kind, "project-authored-input");
    assert.deepEqual(record.source, { classification: "project-authored", publicUrl: null, repositoryPath });
    assert.equal(sha256(await readFile(resolve(root, repositoryPath))), digest);
    assert.equal(record.originalSha256, digest);
    assert.deepEqual(record.license, {
      name: "LicenseRef-Project-Owned",
      reference: "provenance/licenses/project-owned.txt",
      commercialUse: true,
      redistribution: true,
      mlProcessing: true
    });
    assert.deepEqual(record.allowedUse, {
      staging: true,
      production: false,
      webRuntime: true,
      screenshots: true,
      optimization: true,
      redistribution: true
    });
  }
  const licenseText = await text("provenance/licenses/project-owned.txt");
  assert.equal(sha256(licenseText), "866ac71340f3d07af2b1535847fac9678dab70880171f8a9cd526fdc526e8d41");
  assert.match(licenseText, /exact component-construction data/);
  assert.match(licenseText, /exact media-surface construction data\s+authored for Candidate 01/);
  assert.match(licenseText, /does not\s+approve or license future mesh, texture,\s+generated, or external release assets/);
});

test("schema v3 lock pins every canonical and raw contract digest", async () => {
  const [scene, construction, mediaSurfaceConstruction, assetLedger, generationLedger, constructionText, mediaSurfaceConstructionText] = await Promise.all([
    json("source/scene-spec.json"),
    json("source/component-constructions.json"),
    json("source/media-surface-constructions.json"),
    json("provenance/asset-ledger.json"),
    json("provenance/generation-ledger.json"),
    text("source/component-constructions.json"),
    text("source/media-surface-constructions.json")
  ]);
  const lock = await json("source/scene-contract-lock.json");
  assert.equal(lock.schemaVersion, 3);
  assert.equal(lock.status, "exact-media-surface-specification-valid");
  assert.equal(lock.validatorCommit, validatorCommit);
  assert.equal(lock.specificationSha256, canonicalSha256(scene));
  assert.equal(lock.assetLedgerSha256, canonicalSha256(assetLedger));
  assert.equal(lock.generationLedgerSha256, canonicalSha256(generationLedger));
  assert.equal(lock.componentConstructionSha256, canonicalSha256(construction));
  assert.equal(lock.componentConstructionRawSha256, sha256(constructionText));
  assert.equal(lock.mediaSurfaceConstructionSha256, canonicalSha256(mediaSurfaceConstruction));
  assert.equal(lock.mediaSurfaceConstructionRawSha256, sha256(mediaSurfaceConstructionText));
  assert.deepEqual({
    assets: lock.assetRecordCount,
    families: lock.familyCount,
    parts: lock.partCount,
    overrides: lock.overrideCount,
    components: lock.componentCount,
    materials: lock.materialCount,
    surfaces: lock.surfaceCount
  }, { assets: 3, families: 4, parts: 38, overrides: 2, components: 11, materials: 5, surfaces: 2 });
  assert.equal(lock.resolvedComponentCount, 11);
  assert.equal(lock.resolvedMaterialCount, 4);
  assert.equal(lock.resolvedSurfaceCount, 2);
  assert.equal(lock.generationRecordCount, 0);
  assert.equal(lock.seatCount, 8);
  assert.equal(lock.objectNamePattern, "component.<componentId>.<partId>");
  assert.equal(lock.representation, "platform-runtime-plane");
});

test("all release, compiler, preview, and publication boundaries remain negative", async () => {
  const lock = await json("source/scene-contract-lock.json");
  assert.deepEqual(lock.boundaries, {
    releaseAssetsApproved: false,
    componentsCompiled: false,
    mediaSurfacesCompiled: false,
    finalCandidateGlbVerified: false,
    sceneBinaryCreated: false,
    previewBinaryIncluded: false,
    publicationReady: false
  });
  assert.ok(Object.values(lock.boundaries).every((value) => value === false));
  await assert.rejects(access(resolve(root, "compiler")));
  const workflow = await text(".github/workflows/validate.yml");
  assert.match(workflow, /source\/scene-contract-lock\.json"\)\.validatorCommit/);
  assert.match(workflow, /ref: \$\{\{ steps\.scene-contract-ref\.outputs\.sha \}\}/);
  assert.match(workflow, /SCENE_FACTORY_DIR: \.scene-factory/);
});
