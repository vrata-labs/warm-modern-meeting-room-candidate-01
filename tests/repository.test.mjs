import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const validatorCommit = "ec0a8fb118ef9c5589ebb0bd4a9b9047616a56c2";
const constructionRawSha256 = "f32327442d015f4c89942bf752e959d6c0abc24613c72f32a8ba4c2b2b29d5d1";
const mediaSurfaceRawSha256 = "0bdf11ca588d700c8a721d60cb503215c29ce021b48708302b8b9da45ec1036b";
const exteriorConstructionRawSha256 = "54a9e7b3b20c94844380c524443005006225eccbe22b4a57f4df50782e859639";
const lightingConstructionRawSha256 = "ecb7c8da21191c2a9f893c0975de3bf2b8187cf6cd8a711bb3bb2b71f3610cad";
const styleBibleSha256 = "d8147f9495fb8d2cb50bbccf6849cf272b30b662bffb985b6e46e3c604384656";

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

function toRuntimePosition(position) {
  return { x: position.x, y: position.y, z: -position.z };
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

test("manifest preserves the superseded release and selects the coordinate-corrected release", async () => {
  const config = await json("scene-repository.json");
  const manifest = await json("manifest.json");
  assert.equal(manifest.sceneId, config.sceneId);
  assert.equal(manifest.platformValidatorCommit, config.platformValidatorCommit);
  assert.deepEqual(manifest.releases.map(({ version }) => version), ["0.1.0", "0.1.1"]);
  assert.deepEqual(manifest.releases.map(({ status, isCurrent }) => ({ status, isCurrent })), [
    { status: "superseded", isCurrent: false },
    { status: "staging-candidate", isCurrent: true }
  ]);
  assert.equal(manifest.releases[0].supersededBy, "0.1.1");
  assert.ok(manifest.releases.every((release) => release.files["scene.glb"].sha256 === "bc987fd7c5931eeccc23cf260011364299c636091e9b82932af2df30db7d95f5"));
  assert.deepEqual((await readdir(resolve(root, "assets/scenes/warm-modern-meeting-room-candidate-01"))).sort(), [".gitkeep", "0.1.0", "0.1.1"]);
});

test("accepted source, review evidence, rights, and deterministic release are locked", async () => {
  const lock = await json("source/accepted-source-lock.json");
  const ledger = await json("provenance/release-asset-ledger.json");
  assert.equal(lock.status, "accepted-reproducible-source");
  assert.equal(lock.acceptedOn, "2026-08-29");
  assert.equal(lock.reproducibility.scope, "same-host-same-blender-binary-two-run");
  assert.equal(lock.reproducibility.runs, 2);
  assert.equal(lock.reproducibility.sha256, lock.release.glbSha256);
  assert.equal(lock.release.version, "0.1.1");
  assert.equal(lock.runtimeCoordinates.transform, "x=x,y=y,z=-z");
  assert.deepEqual(lock.boundaries, {
    visualAccepted: true,
    rightsApproved: true,
    acceptedSourceStored: true,
    releaseGlbVerified: true,
    publicationReady: false
  });
  assert.equal(sha256(await readFile(resolve(root, lock.acceptedSource.blendPath))), lock.acceptedSource.blendSha256);
  assert.equal(sha256(await readFile(resolve(root, lock.acceptedSource.visualCompletionScriptPath))), lock.acceptedSource.visualCompletionScriptSha256);
  assert.equal(sha256(await readFile(resolve(root, lock.acceptedSource.exportScriptPath))), lock.acceptedSource.exportScriptSha256);
  assert.equal(sha256(await readFile(resolve(root, lock.acceptedSource.renderScriptPath))), lock.acceptedSource.renderScriptSha256);
  assert.equal(sha256(await readFile(resolve(root, lock.release.path, "scene.glb"))), lock.release.glbSha256);
  assert.equal(sha256(await readFile(resolve(root, lock.release.path, "scene.json"))), lock.release.sceneManifestSha256);
  assert.equal(ledger.approval.decision, "approved");
  assert.equal(ledger.allowedUse.production, true);
  assert.equal(ledger.allowedUse.redistribution, true);
  assert.equal(ledger.records.length, 17);
  assert.equal(new Set(ledger.records.map(({ id }) => id)).size, 17);
});

test("current release converts semantic z coordinates into Blender Y-up runtime space", async () => {
  const manifest = await json("manifest.json");
  const spec = await json("source/scene-spec.json");
  const correction = await json("provenance/runtime-coordinate-correction-0.1.1.json");
  const current = manifest.releases.find(({ isCurrent }) => isCurrent);
  const scene = await json(`${current.releasePath}/scene.json`);

  assert.deepEqual(correction.coordinateTransform, { x: "x", y: "y", z: "-z" });
  assert.equal(correction.verification.repositoryCoordinatesLocked, true);
  assert.equal(correction.verification.staging, "pending");
  assert.deepEqual(scene.spawnPoints[0].position, toRuntimePosition(spec.spawn.position));
  assert.deepEqual(
    scene.anchors.seatAnchors.map(({ id, position, yaw, seatHeight, radius }) => ({ id, position, yaw, seatHeight, radius })),
    spec.seats.map(({ id, position, yaw, seatHeight, radius }) => ({ id, position: toRuntimePosition(position), yaw, seatHeight, radius }))
  );
  assert.deepEqual(
    scene.mediaSurfaces.map(({ surfaceId, transform }) => ({ surfaceId, transform })),
    spec.mediaSurfaces.map(({ surfaceId, position, yaw }) => ({ surfaceId, transform: { ...toRuntimePosition(position), yaw } }))
  );
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

test("exterior source is canonical project-authored bounded geometry", async () => {
  const constructionText = await text("source/exterior-constructions.json");
  const construction = JSON.parse(constructionText);
  assert.equal(constructionText, `${JSON.stringify(construction, null, 2)}\n`);
  assert.equal(sha256(constructionText), exteriorConstructionRawSha256);
  assert.equal(construction.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(construction.sourceRecordId, "asset-exterior-constructions-project");
  assert.equal(construction.strategy, "project-authored-geometry");
  assert.equal(construction.windowOpeningId, "main-window");
  assert.deepEqual(construction.boundsM, { min: { x: -5, y: -0.18, z: 2.6 }, max: { x: 5, y: 3, z: 12.6 } });
  assert.deepEqual(construction.materials.map(({ id, category }) => [id, category]), [
    ["ground-mineral", "ground"],
    ["exterior-graphite", "metal"],
    ["exterior-vegetation", "vegetation"]
  ]);
  assert.deepEqual(construction.objects.map(({ id, role, materialId, supportObjectId }) => ({ id, role, materialId, supportObjectId })), [
    { id: "near-ground", role: "nearby-ground", materialId: "ground-mineral", supportObjectId: null },
    { id: "planter", role: "vegetation-container", materialId: "exterior-graphite", supportObjectId: "near-ground" },
    { id: "hedge", role: "vegetation", materialId: "exterior-vegetation", supportObjectId: "planter" },
    { id: "context-mass", role: "middle-distance-context", materialId: "exterior-graphite", supportObjectId: "near-ground" }
  ]);
  assert.ok(construction.objects.every(({ geometry, transform, bevel }) => geometry === "beveled-box"
    && transform.yaw === 0 && bevel.segments === 3 && bevel.clampOverlap === true));
});

test("lighting source is canonical and binds exact candidate emitters", async () => {
  const constructionText = await text("source/lighting-constructions.json");
  const construction = JSON.parse(constructionText);
  assert.equal(constructionText, `${JSON.stringify(construction, null, 2)}\n`);
  assert.equal(sha256(constructionText), lightingConstructionRawSha256);
  assert.equal(construction.sceneId, "warm-modern-meeting-room-candidate-01");
  assert.equal(construction.sourceRecordId, "asset-lighting-constructions-project");
  assert.equal(construction.styleBibleSha256, styleBibleSha256);
  assert.deepEqual(construction.lights.map(({ sceneLightId }) => sceneLightId), ["window-daylight", "ceiling-fill", "table-pendant"]);

  const sharedMapping = {
    coordinateConversion: {
      id: "scene-y-up-to-blender-z-up-v1",
      blenderX: "scene-x",
      blenderY: "scene-z",
      blenderZ: "scene-y"
    },
    orientationConvention: {
      forwardAxis: "local-negative-z",
      forwardTarget: "source-to-target",
      upAxis: "local-y",
      rollAxis: "local-negative-z",
      rollOrder: "after-target-alignment"
    }
  };
  assert.deepEqual(construction.lights[0], {
    sceneLightId: "window-daylight",
    binding: { type: "opening", openingId: "main-window" },
    emitter: {
      type: "directional",
      target: { x: -0.45, y: 1.2, z: 0.05 },
      rollRadians: 0,
      intensityMapping: { source: "scene-intensity-lumens", operation: "divide", divisor: 3600, outputUnit: "watt-per-square-meter" },
      ...sharedMapping,
      angularDiameterDegrees: 5,
      angularDiameterMapping: {
        inputUnit: "degrees",
        operation: "multiply-by-pi-divide-by-180",
        blenderLightType: "SUN",
        blenderProperty: "angle",
        blenderUnit: "radians"
      },
      colorSource: "scene-temperature-kelvin",
      kelvinConversion: "tanner-helland-2012-clamped-srgb-to-linear-v1",
      castShadow: true
    }
  });

  const expectedSpot = (sceneLightId, binding, target, rangeM, innerConeHalfAngleRadians, outerConeHalfAngleRadians, radiusM) => ({
    sceneLightId,
    binding,
    emitter: {
      type: "spot",
      target,
      rollRadians: 0,
      intensityMapping: { source: "scene-intensity-lumens", operation: "divide", divisor: 100, outputUnit: "watt" },
      ...sharedMapping,
      rangeM,
      rangeMapping: {
        useCustomDistanceProperty: "use_custom_distance",
        useCustomDistanceValue: true,
        cutoffDistanceProperty: "cutoff_distance",
        cutoffDistanceSource: "range-m"
      },
      innerConeHalfAngleRadians,
      outerConeHalfAngleRadians,
      coneMapping: {
        angleConvention: "half-angles-radians",
        spotSizeProperty: "spot_size",
        spotSizeFormula: "two-times-outer-cone-half-angle",
        spotBlendProperty: "spot_blend",
        spotBlendFormula: "one-minus-inner-cone-half-angle-divided-by-outer-cone-half-angle"
      },
      radiusM,
      radiusMapping: { blenderProperty: "shadow_soft_size", source: "radius-m" },
      colorSource: "scene-temperature-kelvin",
      kelvinConversion: "tanner-helland-2012-clamped-srgb-to-linear-v1",
      castShadow: true
    }
  });
  assert.deepEqual(construction.lights[1], expectedSpot(
    "ceiling-fill",
    { type: "room-surface", surface: "ceiling" },
    { x: -3.4, y: 1.55, z: 0.15 },
    8,
    0.7,
    1.1,
    0.12
  ));
  assert.deepEqual(construction.lights[2], expectedSpot(
    "table-pendant",
    { type: "component", componentId: "pendant-fixture" },
    { x: -0.45, y: 0.74, z: 0.05 },
    6,
    0.65,
    1,
    0.08
  ));
  assert.deepEqual(construction.firstViewAcceptance, {
    reviewViewId: "entry",
    capture: {
      engine: "CYCLES",
      device: "CPU",
      projection: "perspective",
      fovAxis: "vertical",
      resolution: { widthPx: 960, heightPx: 540, pixelAspectRatio: 1 },
      samples: 64,
      seed: 42,
      adaptiveSampling: false,
      denoising: false,
      transparentBackground: false,
      world: { colorSrgb: "#000000", strength: 0 },
      colorManagement: { displayDevice: "sRGB", viewTransform: "AgX", look: "AgX - Medium High Contrast", exposure: 0, gamma: 1 },
      output: { format: "PNG", colorMode: "RGB", colorDepthBits: 8 }
    },
    measurement: {
      metric: "display-srgb8-rec709-luma-v1",
      scope: "all-rendered-pixels",
      sampleEncoding: "display-srgb8-encoded-rgb-bytes",
      channelValueDomain: "integer-0-to-255",
      linearization: "none",
      integerArithmetic: {
        redWeight: 2126,
        greenWeight: 7152,
        blueWeight: 722,
        divisor: 10000,
        weightedNumerator: "2126-times-r-plus-7152-times-g-plus-722-times-b",
        averagePass: "sum-weighted-numerators-gte-average-minimum-times-divisor-times-pixel-count",
        darkPixel: "weighted-numerator-lt-dark-pixel-threshold-times-divisor",
        darkRatioPass: "dark-count-times-10-lte-pixel-count-times-7"
      },
      darkPixelThreshold: 40
    },
    criteria: { averageLuminanceMinimum: 40, darkPixelRatioMaximum: 0.7 }
  });
});

test("scene binds components, materials, and accepted inputs to project-authored records", async () => {
  const scene = await json("source/scene-spec.json");
  assert.equal(scene.generator.commit, validatorCommit);
  assert.deepEqual(scene.generator.acceptedInputSha256, [
    "978d0c7d75dd73d9c4d4419daa2f1530b0fdfac26c0eee1bcd7ef4e76501272a",
    constructionRawSha256,
    mediaSurfaceRawSha256,
    exteriorConstructionRawSha256,
    lightingConstructionRawSha256
  ]);
  assert.deepEqual(scene.lighting, [
    { id: "window-daylight", kind: "daylight", position: { x: 0, y: 2.5, z: 2.4 }, temperatureK: 6500, intensityLumens: 90000, intendedContribution: "soft directional daylight through the main window" },
    { id: "ceiling-fill", kind: "spot", position: { x: 1.5, y: 2.95, z: -1 }, temperatureK: 2900, intensityLumens: 18000, intendedContribution: "warm architectural fill for entrance and west display" },
    { id: "table-pendant", kind: "pendant", position: { x: -0.45, y: 2.55, z: 0.05 }, temperatureK: 2900, intensityLumens: 32000, intendedContribution: "warm task light over the conference table" }
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
    "asset-media-surface-constructions-project",
    "asset-exterior-constructions-project",
    "asset-lighting-constructions-project"
  ]);
  const expectedSources = new Map([
    ["asset-layout-project", ["source/concept-selection.json", "978d0c7d75dd73d9c4d4419daa2f1530b0fdfac26c0eee1bcd7ef4e76501272a"]],
    ["asset-component-constructions-project", ["source/component-constructions.json", constructionRawSha256]],
    ["asset-media-surface-constructions-project", ["source/media-surface-constructions.json", mediaSurfaceRawSha256]],
    ["asset-exterior-constructions-project", ["source/exterior-constructions.json", exteriorConstructionRawSha256]],
    ["asset-lighting-constructions-project", ["source/lighting-constructions.json", lightingConstructionRawSha256]]
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
  assert.equal(ledger.records.find(({ id }) => id === "asset-lighting-constructions-project").acquiredOn, "2026-08-27");
  const licenseText = await text("provenance/licenses/project-owned.txt");
  assert.equal(sha256(licenseText), "56be457108896a56b706ffcd10d7e1e45778cb33812d98fea6979eb5539fb490");
  assert.match(licenseText, /exact component-construction data/);
  assert.match(licenseText, /exact media-surface construction data/);
  assert.match(licenseText, /exact exterior-construction data/);
  assert.match(licenseText, /exact lighting-construction data authored\s+for Candidate 01/);
  assert.match(licenseText, /does not approve\s+or license future mesh, texture,\s+generated, or external release assets/);
});

test("schema v5 lock pins every canonical and raw contract digest and lighting report value", async () => {
  const [scene, construction, mediaSurfaceConstruction, exteriorConstruction, lightingConstruction, assetLedger, generationLedger, constructionText, mediaSurfaceConstructionText, exteriorConstructionText, lightingConstructionText] = await Promise.all([
    json("source/scene-spec.json"),
    json("source/component-constructions.json"),
    json("source/media-surface-constructions.json"),
    json("source/exterior-constructions.json"),
    json("source/lighting-constructions.json"),
    json("provenance/asset-ledger.json"),
    json("provenance/generation-ledger.json"),
    text("source/component-constructions.json"),
    text("source/media-surface-constructions.json"),
    text("source/exterior-constructions.json"),
    text("source/lighting-constructions.json")
  ]);
  const lock = await json("source/scene-contract-lock.json");
  assert.equal(lock.schemaVersion, 5);
  assert.equal(lock.status, "exact-lighting-construction-specification-valid");
  assert.equal(lock.validatorCommit, validatorCommit);
  assert.equal(lock.specificationSha256, canonicalSha256(scene));
  assert.equal(lock.assetLedgerSha256, canonicalSha256(assetLedger));
  assert.equal(lock.generationLedgerSha256, canonicalSha256(generationLedger));
  assert.equal(lock.componentConstructionSha256, canonicalSha256(construction));
  assert.equal(lock.componentConstructionRawSha256, sha256(constructionText));
  assert.equal(lock.mediaSurfaceConstructionSha256, canonicalSha256(mediaSurfaceConstruction));
  assert.equal(lock.mediaSurfaceConstructionRawSha256, sha256(mediaSurfaceConstructionText));
  assert.equal(lock.exteriorConstructionSha256, canonicalSha256(exteriorConstruction));
  assert.equal(lock.exteriorConstructionRawSha256, sha256(exteriorConstructionText));
  assert.equal(lock.lightingConstructionSha256, canonicalSha256(lightingConstruction));
  assert.equal(lock.lightingConstructionRawSha256, sha256(lightingConstructionText));
  assert.equal(lock.styleBibleSha256, styleBibleSha256);
  assert.deepEqual({
    assets: lock.assetRecordCount,
    families: lock.familyCount,
    parts: lock.partCount,
    overrides: lock.overrideCount,
    components: lock.componentCount,
    materials: lock.materialCount,
    surfaces: lock.surfaceCount
  }, { assets: 5, families: 4, parts: 38, overrides: 2, components: 11, materials: 5, surfaces: 2 });
  assert.equal(lock.resolvedComponentCount, 11);
  assert.equal(lock.resolvedMaterialCount, 4);
  assert.equal(lock.resolvedSurfaceCount, 2);
  assert.equal(lock.generationRecordCount, 0);
  assert.equal(lock.seatCount, 8);
  assert.equal(lock.objectNamePattern, "component.<componentId>.<partId>");
  assert.equal(lock.representation, "platform-runtime-plane");
  assert.deepEqual({
    objects: lock.exteriorObjectCount,
    resolvedObjects: lock.exteriorResolvedObjectCount,
    materials: lock.exteriorMaterialCount,
    roles: lock.exteriorRoleCount,
    strategy: lock.exteriorStrategy,
    windowOpeningId: lock.exteriorWindowOpeningId,
    objectNamePattern: lock.exteriorObjectNamePattern,
    boundsM: lock.exteriorBoundsM
  }, {
    objects: 4,
    resolvedObjects: 4,
    materials: 3,
    roles: 4,
    strategy: "project-authored-geometry",
    windowOpeningId: "main-window",
    objectNamePattern: "exterior.<objectId>",
    boundsM: { min: { x: -5, y: -0.18, z: 2.6 }, max: { x: 5, y: 3, z: 12.6 } }
  });
  assert.equal(lock.lightCount, 3);
  assert.equal(lock.resolvedLightCount, 3);
  assert.equal(lock.lightingObjectNamePattern, "light.<sceneLightId>");
  assert.deepEqual(lock.resolvedIntensityOutputs, [
    { sceneLightId: "window-daylight", value: 25, unit: "watt-per-square-meter" },
    { sceneLightId: "ceiling-fill", value: 180, unit: "watt" },
    { sceneLightId: "table-pendant", value: 320, unit: "watt" }
  ]);
  assert.deepEqual(lock.firstViewAcceptance, lightingConstruction.firstViewAcceptance);
});

test("historical specification lock keeps its pre-release boundaries negative", async () => {
  const lock = await json("source/scene-contract-lock.json");
  assert.deepEqual(lock.boundaries, {
    releaseAssetsApproved: false,
    componentsCompiled: false,
    mediaSurfacesCompiled: false,
    exteriorCompiled: false,
    lightingCompiled: false,
    firstViewRendered: false,
    firstViewAcceptanceVerified: false,
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
