import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  expectedMeshNodeName,
  runSceneRealityValidation,
  validateGlbDocument,
  validateSceneManifest,
  validateSceneRealityContract,
  validateUserScenariosContract
} from "../scripts/validate-scene-reality.mjs";

const root = resolve(import.meta.dirname, "..");
const realityPath = resolve(root, "source/releases/0.3.1/scene-reality.json");
const scenariosPath = resolve(root, "source/releases/0.3.1/user-scenarios.json");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function withoutObjectBinding(binding) {
  const { objectId: _objectId, partId: _partId, ...manifestBinding } = binding;
  return manifestBinding;
}

function fixtureManifest(reality) {
  return {
    schemaVersion: 1,
    sceneId: reality.sceneId,
    version: reality.releaseVersion,
    glbPath: "scene.glb",
    anchors: {
      teleportFloorY: 0,
      seatAnchors: reality.runtimeBindings.seatAnchors.map(withoutObjectBinding)
    },
    mediaSurfaces: reality.runtimeBindings.mediaSurfaces.map(withoutObjectBinding)
  };
}

const envelopeValues = {
  "area-rug": [[-2.35, -0.016, -1.55], [2.35, 0, 1.55]],
  "av-credenza": [[-0.235, 0, -1.15], [0.235, 0.545, 1.15]],
  baseboards: [[-3.41, 0, -2.41], [3.41, 0.09, 2.41]],
  "conference-speakerphone": [[-0.15, 0.73, -0.15], [0.15, 0.78, 0.15]],
  "conference-table": [[-1.8, 0, -0.59], [1.8, 0.73, 0.59]],
  "conference-table-cable-management": [[-0.265, 0.705, -0.09], [0.265, 0.73, 0.09]],
  "debug-main": [[-3.4025, 0.5, -1.8425], [-3.3275, 2.485, 1.5425]],
  "exterior-neighbor-building": [[-1.3, 0, -0.72], [1.3, 3, 0.72]],
  "exterior-site": [[-5, -0.18, -5], [5, 0, 5]],
  "main-door": [[-0.55, 0, -0.125], [0.55, 2.2, 0.125]],
  "main-window": [[-1.7, 0.6, -0.1], [1.7, 2.4, 0.1]],
  "media-wall-acoustics": [[-0.035, 1, -0.35], [0.035, 2.3, 0.35]],
  "pendant-fixture": [[-1.05, 2.65, -0.06], [1.05, 3.185, 0.06]],
  "room-shell": [[-3.59, -0.18, -2.59], [3.59, 3.28, 2.59]],
  "route-safe-plant": [[-3.2, 0, -2.28], [-2.8, 1.55, -1.9]],
  "whiteboard-accessories": [[3.245, 0.8, -0.35], [3.325, 0.84, 0.35]],
  "whiteboard-marker": [[3.255, 0.84, -0.09], [3.275, 0.86, 0.09]],
  "whiteboard-wall": [[3.3275, 0.8, -1.2825], [3.4025, 2.21, 1.2825]]
};

const partEnvelopeValues = {
  "debug-main/surface": [[-3.34, 0.67, -1.73], [-3.32, 2.43, 1.43]],
  "main-window/frame-bottom": [[-1.82, 0.7, -0.09], [1.42, 0.78, 0.09]],
  "main-window/frame-head": [[-1.82, 2.42, -0.09], [1.42, 2.5, 0.09]],
  "main-window/frame-left": [[-1.9, 0.7, -0.09], [-1.82, 2.5, 0.09]],
  "main-window/frame-right": [[1.42, 0.7, -0.09], [1.5, 2.5, 0.09]],
  "main-window/glass": [[-1.795, 0.805, -0.006], [1.395, 2.395, 0.006]],
  "main-window/glazing-bead-bottom": [[-1.795, 0.78, -0.0125], [1.395, 0.805, 0.0125]],
  "main-window/glazing-bead-top": [[-1.795, 2.395, -0.0125], [1.395, 2.42, 0.0125]],
  "main-window/glazing-bead-left": [[-1.82, 0.805, -0.0125], [-1.795, 2.395, 0.0125]],
  "main-window/glazing-bead-right": [[1.395, 0.805, -0.0125], [1.42, 2.395, 0.0125]],
  "whiteboard-wall/surface": [[3.32, 0.895, -1.18], [3.34, 2.105, 1.18]]
};

for (let index = 1; index <= 8; index += 1) {
  envelopeValues[`chair-${String(index).padStart(2, "0")}`] = [[-0.33, 0, -0.33], [0.33, 0.96, 0.33]];
}

function fixtureDocument(reality, scenarios) {
  const extrasByPart = new Map();
  for (const metric of scenarios.builderPhysicsAcceptance.extrasMetrics) {
    const key = `${metric.objectId}/${metric.partId}`;
    const extras = extrasByPart.get(key) ?? {};
    extras[metric.key] = metric.value;
    extrasByPart.set(key, extras);
  }

  const nodes = [];
  const meshes = [];
  const accessors = [];
  for (const object of reality.objects) {
    const envelope = envelopeValues[object.id];
    assert.ok(envelope, object.id);
    for (const part of object.parts) {
      let bounds = partEnvelopeValues[`${object.id}/${part.id}`] ?? envelope;
      if (object.id === "conference-table" && part.id === "top") bounds = [[-1.8, 0.68, -0.59], [1.8, 0.73, 0.59]];
      if (object.id.startsWith("chair-") && part.id === "arm-assembly") bounds = [[-0.31, 0.5, -0.25], [0.31, 0.655, 0.25]];
      const accessor = accessors.length;
      accessors.push({ type: "VEC3", componentType: 5126, count: 8, min: bounds[0], max: bounds[1] });
      const mesh = meshes.length;
      meshes.push({ primitives: [{ attributes: { POSITION: accessor } }] });
      const key = `${object.id}/${part.id}`;
      const excluded = new Set(["main-window/glass", "exterior-neighbor-building/window-glass"]).has(key);
      nodes.push({
        name: expectedMeshNodeName(object.id, part.id),
        mesh,
        extras: {
          vrataObjectId: object.id,
          vrataPartId: part.id,
          vrataInteractionStatus: object.status,
          vrataBakePolicy: excluded ? "exclude-transparent" : "include",
          ...(excluded ? { vrataBakeExclusionReason: "transparent-glass" } : {}),
          ...(extrasByPart.get(key) ?? {})
        }
      });
    }
  }
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{
      nodes: nodes.map((_, index) => index),
      extras: {
        vrataSceneId: reality.sceneId,
        vrataAuthoringRelease: reality.releaseVersion,
        vrataGeometryStatus: "review",
        vrataInteractionSemantics: "passive,deferred,interactive"
      }
    }],
    nodes,
    meshes,
    accessors
  };
}

function encodeGlb(document) {
  const jsonBytes = Buffer.from(JSON.stringify(document), "utf8");
  const padding = (4 - jsonBytes.length % 4) % 4;
  const chunk = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)]);
  const bytes = Buffer.alloc(20 + chunk.length);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(chunk.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(bytes, 20);
  return bytes;
}

test("0.3.1 reality and scenario contracts cover the exact corrected model", async () => {
  const reality = await json(realityPath);
  const scenarios = await json(scenariosPath);
  const realityContext = validateSceneRealityContract(reality);
  const scenarioContext = validateUserScenariosContract(scenarios, realityContext);

  assert.equal(realityContext.objectById.size, 26);
  assert.equal(realityContext.partByKey.size, 137);
  assert.deepEqual(realityContext.partsByStatus, { passive: 54, deferred: 23, interactive: 60 });
  assert.equal(scenarioContext.scenarioCount, 18);
  assert.equal(scenarioContext.scaleRangeCount, 26);
  assert.equal(scenarioContext.extrasMetricCount, 37);
  assert.ok(scenarios.scenarios.filter(({ id }) => id.endsWith("approach-sit-stand")).length === 8);
  assert.ok(scenarios.scenarios.filter(({ implementationRequired }) => !implementationRequired).every((scenario) => scenario.acceptanceCriteria.some(({ measure, value }) => measure === "runtime-implementation-required" && value === false)));
});

test("reality validation rejects shape drift, support cycles and deferred implementations", async () => {
  const reality = await json(realityPath);

  const extraKey = structuredClone(reality);
  extraKey.unexpected = true;
  assert.throws(() => validateSceneRealityContract(extraKey), /invalid_scene_reality_keys/);

  const supportCycle = structuredClone(reality);
  supportCycle.objects.find(({ id }) => id === "area-rug").parts[0].supports = [
    { relation: "supported-by", objectId: "conference-table", partId: "top" }
  ];
  assert.throws(() => validateSceneRealityContract(supportCycle), /support_cycle/);

  const deferredImplementation = structuredClone(reality);
  deferredImplementation.objects.find(({ id }) => id === "main-door").implementedInteractions = [
    { type: "media-surface", bindingId: "debug-main" }
  ];
  assert.throws(() => validateSceneRealityContract(deferredImplementation), /non_interactive_implementation_forbidden:main-door/);
});

test("release scene manifest binds all seats and media surfaces exactly", async () => {
  const reality = await json(realityPath);
  const manifest = fixtureManifest(reality);
  assert.deepEqual(validateSceneManifest(manifest, reality), { seatAnchors: 8, mediaSurfaces: 2 });

  const drifted = structuredClone(manifest);
  drifted.anchors.seatAnchors[7].position.z += 0.01;
  assert.throws(() => validateSceneManifest(drifted, reality), /release_scene_seat_bindings_drift/);
});

test("GLB validation enforces all tagged parts, geometry acceptance and deterministic reporting", async () => {
  const reality = await json(realityPath);
  const scenarios = await json(scenariosPath);
  const realityContext = validateSceneRealityContract(reality);
  validateUserScenariosContract(scenarios, realityContext);
  const document = fixtureDocument(reality, scenarios);
  const result = validateGlbDocument(document, reality, scenarios, realityContext);
  assert.equal(result.meshNodeCount, 137);
  assert.equal(result.objectCount, 26);
  assert.equal(result.scaleRangesValidated, 26);
  assert.equal(result.clearancesValidated, 16);
  assert.equal(result.extrasMetricsValidated, 37);
  assert.equal(result.contactsValidated, realityContext.supportEdges);

  const unknownPart = structuredClone(document);
  unknownPart.nodes[0].extras.vrataObjectId = "unknown-object";
  assert.throws(() => validateGlbDocument(unknownPart, reality, scenarios, realityContext), /unknown_mesh_object_or_part/);

  const unknownName = structuredClone(document);
  unknownName.nodes[0].name = "unknown.fixture";
  assert.throws(() => validateGlbDocument(unknownName, reality, scenarios, realityContext), /unknown_glb_node_name/);

  const reviewName = structuredClone(document);
  reviewName.nodes[0].name = "review.fixture";
  assert.throws(() => validateGlbDocument(reviewName, reality, scenarios, realityContext), /review_glb_node_name/);

  const floatName = structuredClone(document);
  floatName.nodes[0].name = "fixture.part.1.25";
  assert.throws(() => validateGlbDocument(floatName, reality, scenarios, realityContext), /float_glb_node_name/);

  const renamedPart = structuredClone(document);
  renamedPart.nodes[0].name = "reality.area-rug-renamed";
  assert.throws(() => validateGlbDocument(renamedPart, reality, scenarios, realityContext), /mesh_node_name_mismatch/);

  const statusDrift = structuredClone(document);
  statusDrift.nodes[0].extras.vrataInteractionStatus = "deferred";
  assert.throws(() => validateGlbDocument(statusDrift, reality, scenarios, realityContext), /mesh_status_mismatch/);

  const windowGap = structuredClone(document);
  const leftBead = windowGap.nodes.find((node) => node.extras.vrataObjectId === "main-window" && node.extras.vrataPartId === "glazing-bead-left");
  windowGap.accessors[windowGap.meshes[leftBead.mesh].primitives[0].attributes.POSITION].min[0] += 0.01;
  windowGap.accessors[windowGap.meshes[leftBead.mesh].primitives[0].attributes.POSITION].max[0] += 0.01;
  assert.throws(() => validateGlbDocument(windowGap, reality, scenarios, realityContext), /clearance_failed:window-left-bead-frame-gap/);

  const offCenterWhiteboard = structuredClone(document);
  for (const node of offCenterWhiteboard.nodes.filter((value) => value.extras.vrataObjectId === "whiteboard-wall")) {
    const accessor = offCenterWhiteboard.accessors[offCenterWhiteboard.meshes[node.mesh].primitives[0].attributes.POSITION];
    accessor.min[2] += 0.5;
    accessor.max[2] += 0.5;
  }
  assert.throws(() => validateGlbDocument(offCenterWhiteboard, reality, scenarios, realityContext), /whiteboard_not_wall_centered/);

  const occludedMediaReality = structuredClone(reality);
  occludedMediaReality.runtimeBindings.mediaSurfaces[0].transform.x = -3.4;
  assert.throws(() => validateGlbDocument(document, occludedMediaReality, scenarios, realityContext), /media_surface_not_in_front_of_backing:debug-main/);

  const temporary = await mkdtemp(join(tmpdir(), "wmmr-scene-reality-"));
  try {
    const scenePath = join(temporary, "scene.json");
    const glbPath = join(temporary, "scene.glb");
    const reportPath = join(temporary, "scene-reality-report.json");
    await writeFile(scenePath, `${JSON.stringify(fixtureManifest(reality), null, 2)}\n`);
    await writeFile(glbPath, encodeGlb(document));
    const first = await runSceneRealityValidation({ root, scenePath, glbPath, reportPath });
    const firstBytes = await readFile(reportPath, "utf8");
    const second = await runSceneRealityValidation({ root, scenePath, glbPath, reportPath });
    const secondBytes = await readFile(reportPath, "utf8");
    assert.deepEqual(second, first);
    assert.equal(secondBytes, firstBytes);
    assert.equal(first.release.sceneManifestValidated, true);
    assert.equal(first.release.glbValidated, true);
    assert.equal(first.release.meshNodesValidated, 137);
    assert.doesNotMatch(firstBytes, /tmp|sha256|generatedAt/i);

    const separatorReportPath = join(temporary, "separator-report.json");
    const cli = spawnSync(process.execPath, ["scripts/validate-scene-reality.mjs", "--", "--report", separatorReportPath], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Scene reality 0\.3\.1 is valid/);
    assert.equal((await json(separatorReportPath)).result, "valid");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
