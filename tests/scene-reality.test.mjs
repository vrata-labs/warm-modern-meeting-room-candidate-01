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
const realityPath = resolve(root, "source/releases/0.3.0/scene-reality.json");
const scenariosPath = resolve(root, "source/releases/0.3.0/user-scenarios.json");

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
  "debug-main": [[-0.0375, 0.5, -1.6925], [0.0375, 2.485, 1.6925]],
  "exterior-landscape": [[-0.725, 0, -0.275], [0.725, 1.3, 0.275]],
  "exterior-neighbor-building": [[-1.3, 0, -0.72], [1.3, 3, 0.72]],
  "exterior-site": [[-5, -0.18, -5], [5, 0, 5]],
  "main-door": [[-0.55, 0, -0.125], [0.55, 2.2, 0.125]],
  "main-window": [[-1.7, 0.6, -0.1], [1.7, 2.4, 0.1]],
  "media-wall-acoustics": [[-0.035, 1, -0.35], [0.035, 2.3, 0.35]],
  "pendant-fixture": [[-1.05, 2.65, -0.06], [1.05, 3.185, 0.06]],
  "room-shell": [[-3.59, -0.18, -2.59], [3.59, 3.28, 2.59]],
  "route-safe-plant": [[1.88, 0, -0.2], [2.28, 1.5, 0.2]],
  "whiteboard-accessories": [[-0.04, 0.8, -0.35], [0.04, 0.84, 0.35]],
  "whiteboard-marker": [[-0.01, 0.84, -0.09], [0.01, 0.86, 0.09]],
  "whiteboard-wall": [[-0.0375, 0.8, -1.2825], [0.0375, 2.21, 1.2825]]
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
      let bounds = envelope;
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

test("0.3.0 reality and scenario contracts cover the exact final model", async () => {
  const reality = await json(realityPath);
  const scenarios = await json(scenariosPath);
  const realityContext = validateSceneRealityContract(reality);
  const scenarioContext = validateUserScenariosContract(scenarios, realityContext);

  assert.equal(realityContext.objectById.size, 27);
  assert.equal(realityContext.partByKey.size, 139);
  assert.deepEqual(realityContext.partsByStatus, { passive: 56, deferred: 23, interactive: 60 });
  assert.equal(scenarioContext.scenarioCount, 17);
  assert.equal(scenarioContext.scaleRangeCount, 27);
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
  assert.equal(result.meshNodeCount, 139);
  assert.equal(result.objectCount, 27);
  assert.equal(result.scaleRangesValidated, 27);
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
    assert.equal(first.release.meshNodesValidated, 139);
    assert.doesNotMatch(firstBytes, /tmp|sha256|generatedAt/i);

    const separatorReportPath = join(temporary, "separator-report.json");
    const cli = spawnSync(process.execPath, ["scripts/validate-scene-reality.mjs", "--", "--report", separatorReportPath], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Scene reality 0\.3\.0 is valid/);
    assert.equal((await json(separatorReportPath)).result, "valid");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
