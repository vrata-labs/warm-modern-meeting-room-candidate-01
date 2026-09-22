import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { fileRecord, loadReleaseAcceptanceIndex, repositoryFilePath } from "./release-acceptance.mjs";
import { packageGlb } from "../source/releases/0.3.4/package-glb.mjs";

export async function validateShippingRelease(root, { record, lock, visualParityConfig }, manifestRelease) {
  const json = async path => JSON.parse(await readFile(repositoryFilePath(root, path), "utf8"));
  const verify = async input => assert.deepEqual(await fileRecord(repositoryFilePath(root, input.path)), { sha256: input.sha256, sizeBytes: input.sizeBytes }, `shipping_input_drift:${input.path}`);
  assert.equal(record.version, "0.3.4");
  assert.equal(lock.shipping.baseVersion, "0.3.3");
  assert.equal(lock.shipping.baseSourceLock.path, "source/releases/0.3.3/accepted-source-lock.json");
  assert.equal(lock.shipping.baseSourceLock.sha256, "f9693c28cb7184449dc0f8e0075cae08e241edc1a7d6dbac047605c5ea7f1d61");
  assert.equal(lock.shipping.baseGlb.path, "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.glb");
  await verify(lock.shipping.baseSourceLock);
  await verify(lock.shipping.baseGlb);
  for (const input of lock.shipping.inputs) await verify(input);
  const base = await json(lock.shipping.baseSourceLock.path);
  assert.equal(base.visualQuality.humanAcceptance, "accepted");
  assert.deepEqual(lock.shipping.acceptedSource, base.acceptedSource);
  assert.deepEqual(lock.toolchain, base.toolchain);
  for (const [key, path] of Object.entries(base.acceptedSource).filter(([key]) => key.endsWith("Path"))) {
    assert.equal((await fileRecord(join(root, path))).sha256, base.acceptedSource[`${key.slice(0, -4)}Sha256`]);
  }
  const releasePath = "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.4";
  assert.equal(lock.release.path, releasePath);
  assert.equal(manifestRelease.releasePath, releasePath);
  assert.equal(manifestRelease.status, "review");
  assert.equal(manifestRelease.isCurrent, false);
  assert.equal(manifestRelease.publicationReady, false);
  assert.deepEqual((await readdir(join(root, releasePath))).sort(), ["LICENSES.md", "preview.webp", "scene.glb", "scene.json"]);
  let bundleBytes = 0;
  for (const [name, expected] of Object.entries(manifestRelease.files)) {
    const actual = await fileRecord(join(root, releasePath, name));
    assert.deepEqual(actual, expected, `shipping_file_record_drift:${name}`);
    bundleBytes += actual.sizeBytes;
  }
  assert(bundleBytes <= 15*1024*1024, "shipping_bundle_budget_exceeded");
  const original = await json("assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.json");
  const scene = await json(`${releasePath}/scene.json`);
  for (const key of ["sceneId", "spawnPoints", "anchors", "mediaSurfaces", "bounds", "renderMode", "renderProfile", "rights"]) assert.deepEqual(scene[key], original[key], `shipping_contract_drift:${key}`);
  assert.equal(scene.version, "0.3.4");
  const glb = await readFile(join(root, releasePath, "scene.glb"));
  const rebuilt = await packageGlb(await readFile(join(root, lock.shipping.baseGlb.path)));
  assert(glb.equals(Buffer.from(rebuilt.output)), "shipping_rebuild_mismatch");
  assert.equal(lock.release.glbSha256, rebuilt.report.outputSha256);
  assert.equal(lock.release.sceneManifestSha256, (await fileRecord(join(root, releasePath, "scene.json"))).sha256);
  assert.equal(lock.release.previewSha256, (await fileRecord(join(root, releasePath, "preview.webp"))).sha256);
  assert.deepEqual(lock.shipping.preview.crop, { left: 0, top: 80, width: 1280, height: 720 });
  assert.equal(lock.shipping.preview.sourcePath, "provenance/releases/0.3.4/normal/spawn.png");
  const preview = await sharp(await readFile(join(root, lock.shipping.preview.sourcePath))).extract(lock.shipping.preview.crop).webp({ quality: 90 }).toBuffer();
  assert(preview.equals(await readFile(join(root, releasePath, "preview.webp"))), "shipping_preview_not_from_runtime_spawn");
  assert.deepEqual(lock.shipping.packagingReport, rebuilt.report);
  assert.equal(lock.reproducibility.runs, 2);
  assert.equal(lock.reproducibility.sha256, lock.release.glbSha256);
  const receipt = await json(lock.visualQuality.evidencePath);
  assert.equal(receipt.platformCommit, lock.shipping.platformCommit);
  assert.equal(receipt.baselineGlbSha256, lock.shipping.baseGlb.sha256);
  assert.equal(receipt.candidateGlbSha256, lock.release.glbSha256);
  assert.equal(receipt.views.length, 17);
  const ids = visualParityConfig.views.map(view => view.id);
  assert.deepEqual(receipt.views.map(view => view.id), ids);
  assert.deepEqual(ids, base.reviewViews.map(view => view.id));
  for (const view of receipt.views) {
    assert.equal(view.differentBytes, 0, `shipping_browser_pixels_changed:${view.id}`);
    assert.equal(view.maxDifference, 0);
    assert.equal(view.normalizedRmse, 0);
    const records = receipt.files.filter(file => file.path.endsWith(`/${view.id}.png`));
    assert.equal(records.length, 2);
    for (const input of records) await verify(input);
    assert.equal(records[0].sha256, records[1].sha256, `shipping_browser_pixels_changed:${view.id}`);
  }
  for (const input of receipt.files) await verify(input);
  const captures = await Promise.all(receipt.capturePaths.map(json));
  assert.equal(captures.length, 2);
  assert.deepEqual(captures[0].cameras, captures[1].cameras, "shipping_capture_camera_mismatch");
  for (const capture of captures) {
    assert.equal(capture.platformCommit, receipt.platformCommit);
    assert.equal(capture.debug.state, "loaded");
    assert.equal(capture.debug.failureReason, null);
    assert.deepEqual(capture.debug.missingAssets, []);
    assert.deepEqual(capture.cameras.map(view => view.id), ids);
    assert.equal(capture.debug.meshCount, 133);
    assert.equal(capture.debug.materialCount, 18);
  }
  const runner = await json(receipt.runner.path);
  assert.equal(runner.stats.expected, 1);
  for (const key of ["unexpected", "skipped", "flaky"]) assert.equal(runner.stats[key], 0);
  const normal = await json(receipt.normalEvidencePath);
  assert.equal(normal.completed, true, "shipping_normal_capture_incomplete");
  assert.equal(normal.syntheticReviewPoseUsed, false);
  assert.equal(normal.assetSha256, lock.release.glbSha256);
  assert.equal(normal.platformCommit, lock.shipping.platformCommit);
  assert.deepEqual(normal.seats.map(seat => seat.id), scene.anchors.seatAnchors.map(seat => seat.id));
  for (const seat of normal.seats) {
    assert(seat.authoritativeClaimAndRelease && seat.movementLocked, "shipping_seat_flow_failed");
    for (const axis of ["x", "y", "z"]) assert(Math.abs(seat.returnedRoot[axis]-scene.spawnPoints[0].position[axis]) < .002, "shipping_floor_return_failed");
  }
  assert.deepEqual(normal.surfaces.map(surface => surface.surfaceId).sort(), ["debug-main", "whiteboard-wall"]);
  assert(normal.surfaces.every(surface => surface.observerTextReceived && surface.textureBound && surface.sampledPixels.samples.length > 0), "shipping_surface_content_missing");
  const normalRunner = await json(receipt.normalRunner.path);
  assert.equal(normalRunner.stats.expected, 1);
  for (const key of ["unexpected", "skipped", "flaky"]) assert.equal(normalRunner.stats[key], 0);
  const texels = await json("provenance/releases/0.3.4/browser-texels.json");
  assert.equal(texels.comparisons.length, 2);
  assert(texels.comparisons.every(value => value.maxDifference === 0 && value.differentBytes === 0 && value.digests[0] === value.digests[1]), "shipping_browser_texels_changed");
  assert.equal(lock.shipping.harness.sha256, (await fileRecord(join(root, lock.shipping.harness.path))).sha256);
  assert.equal(lock.shipping.acceptanceBasis, "unchanged-geometry-materials-and-rendered-views-from-accepted-0.3.3");
  const rights = await json(lock.rights.releaseLedgerPath);
  assert.equal(rights.releaseVersion, "0.3.4");
  assert.deepEqual(rights.allowedUse, (await json(base.rights.releaseLedgerPath)).allowedUse);
  assert.equal(rights.approval.decision, "approved");
  assert.equal(rights.approval.basis, "existing-0.3.3-optimization-and-redistribution-permission");
  return rights;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const { acceptances } = await loadReleaseAcceptanceIndex(root);
  const acceptance = acceptances.find(value => value.record.version === "0.3.4");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  await validateShippingRelease(root, acceptance, manifest.releases.find(value => value.version === "0.3.4"));
  console.log("Shipping release 0.3.4: geometry, browser pixels, functional evidence and bundle budget verified.");
}
