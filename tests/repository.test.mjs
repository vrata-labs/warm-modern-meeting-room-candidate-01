import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { loadReleaseAcceptanceIndex, selectReleaseAcceptance } from "../scripts/release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");
const validatorCommit = "ec0a8fb118ef9c5589ebb0bd4a9b9047616a56c2";
const platformValidatorCommit = "c54edb2239d225a71e9b934316f70792b3faafb6";
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
  assert.equal(config.platformValidatorCommit, platformValidatorCommit);
  assert.equal((await text("platform-validator.lock")).trim(), platformValidatorCommit);
});

test("manifest preserves the historical prefix and one current release beside append-only review releases", async () => {
  const config = await json("scene-repository.json");
  const manifest = await json("manifest.json");
  assert.equal(manifest.sceneId, config.sceneId);
  assert.equal(manifest.platformValidatorCommit, config.platformValidatorCommit);
  const historicalVersions = ["0.1.0", "0.1.1", "0.1.2", "0.2.0"];
  assert.deepEqual(manifest.releases.slice(0, historicalVersions.length).map(({ version }) => version), historicalVersions);
  assert.deepEqual(manifest.releases.filter(({ isCurrent }) => isCurrent).map(({ version }) => version), ["0.2.0"]);
  assert.deepEqual(manifest.releases.slice(0, 3).map(({ status, isCurrent, supersededBy }) => ({ status, isCurrent, supersededBy })), [
    { status: "superseded", isCurrent: false, supersededBy: "0.1.1" },
    { status: "superseded", isCurrent: false, supersededBy: "0.1.2" },
    { status: "superseded", isCurrent: false, supersededBy: "0.2.0" }
  ]);
  const active = manifest.releases.find(({ version }) => version === "0.2.0");
  assert.deepEqual({ status: active.status, isCurrent: active.isCurrent, supersededBy: active.supersededBy }, {
    status: "active",
    isCurrent: true,
    supersededBy: undefined
  });
  const reviews = manifest.releases.filter(({ version }) => ["0.3.0", "0.3.1", "0.3.2", "0.3.3"].includes(version));
  assert.deepEqual(reviews.map(({ version, status, isCurrent, publicationReady, supersededBy }) => ({ version, status, isCurrent, publicationReady, supersededBy })), [
    { version: "0.3.0", status: "review", isCurrent: false, publicationReady: false, supersededBy: undefined },
    { version: "0.3.1", status: "review", isCurrent: false, publicationReady: false, supersededBy: undefined },
    { version: "0.3.2", status: "review", isCurrent: false, publicationReady: false, supersededBy: undefined },
    { version: "0.3.3", status: "review", isCurrent: false, publicationReady: false, supersededBy: undefined }
  ]);
  assert.ok(manifest.releases.slice(0, 3).every((release) => release.files["scene.glb"].sha256 === "bc987fd7c5931eeccc23cf260011364299c636091e9b82932af2df30db7d95f5"));
  const baked = manifest.releases.find(({ version }) => version === "0.2.0");
  assert.equal(baked.files["scene.glb"].sha256, "ad988d685e32c286d0349144935ee1c47305f71b252de33319dfb967b7b7e7d5");
  assert.equal(reviews[0].files["scene.glb"].sha256, "fa95f93af025ca374b53d81ffef60e5dd6e77c848cc362b56763973ce2140880");
  assert.equal(reviews[1].files["scene.glb"].sha256, "e179ccc1771f2cde544e81837fb918ea8b0d6ce4d5df8d30a48c3a8516114aae");
  assert.equal(reviews[2].files["scene.glb"].sha256, "d62ffc4df7a9d66094179cdcd82a8bc40f45e2e2cbc6e55456993ad21e1f1691");
  assert.equal(reviews[3].files["scene.glb"].sha256, "705999f50ce98c9a6760509ee731610f8e416e53d0f3b48b1d87481d267549d6");
  assert.deepEqual(
    (await readdir(resolve(root, "assets/scenes/warm-modern-meeting-room-candidate-01"))).filter((entry) => entry !== ".gitkeep").sort(),
    manifest.releases.map(({ version }) => version).sort()
  );
});

test("acceptance index iterates locked source, visual config, rights, and release records", async () => {
  const { index, acceptances } = await loadReleaseAcceptanceIndex(root);
  assert.equal(index.sceneId, "warm-modern-meeting-room-candidate-01");
  const legacy = acceptances.find(({ record }) => record.version === "0.2.0");
  assert.equal(legacy.record.lockPath, "source/accepted-source-lock.json");
  assert.equal(legacy.record.visualParityConfigPath, "source/releases/0.2.0/visual-parity-config.json");

  for (const { record, lock, visualParityConfig } of acceptances) {
    assert.equal(lock.status, "accepted-reproducible-source");
    assert.equal(lock.release.version, record.version);
    assert.equal(lock.reproducibility.runs, 2);
    assert.equal(lock.reproducibility.sha256, lock.release.glbSha256);
    for (const [pathKey, repositoryPath] of Object.entries(lock.acceptedSource).filter(([key]) => key.endsWith("Path"))) {
      const digestKey = `${pathKey.slice(0, -4)}Sha256`;
      assert.equal(sha256(await readFile(resolve(root, repositoryPath))), lock.acceptedSource[digestKey]);
    }
    if (lock.captureHarness) {
      assert.equal(sha256(await readFile(resolve(root, lock.captureHarness.patchPath))), lock.captureHarness.patchSha256);
      assert.equal(lock.captureHarness.platformCommit, platformValidatorCommit);
    }
    assert.equal(sha256(await readFile(resolve(root, lock.release.path, "scene.glb"))), lock.release.glbSha256);
    assert.equal(sha256(await readFile(resolve(root, lock.release.path, "scene.json"))), lock.release.sceneManifestSha256);
    assert.deepEqual(
      visualParityConfig.views.map(({ id, referencePath, referenceSha256 }) => ({ id, path: referencePath, sha256: referenceSha256 })),
      lock.reviewViews.map(({ id, path, sha256: digest }) => ({ id, path, sha256: digest }))
    );
    const ledger = await json(lock.rights.releaseLedgerPath);
    assert.equal(ledger.releaseVersion, record.version);
    assert.equal(ledger.approval.decision, "approved");
    assert.equal(ledger.allowedUse.production, true);
    assert.equal(ledger.allowedUse.redistribution, true);
  }

  const { lock } = legacy;
  const ledger = await json(lock.rights.releaseLedgerPath);
  assert.equal(lock.acceptedOn, "2026-08-29");
  assert.equal(lock.reproducibility.scope, "same-host-same-blender-binary-two-run");
  assert.equal(lock.runtimeCoordinates.transform, "x=x,y=y,z=-z");
  assert.deepEqual(lock.boundaries, {
    visualAccepted: true,
    rightsApproved: true,
    acceptedSourceStored: true,
    releaseGlbVerified: true,
    publicationReady: true
  });
  assert.equal(ledger.records.length, 18);
  assert.equal(new Set(ledger.records.map(({ id }) => id)).size, 18);

  const review = acceptances.find(({ record }) => record.version === "0.3.0");
  assert.equal(review.lock.reviewViews.length, 16);
  assert.equal(review.lock.visualQuality.result, "passed");
  assert.equal(review.lock.visualQuality.humanAcceptance, "pending");
  assert.deepEqual(review.lock.boundaries, {
    visualAccepted: false,
    rightsApproved: true,
    acceptedSourceStored: true,
    releaseGlbVerified: true,
    publicationReady: false
  });
  const correction = acceptances.find(({ record }) => record.version === "0.3.1");
  assert.equal(correction.lock.reviewViews.length, 16);
  assert.equal(correction.lock.visualQuality.result, "passed");
  assert.equal(correction.lock.visualQuality.humanAcceptance, "pending");
  assert.deepEqual(correction.lock.boundaries, review.lock.boundaries);
});

test("legacy visual parity policy is versioned and binds capture diagnostics to the exact GLB", async () => {
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  const { visualParityConfig: visual } = acceptances.find(({ record }) => record.version === "0.2.0");
  assert.deepEqual(visual.releaseGlb, {
    path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.2.0/scene.glb",
    sha256: "ad988d685e32c286d0349144935ee1c47305f71b252de33319dfb967b7b7e7d5",
    sizeBytes: 12367932
  });
  assert.deepEqual(visual.capture, {
    bindingFile: "capture-binding.json",
    runtimeDiagnosticsFile: "scene-debug.json",
    requiredState: "loaded",
    requiredFailureReason: null,
    requireNoMissingAssets: true
  });
  assert.deepEqual(Object.fromEntries(visual.views.map(({ id, phashMax, nccMin }) => [id, { phashMax, nccMin }])), {
    entry: { phashMax: 32, nccMin: 0.47 },
    participant: { phashMax: 58, nccMin: 0.64 },
    presenter: { phashMax: 23, nccMin: 0.64 },
    "diagonal-overview": { phashMax: 28, nccMin: 0.4 }
  });
  assert.deepEqual(visual.aggregateThresholds, { phashTotalMax: 130, nccMeanMin: 0.55 });
});

test("0.3.0 visual parity policy binds clean runtime evidence for all reality views", async () => {
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  const { visualParityConfig: visual } = acceptances.find(({ record }) => record.version === "0.3.0");
  assert.equal(visual.capture.platformCommit, platformValidatorCommit);
  assert.deepEqual(visual.capture.platformPatch, {
    path: "source/releases/0.3.0/platform-scene-visual-clean.patch",
    sha256: "a6903e7236939df0bdc52086af831d93cf480f213e2f0edacb99ed2d061fb5f2"
  });
  assert.equal(visual.capture.requiredRenderProfile, "baked-pbr-v1");
  assert.equal(visual.capture.minimumLightMappedMaterialCount, 20);
  assert.deepEqual(visual.capture.expectedRuntime, { meshCount: 139, materialCount: 22, triangleEstimate: 45116 });
  assert.deepEqual(visual.capture.renderSettings, { environmentIntensity: 0.35, exposure: 1.2 });
  assert.deepEqual(visual.capture.cleanVisualMode, {
    stripAnchors: true,
    avatarsEnabled: true,
    avatarFallbackCapsulesEnabled: false,
    avatarSeatsEnabled: false,
    reason: "Interaction anchors and local fallback avatar meshes are validated separately and must not occlude fixed visual-composition evidence."
  });
  assert.equal(visual.capture.runner.command, "pnpm test:e2e -- tests/e2e/scene-visual.spec.ts --workers=1");
  assert.deepEqual(visual.capture.runner.environment, {
    SCENE_VISUAL_STRIP_ANCHORS: "1",
    SCENE_VISUAL_FLIP_Z: "1",
    SCENE_VISUAL_ENVIRONMENT_INTENSITY: "0.35",
    SCENE_VISUAL_EXPOSURE: "1.2"
  });
  assert.deepEqual(visual.capture.runner.batches.flat().sort(), visual.views.map(({ id }) => id).sort());
  assert.equal(visual.views.length, 16);
  assert.deepEqual(visual.views.map(({ id }) => id), [
    "entry", "diagonal-overview",
    "seat-01-display", "seat-02-display", "seat-03-display", "seat-04-display",
    "seat-05-display", "seat-06-display", "seat-07-display", "seat-08-display",
    "whiteboard-standing", "table-underside", "media-wall", "door-detail", "window-detail", "pendant-detail"
  ]);
  assert.deepEqual(visual.aggregateThresholds, { phashTotalMax: 1155, nccMeanMin: 0.44 });
});

test("0.3.1 visual parity policy binds corrected runtime evidence without promotion", async () => {
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  const { lock, visualParityConfig: visual } = acceptances.find(({ record }) => record.version === "0.3.1");
  assert.deepEqual(visual.releaseGlb, {
    path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.1/scene.glb",
    sha256: "e179ccc1771f2cde544e81837fb918ea8b0d6ce4d5df8d30a48c3a8516114aae",
    sizeBytes: 13135452
  });
  assert.equal(visual.capture.platformCommit, platformValidatorCommit);
  assert.deepEqual(visual.capture.platformPatch, {
    path: "source/releases/0.3.1/platform-scene-visual-clean.patch",
    sha256: "389384a0d26f0e8cfdcb82d8c4d345deab46c5fdf3820401ab39520eba5ecb00"
  });
  assert.equal(visual.capture.minimumLightMappedMaterialCount, 19);
  assert.deepEqual(visual.capture.expectedRuntime, { meshCount: 137, materialCount: 21, triangleEstimate: 44740 });
  assert.equal(visual.capture.runner.command, "pnpm test:e2e:private-assets tests/e2e/scene-visual.spec.ts --workers=1");
  assert.equal(visual.capture.runner.executable, "pnpm");
  assert.deepEqual(visual.capture.runner.argv, ["test:e2e:private-assets", "tests/e2e/scene-visual.spec.ts", "--workers=1"]);
  assert.deepEqual(visual.capture.runner.bindingGenerator, {
    executable: "node",
    argv: ["scripts/create-capture-binding.mjs", "--version", "0.3.1"],
    environment: { SCENE_VISUAL_OUTPUT_DIR: "<capture-dir>" }
  });
  assert.equal(visual.capture.runner.environment.SCENE_VISUAL_VIEW_IDS, "<comma-separated runner batch>");
  assert.equal(visual.capture.runner.environment.SCENE_VISUAL_HIDE_MEDIA_SURFACES, "1");
  assert.deepEqual(visual.capture.runner.batches.flat().sort(), visual.views.map(({ id }) => id).sort());
  assert.equal(visual.views.length, 16);
  assert.equal(visual.capture.cleanVisualMode.mediaSurfacesVisible, false);
  assert.equal(lock.visualQuality.humanAcceptance, "pending");
  assert.equal(lock.boundaries.visualAccepted, false);
  assert.equal(lock.boundaries.publicationReady, false);
  const acceptedBlend = await readFile(resolve(root, lock.acceptedSource.blendPath));
  for (const marker of ["/home/", "/mnt/", "/tmp/opencode", "wmmr-candidate-release", "Save As Blender File", "workspaces.blend"]) {
    assert.equal(acceptedBlend.indexOf(marker), -1, `machine-local marker leaked into accepted blend: ${marker}`);
  }
});

test("0.3.2 visual parity policy binds park review evidence without promotion", async () => {
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  const { lock, visualParityConfig: visual } = acceptances.find(({ record }) => record.version === "0.3.2");
  assert.deepEqual(visual.releaseGlb, {
    path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.2/scene.glb",
    sha256: "d62ffc4df7a9d66094179cdcd82a8bc40f45e2e2cbc6e55456993ad21e1f1691",
    sizeBytes: 11744144
  });
  assert.equal(visual.capture.platformCommit, platformValidatorCommit);
  assert.deepEqual(visual.capture.platformPatch, {
    path: "source/releases/0.3.2/platform-scene-visual-clean.patch",
    sha256: "b0306de9d59b6e483de87f447113696f542b6cd076b70f82e37d83d5abb03cd9"
  });
  assert.equal(visual.capture.minimumLightMappedMaterialCount, 23);
  assert.deepEqual(visual.capture.expectedRuntime, { meshCount: 147, materialCount: 27, triangleEstimate: 49264 });
  assert.equal(visual.capture.runner.command, "pnpm test:e2e:private-assets tests/e2e/scene-visual.spec.ts --workers=1");
  assert.deepEqual(visual.capture.runner.batches.flat().sort(), visual.views.map(({ id }) => id).sort());
  assert.equal(visual.views.length, 17);
  assert.ok(visual.views.some(({ id }) => id === "park-view"));
  assert.equal(visual.capture.cleanVisualMode.mediaSurfacesVisible, false);
  assert.deepEqual(visual.aggregateThresholds, { phashTotalMax: 1155, nccMeanMin: 0.44 });
  assert.equal(lock.visualQuality.phashTotal, 1030.8355);
  assert.equal(lock.visualQuality.nccMean, 0.4927856647058823);
  assert.equal(lock.visualQuality.humanAcceptance, "accepted");
  assert.equal(lock.visualQuality.humanAcceptanceEvidencePath, "provenance/releases/0.3.2/visual-verdict-2026-09-03.md");
  assert.equal(lock.boundaries.visualAccepted, true);
  assert.equal(lock.boundaries.publicationReady, false);
});

test("0.3.3 visual parity policy binds the CC0 coastal panorama without promotion", async () => {
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  const { lock, visualParityConfig: visual } = acceptances.find(({ record }) => record.version === "0.3.3");
  const ledger = await json(lock.rights.releaseLedgerPath);
  const scene = await json(`${lock.release.path}/scene.json`);
  assert.deepEqual(visual.releaseGlb, {
    path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.glb",
    sha256: "705999f50ce98c9a6760509ee731610f8e416e53d0f3b48b1d87481d267549d6",
    sizeBytes: 20320032
  });
  assert.equal(visual.capture.platformCommit, platformValidatorCommit);
  assert.deepEqual(visual.capture.platformPatch, {
    path: "source/releases/0.3.3/platform-scene-visual-clean.patch",
    sha256: "897201febe0590988cc9f199367b3099deb79c4397ed70c0eb00202dae3f9755"
  });
  assert.equal(visual.capture.minimumLightMappedMaterialCount, 17);
  assert.deepEqual(visual.capture.expectedRuntime, { meshCount: 133, materialCount: 18, triangleEstimate: 52260 });
  assert.deepEqual(visual.capture.runner.batches.flat().sort(), visual.views.map(({ id }) => id).sort());
  assert.equal(visual.views.length, 17);
  assert.ok(visual.views.some(({ id }) => id === "coastal-view"));
  assert.ok(visual.views.every(({ id }) => id !== "park-view"));
  assert.equal(lock.acceptedSource.panoramaImageSha256, "4e960796faa85fc88d8e8647a713c695bcba92f8b6b27832a28f436428425d30");
  assert.equal(lock.visualQuality.humanAcceptance, "accepted");
  assert.equal(lock.visualQuality.humanAcceptanceEvidencePath, "provenance/releases/0.3.3/visual-verdict-2026-09-04.md");
  assert.equal(lock.boundaries.visualAccepted, true);
  assert.equal(lock.boundaries.rightsApproved, true);
  assert.equal(lock.boundaries.publicationReady, false);
  assert.equal(scene.rights.license, "LicenseRef-Mixed-Project-Owned-CC0-1.0");
  assert.deepEqual(scene.rights.sourceAssets.find(({ id }) => id === "asset-panorama-cannon-poly-haven-cc0"), {
    id: "asset-panorama-cannon-poly-haven-cc0",
    type: "texture",
    author: "Greg Zaal / Poly Haven",
    licenseRef: "LICENSES.md"
  });
  const panoramaRecord = ledger.records.find(({ id }) => id === "asset-panorama-cannon-poly-haven-cc0");
  assert.equal(panoramaRecord.originalSha256, lock.acceptedSource.panoramaImageSha256);
  assert.equal(panoramaRecord.manifestAuthor, "Greg Zaal / Poly Haven");
  assert.equal(panoramaRecord.license.name, "CC0-1.0");
  assert.equal(panoramaRecord.source.publishedMd5, "9125a8a15f6734b0366b1ab8c9e4cefc");
});

test("release commands select 0.3.3 explicitly and preserve legacy lock selection", async () => {
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  assert.equal(selectReleaseAcceptance(acceptances, { version: null, lockPath: "source/accepted-source-lock.json" }).record.version, "0.2.0");
  const packageJson = await json("package.json");
  assert.equal(packageJson.version, "0.3.3");
  assert.match(packageJson.scripts["build:release"], /--version 0\.3\.3$/);
  assert.match(packageJson.scripts["validate:visual"], /--version 0\.3\.3$/);
  assert.match(packageJson.scripts["verify:reproducibility"], /--version 0\.3\.3 --twice$/);
  assert.match(packageJson.scripts["capture:bind"], /create-capture-binding\.mjs --version 0\.3\.3$/);
  const buildScript = await text("scripts/build-release.mjs");
  assert.match(buildScript, /SCENE_BUILD_OUTPUT_ROOT \?\? "build\/releases"/);
  assert.match(buildScript, /"--lightmap"/);
  assert.match(buildScript, /"--scale"/);
  assert.match(buildScript, /"run-1"/);
  assert.match(buildScript, /"run-2"/);
  const withoutSelector = spawnSync(process.execPath, ["scripts/build-release.mjs"], { cwd: root, encoding: "utf8" });
  assert.notEqual(withoutSelector.status, 0);
  assert.match(withoutSelector.stderr, /release_selector_required/);
});

test("capture binding generation is deterministic and records only portable paths", async () => {
  const visual = await json("source/releases/0.3.1/visual-parity-config.json");
  const outputDir = await mkdtemp(join(tmpdir(), "wmmr-capture-binding-"));
  try {
    const captureFiles = [
      ...visual.views.map(({ captureFile }) => captureFile),
      visual.capture.runtimeDiagnosticsFile,
      visual.capture.renderSettingsFile
    ];
    await Promise.all(captureFiles.map((name) => writeFile(join(outputDir, name), `fixture:${name}\n`)));
    const run = () => spawnSync(process.execPath, ["scripts/create-capture-binding.mjs", "--version", "0.3.1"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SCENE_VISUAL_OUTPUT_DIR: outputDir }
    });
    const firstRun = run();
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const first = await readFile(join(outputDir, visual.capture.bindingFile), "utf8");
    const secondRun = run();
    assert.equal(secondRun.status, 0, secondRun.stderr);
    const second = await readFile(join(outputDir, visual.capture.bindingFile), "utf8");
    assert.equal(second, first);
    assert.doesNotMatch(first, new RegExp(outputDir.replaceAll("/", "\\/")));
    const binding = JSON.parse(first);
    assert.deepEqual(binding.captureRunner, visual.capture.runner);
    assert.deepEqual(binding.capturePolicy, visual.capture.cleanVisualMode);
    assert.deepEqual(Object.keys(binding.captureFiles), captureFiles);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("release 0.2.0 preserves its exact runtime coordinates and render metadata", async () => {
  const manifest = await json("manifest.json");
  const spec = await json("source/scene-spec.json");
  const correction = await json("provenance/runtime-coordinate-correction-0.1.1.json");
  const baked = manifest.releases.find(({ version }) => version === "0.2.0");
  const scene = await json(`${baked.releasePath}/scene.json`);

  assert.deepEqual(correction.coordinateTransform, { x: "x", y: "y", z: "-z" });
  assert.equal(correction.verification.repositoryCoordinatesLocked, true);
  assert.equal(correction.verification.staging.status, "passed");
  assert.equal(correction.verification.staging.releaseCommit, "e9891721220bbcda8099d8bbad52e08b3b59427c");
  assert.equal(correction.verification.staging.sceneState, "loaded");
  assert.equal(correction.verification.staging.failureReason, null);
  assert.deepEqual(correction.verification.staging.spawn, {
    id: "main",
    applied: true,
    position: { x: 2.6, y: 0, z: 1.64 }
  });
  assert.deepEqual(correction.verification.staging.diagnostics.missingAssets, []);
  assert.equal(correction.verification.staging.consoleErrorCount, 0);
  assert.equal(scene.version, "0.2.0");
  assert.equal(scene.renderMode, "clean");
  assert.equal(scene.renderProfile, "baked-pbr-v1");
  assert.deepEqual(scene.spawnPoints[0].position, toRuntimePosition(spec.spawn.position));
  const tablePosition = toRuntimePosition(spec.components.find(({ id }) => id === "conference-table").transform.position);
  const dx = tablePosition.x - scene.spawnPoints[0].position.x;
  const dz = tablePosition.z - scene.spawnPoints[0].position.z;
  assert.equal(scene.spawnPoints[0].yaw, Math.atan2(-dx, -dz));
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
  assert.match(workflow, /check-repository-boundary\.mjs --base "\$BASE_SHA"/);
  assert.match(workflow, /release-acceptance-index\.json/);
  assert.match(workflow, /build-release\.mjs --version "\$version" --twice/);
  assert.match(workflow, /platform-scene-visual-clean\.patch/);
  const boundaryScript = await text("scripts/check-repository-boundary.mjs");
  assert.match(boundaryScript, /baseSha === null \|\| baseSha === value/);
  assert.match(boundaryScript, /base_sha_argument_mismatch/);
});
