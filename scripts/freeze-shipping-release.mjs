import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { fileRecord } from "./release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");
const platform = resolve(process.argv[2] ?? "");
assert(process.argv[2], "platform_capture_checkout_required");
const source = "source/releases/0.3.4";
const provenance = "provenance/releases/0.3.4";
const release = "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.4";
const build = join(root, "build/shipping-0.3.4");
const json = async path => JSON.parse(await readFile(join(root, path), "utf8"));
const record = async path => ({ path, ...await fileRecord(join(root, path)) });
const encoded = value => Buffer.from(JSON.stringify(value, null, 2)+"\n");
const immutable = [source, provenance, release];
for (const args of [["ls-files", "--", ...immutable], ["ls-tree", "-r", "--name-only", "HEAD", "--", ...immutable]]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "", "release_snapshot_already_tracked");
}
async function save(path, bytes) {
  assert(immutable.some(prefix => path.startsWith(prefix+"/")));
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}
async function copy(input, target) { await save(target, await readFile(input)); }
const baseLockPath = "source/releases/0.3.3/accepted-source-lock.json";
const base = await json(baseLockPath);
const config = await json("source/releases/0.3.3/visual-parity-config.json");
const manifest = await json("manifest.json");
const sceneConfig = await json("scene-repository.json");
const scene = await json("assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.json");
const comparison = JSON.parse(await readFile(join(build, "browser-comparison.json"), "utf8"));
assert(comparison.views.length === 17 && comparison.views.every(view => view.differentBytes === 0));
const normal = JSON.parse(await readFile(join(build, "normal/functional.json"), "utf8"));
assert(normal.completed && normal.seats.length === 8 && normal.surfaces.length === 2);
const platformCommit = comparison.platformCommit;
assert.equal(normal.platformCommit, platformCommit);
const runnerRecords = [];
for (const name of ["meeting-shipping-pairs", "meeting-shipping-normal"]) {
  const reportPath = join(platform, "test-results", `${name}.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.stats.expected, 1);
  for (const key of ["unexpected", "skipped", "flaky"]) assert.equal(report.stats[key], 0);
  assert.deepEqual(report.errors, []);
  const target = `${provenance}/${name}-runner.json`;
  await save(target, encoded({ name, stats: report.stats, reportSha256: (await fileRecord(reportPath)).sha256, platformCommit }));
  runnerRecords.push(await record(target));
}
for (const [name, target] of [["scene-shipping-pairs.spec.ts", "capture-pairs.ts"], ["scene-shipping-normal.spec.ts", "capture-normal.ts"]]) {
  await copy(join(platform, "tests/e2e", name), `${source}/${target}`);
}
const views = [];
for (const view of base.reviewViews) {
  const target = `${source}/review/${view.id}.webp`;
  await copy(join(root, view.path), target);
  views.push({ id: view.id, ...await record(target) });
}
const capturedFiles = [];
for (const variant of ["baseline", "candidate", "normal"]) for (const name of await readdir(join(build, variant))) {
  const target = `${provenance}/${variant}/${name}`;
  await copy(join(build, variant, name), target);
  capturedFiles.push(await record(target));
}
await copy(join(build, "browser-texels.json"), `${provenance}/browser-texels.json`);
scene.version = "0.3.4";
scene.notes = "Shipping packaging of the visually accepted 0.3.3 source. Geometry, hierarchy, materials, anchors and the original 8K panorama are retained. Float32 Meshopt encoding and browser-equivalent PNG lightmap packaging reduce bytes without changing any of the 17 compared browser views. Publication and device-acceptance records are separate.";
await save(`${release}/scene.json`, encoded(scene));
await copy(join(build, "scene.glb"), `${release}/scene.glb`);
await copy(join(root, "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/LICENSES.md"), `${release}/LICENSES.md`);
const previewCrop = { left: 0, top: 80, width: 1280, height: 720 };
await save(`${release}/preview.webp`, await sharp(await readFile(join(build, "normal/spawn.png"))).extract(previewCrop).webp({ quality: 90 }).toBuffer());
const files = {};
for (const name of ["LICENSES.md", "preview.webp", "scene.glb", "scene.json"]) files[name] = await fileRecord(join(root, release, name));
const packaging = JSON.parse(await readFile(join(build, "packaging.json"), "utf8"));
assert.equal(files["scene.glb"].sha256, packaging.outputSha256);
const rights = await json(base.rights.releaseLedgerPath);
rights.releaseVersion = "0.3.4";
rights.approval = { ...rights.approval, basis: "existing-0.3.3-optimization-and-redistribution-permission", acceptedBaseVersion: "0.3.3", baseRightsEvidencePath: base.rights.evidencePath };
await save(`${provenance}/release-asset-ledger.json`, encoded(rights));
await save(`${provenance}/rights-verdict.md`, Buffer.from("# Rights inheritance for shipping packaging\n\nThe existing 0.3.3 rights verdict explicitly permits optimization and redistribution. This release uses the same approved source, materials and panorama; it introduces no third-party inputs. See provenance/releases/0.3.3/rights-verdict-2026-09-04.md.\n"));
await save(`${provenance}/visual-verdict.md`, Buffer.from("# Visual acceptance basis\n\nThe accepted visual source is 0.3.3, explicitly selected by the user for the eight-seat product template. This is a packaging derivative, not a new artistic interpretation or a claim of a new human review. Decoded geometry/materials are unchanged; all seventeen baseline/candidate browser PNGs are byte-identical. The original human verdict remains provenance/releases/0.3.3/visual-verdict-2026-09-04.md. Physical-device results and production promotion remain separately recorded.\n"));
await save(`${provenance}/runtime-coordinates.json`, encoded({ schemaVersion: 1, sceneId: scene.sceneId, releaseVersion: "0.3.4", unchangedFrom: "0.3.3", spawnPoints: scene.spawnPoints, anchors: scene.anchors, mediaSurfaces: scene.mediaSurfaces }));
const receipt = { ...comparison, files: [...capturedFiles, ...runnerRecords, await record(`${provenance}/browser-texels.json`)], capturePaths: [`${provenance}/baseline/capture.json`, `${provenance}/candidate/capture.json`], runner: runnerRecords[0], normalRunner: runnerRecords[1], normalEvidencePath: `${provenance}/normal/functional.json` };
await save(`${provenance}/visual-equivalence.json`, encoded(receipt));
const visualConfig = {
  schemaVersion: 1, sceneId: scene.sceneId, releaseVersion: "0.3.4",
  releaseGlb: { path: `${release}/scene.glb`, ...files["scene.glb"] },
  reviewViews: config.reviewViews,
  views: views.map(view => ({ id: view.id, referencePath: view.path, referenceSha256: view.sha256, captureFile: `${view.id}.png` })),
  capture: { platformCommit, width: 960, height: 540, fovConvention: "vertical-camera-angle-y", renderSettings: { environmentIntensity: .35, exposure: 1.2 }, comparison: "all-17-browser-pngs-byte-identical", runner: { executable: "pnpm", argv: ["test:e2e:private-assets", "tests/e2e/scene-shipping-pairs.spec.ts", "--workers=1"], environment: { MEETING_SHIPPING_ROOT: "<candidate-root>", BASE_URL: "<local-platform-origin>", PLAYWRIGHT_REPORT_NAME: "meeting-shipping-pairs" } } }
};
await save(`${source}/visual-parity-config.json`, encoded(visualConfig));
const lock = {
  schemaVersion: 1, sceneId: scene.sceneId, status: "accepted-reproducible-source", acceptedOn: base.acceptedOn,
  acceptedSource: { packagingScriptPath: `${source}/package-glb.mjs`, packagingScriptSha256: (await fileRecord(join(root, source, "package-glb.mjs"))).sha256 },
  toolchain: base.toolchain, reviewViews: views.map(({ id, path, sha256 }) => ({ id, path, sha256 })),
  rights: { decision: "approved", evidencePath: `${provenance}/rights-verdict.md`, releaseLedgerPath: `${provenance}/release-asset-ledger.json` },
  release: { version: "0.3.4", path: release, glbSha256: files["scene.glb"].sha256, sceneManifestSha256: files["scene.json"].sha256, previewSha256: files["preview.webp"].sha256 },
  runtimeCoordinates: { transform: base.runtimeCoordinates.transform, evidencePath: `${provenance}/runtime-coordinates.json` },
  reproducibility: { runs: 2, scope: "two-pinned-Blender-base-exports-then-deterministic-packaging", sha256: files["scene.glb"].sha256 },
  visualQuality: { result: "unchanged-accepted-appearance", humanAcceptance: "accepted", acceptedBaseVersion: "0.3.3", humanAcceptanceEvidencePath: `${provenance}/visual-verdict.md`, evidencePath: `${provenance}/visual-equivalence.json` },
  boundaries: { visualAccepted: true, rightsApproved: true, acceptedSourceStored: true, releaseGlbVerified: true, publicationReady: false },
  shipping: {
    baseVersion: "0.3.3", baseSourceLock: await record(baseLockPath), baseGlb: await record("assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.glb"), acceptedSource: base.acceptedSource,
    platformCommit, acceptanceBasis: "unchanged-geometry-materials-and-rendered-views-from-accepted-0.3.3", packagingReport: packaging,
    preview: { sourcePath: `${provenance}/normal/spawn.png`, crop: previewCrop, quality: 90, reason: "Remove only the top HUD strip from the actual normal spawn capture" },
    harness: await record(`${source}/capture-pairs.ts`), normalHarness: await record(`${source}/capture-normal.ts`),
    inputs: await Promise.all([`${source}/package-glb.mjs`, `${source}/capture-pairs.ts`, `${source}/capture-normal.ts`, `${source}/visual-parity-config.json`, `${provenance}/visual-equivalence.json`, `${provenance}/rights-verdict.md`, `${provenance}/visual-verdict.md`, `${provenance}/release-asset-ledger.json`, `${provenance}/runtime-coordinates.json`].map(record))
  }
};
await save(`${source}/accepted-source-lock.json`, encoded(lock));
const index = await json("source/release-acceptance-index.json");
index.releases = index.releases.filter(value => value.version !== "0.3.4");
index.releases.push({ version: "0.3.4", lockPath: `${source}/accepted-source-lock.json`, lockSha256: (await record(`${source}/accepted-source-lock.json`)).sha256, visualParityConfigPath: `${source}/visual-parity-config.json`, visualParityConfigSha256: (await record(`${source}/visual-parity-config.json`)).sha256 });
manifest.releases = manifest.releases.filter(value => value.version !== "0.3.4");
manifest.releases.push({ sceneId: scene.sceneId, version: "0.3.4", status: "review", isCurrent: false, publicationReady: false, releasePath: release, files, stats: structuredClone(manifest.releases.find(value => value.version === "0.3.3").stats) });
manifest.platformValidatorCommit = platformCommit;
sceneConfig.platformValidatorCommit = platformCommit;
await writeFile(join(root, "source/release-acceptance-index.json"), encoded(index));
await writeFile(join(root, "manifest.json"), encoded(manifest));
await writeFile(join(root, "scene-repository.json"), encoded(sceneConfig));
await writeFile(join(root, "platform-validator.lock"), platformCommit+"\n");
console.log(JSON.stringify({ version: "0.3.4", files, platformCommit }, null, 2));
