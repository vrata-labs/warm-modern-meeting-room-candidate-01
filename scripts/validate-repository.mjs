import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import validator from "gltf-validator";

const root = resolve(import.meta.dirname, "..");
const requiredReleaseFiles = ["LICENSES.md", "preview.webp", "scene.glb", "scene.json"];
const execFileAsync = promisify(execFile);
const projectOwnedLicenseSha256 = "52e75c4031230e573f309c41b098c8c5976ee5dd451ea42337edf626ff142f35";

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileRecord(path) {
  const bytes = await readFile(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

function primitiveTriangleCount(primitive) {
  const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
  const mode = primitive.getMode();
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

async function glbStats(path) {
  const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path);
  const gltfRoot = document.getRoot();
  const meshes = gltfRoot.listMeshes();
  return {
    triangles: meshes.reduce((total, mesh) => total + mesh.listPrimitives().reduce((sum, primitive) => sum + primitiveTriangleCount(primitive), 0), 0),
    nodes: gltfRoot.listNodes().length,
    meshes: meshes.length,
    primitives: meshes.reduce((total, mesh) => total + mesh.listPrimitives().length, 0),
    materials: gltfRoot.listMaterials().length,
    textures: gltfRoot.listTextures().length,
    animations: gltfRoot.listAnimations().length
  };
}

const config = await json(join(root, "scene-repository.json"));
const validatorCommit = (await readFile(join(root, "platform-validator.lock"), "utf8")).trim();
const manifest = await json(join(root, "manifest.json"));
const concept = await json(join(root, "source/concept-selection.json"));
const sceneText = await readFile(join(root, "source/scene-spec.json"), "utf8");
const assetLedgerText = await readFile(join(root, "provenance/asset-ledger.json"), "utf8");
const generationLedgerText = await readFile(join(root, "provenance/generation-ledger.json"), "utf8");
const sceneSpec = JSON.parse(sceneText);
const assetLedger = JSON.parse(assetLedgerText);
const generationLedger = JSON.parse(generationLedgerText);
const sceneContractLock = await json(join(root, "source/scene-contract-lock.json"));

assert(config.schemaVersion === 1 && config.oneSceneOnly === true, "invalid_scene_repository_config");
assert(config.sceneId === basename(config.repository), "repository_scene_id_mismatch");
assert(config.platformValidatorCommit === validatorCommit, "repository_validator_lock_mismatch");
assert(/^[0-9a-f]{40}$/.test(validatorCommit), "invalid_platform_validator_lock");
assert(manifest.schemaVersion === 1, "invalid_manifest_schema");
assert(manifest.sceneId === config.sceneId, "manifest_scene_id_mismatch");
assert(manifest.platformValidatorCommit === validatorCommit, "manifest_validator_lock_mismatch");
assert(manifest.blenderVersion === "4.5.12 LTS", "invalid_manifest_blender_version");
assert(Array.isArray(manifest.releases), "invalid_manifest_releases");
assert(concept.schemaVersion === 1 && concept.sceneId === config.sceneId, "invalid_concept_identity");
assert(concept.status === "approved-low-fidelity-concept", "invalid_concept_status");
assert(concept.selection?.conceptId === "concept-03-functional", "invalid_selected_concept");
assert(concept.selection?.evidence === "interactive-user-approval", "missing_concept_approval");
assert(/^[0-9a-f]{64}$/.test(concept.selection?.previewSha256 ?? ""), "invalid_concept_preview_digest");
assert(concept.selection?.previewIncludedInRepository === false, "concept_preview_must_remain_private");
assert(concept.layoutIntent?.seatCount === 8, "invalid_concept_seat_count");
assert(concept.layoutIntent?.chairOrientation === "seat-facing-table-back-facing-outward", "invalid_chair_orientation");
assert(JSON.stringify(concept.layoutIntent?.roomEnvelopeM) === JSON.stringify({ width: 7, height: 3.1, depth: 5 }), "invalid_concept_room_envelope");
assert(JSON.stringify(concept.layoutIntent?.conferenceTable) === JSON.stringify({
  center: { x: -0.45, y: 0.74, z: 0.05 },
  dimensionsM: { width: 4, height: 0.74, depth: 1.18 },
  yawRadians: 0
}), "invalid_concept_table_layout");
assert(concept.layoutIntent?.presentationWall === "west" && concept.layoutIntent?.mainWindowWall === "north" && concept.layoutIntent?.entranceWall === "south", "invalid_concept_wall_assignments");
assert(concept.layoutIntent?.composition === "offset-straight-table-axis-with-clear-east-entry-route", "invalid_concept_composition");
assert(concept.boundaries?.approvedCandidateSpecificationCreated === true, "approved_candidate_specification_missing");
assert(concept.boundaries?.assetRightsCleared === false
  && concept.boundaries?.releaseArtifactsCreated === false
  && concept.boundaries?.previewBinaryIncluded === false
  && concept.boundaries?.publicationReady === false, "concept_must_not_claim_release_readiness");
assert(sceneSpec.sceneId === config.sceneId && sceneSpec.clearance?.minimumRouteWidthM === 0.9, "invalid_candidate_scene_specification");
assert(sceneSpec.generator?.commit === sceneContractLock.validatorCommit, "candidate_generator_validator_drift");
assert(sceneSpec.components?.length === 11 && sceneSpec.seats?.length === 8 && sceneSpec.clearance?.routes?.length === 10, "invalid_candidate_contract_counts");
assert(sceneSpec.components.find(({ id }) => id === "conference-table")?.transform?.yaw === 0, "candidate_table_must_remain_route_safe");
assert(sceneSpec.seats.every((seat) => sceneSpec.components.some(({ id, transform }) => id === seat.componentId && JSON.stringify(transform.position) === JSON.stringify(seat.position) && transform.yaw === seat.yaw)), "candidate_seat_component_drift");
assert(assetLedger.sceneId === config.sceneId && assetLedger.records?.length === 1, "invalid_candidate_asset_ledger");
assert(generationLedger.sceneId === config.sceneId && generationLedger.records?.length === 0, "invalid_candidate_generation_ledger");
assert(sceneContractLock.status === "approved-candidate-specification-valid" && sceneContractLock.validatorCommit === "fa9767913fc3cc2b1d06fc00c44ed6a26369b219", "invalid_scene_contract_lock");
assert(sceneContractLock.specificationSha256 === canonicalSha256(sceneSpec), "scene_specification_digest_drift");
assert(sceneContractLock.assetLedgerSha256 === canonicalSha256(assetLedger), "asset_ledger_digest_drift");
assert(sceneContractLock.generationLedgerSha256 === canonicalSha256(generationLedger), "generation_ledger_digest_drift");
assert(sceneContractLock.componentCount === sceneSpec.components.length && sceneContractLock.seatCount === sceneSpec.seats.length, "scene_contract_count_drift");
assert(Object.values(sceneContractLock.boundaries ?? {}).every((value) => value === false), "scene_contract_release_boundaries_must_remain_false");

for (const record of assetLedger.records) {
  const sourceRecord = await fileRecord(join(root, record.source.repositoryPath));
  assert(sourceRecord.sha256 === record.originalSha256, `asset_source_digest_drift:${record.id}`);
  assert(record.license.reference === "provenance/licenses/project-owned.txt", `asset_license_reference_drift:${record.id}`);
}
const projectOwnedLicense = await fileRecord(join(root, "provenance/licenses/project-owned.txt"));
assert(projectOwnedLicense.sha256 === projectOwnedLicenseSha256, "project_owned_license_digest_drift");

const sceneFactoryDir = resolve(root, process.env.SCENE_FACTORY_DIR ?? "../warm-modern-meeting-room-scene-factory");
const { stdout: sceneFactoryHead } = await execFileAsync("git", ["-C", sceneFactoryDir, "rev-parse", "HEAD"]);
assert(sceneFactoryHead.trim() === sceneContractLock.validatorCommit, "scene_factory_checkout_commit_mismatch");
const { stdout: sceneFactoryStatus } = await execFileAsync("git", ["-C", sceneFactoryDir, "status", "--porcelain", "--untracked-files=no"]);
assert(sceneFactoryStatus === "", "scene_factory_checkout_tracked_bytes_modified");
const { parseSceneContract } = await import(pathToFileURL(join(sceneFactoryDir, "compiler/scene-contract.mjs")).href);
const semanticReport = parseSceneContract({ sceneText, assetLedgerText, generationLedgerText });
assert(semanticReport.sceneId === sceneContractLock.sceneId, "scene_contract_identity_drift");
for (const key of ["specificationSha256", "assetLedgerSha256", "generationLedgerSha256", "assetRecordCount", "generationRecordCount", "componentCount", "seatCount"]) {
  assert(semanticReport[key] === sceneContractLock[key], `scene_contract_report_drift:${key}`);
}

const releaseKeys = new Set();
for (const release of manifest.releases) {
  assert(release.sceneId === config.sceneId, `foreign_scene_release:${release.sceneId}`);
  assert(/^\d+\.\d+\.\d+$/.test(release.version), `invalid_release_version:${release.version}`);
  const releaseKey = `${release.sceneId}@${release.version}`;
  assert(!releaseKeys.has(releaseKey), `duplicate_release:${releaseKey}`);
  releaseKeys.add(releaseKey);
  const expectedPath = `assets/scenes/${config.sceneId}/${release.version}`;
  assert(release.releasePath === expectedPath, `invalid_release_path:${releaseKey}`);
  const releaseDir = join(root, expectedPath);
  const entries = (await readdir(releaseDir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert(JSON.stringify(entries) === JSON.stringify(requiredReleaseFiles), `invalid_release_files:${releaseKey}`);
  for (const name of requiredReleaseFiles) {
    const actual = await fileRecord(join(releaseDir, name));
    const expected = release.files?.[name];
    assert(expected?.sha256 === actual.sha256 && expected?.sizeBytes === actual.sizeBytes, `release_file_record_mismatch:${releaseKey}:${name}`);
  }
  const scene = await json(join(releaseDir, "scene.json"));
  assert(scene.schemaVersion === 1 && scene.sceneId === config.sceneId, `invalid_scene_manifest_identity:${releaseKey}`);
  assert(scene.glbPath === "scene.glb" && scene.preview === "preview.webp", `invalid_scene_relative_paths:${releaseKey}`);
  assert(scene.spawnPoints?.[0]?.id === "main", `invalid_main_spawn:${releaseKey}`);
  assert(scene.anchors?.seatAnchors?.length === 8, `invalid_eight_seat_contract:${releaseKey}`);
  assert(new Set(scene.anchors.seatAnchors.map(({ id }) => id)).size === 8, `duplicate_seat_id:${releaseKey}`);
  const surfaces = [...new Set((scene.mediaSurfaces ?? []).map(({ surfaceId }) => surfaceId))].sort();
  assert(JSON.stringify(surfaces) === JSON.stringify(["debug-main", "whiteboard-wall"]), `invalid_surface_contract:${releaseKey}`);
  assert(scene.bounds?.width > 0 && scene.bounds?.height > 0 && scene.bounds?.depth > 0, `invalid_bounds:${releaseKey}`);
  assert(scene.rights?.sourceAssets?.length > 0, `missing_rights_provenance:${releaseKey}`);
  assert(!/(^\/|^[A-Za-z]:[\\/]|^\\\\|\/home\/|\/mnt\/)/.test(scene.source ?? ""), `private_source_path:${releaseKey}`);
  assert(!/(alpha|beta|curated|ai[- ]?generated)/i.test(scene.label ?? ""), `non_neutral_release_label:${releaseKey}`);
  const bundleBytes = await Promise.all(requiredReleaseFiles.map((name) => stat(join(releaseDir, name))));
  assert(bundleBytes.reduce((total, info) => total + info.size, 0) <= 40 * 1024 * 1024, `art_bundle_budget_exceeded:${releaseKey}`);
  const glbPath = join(releaseDir, "scene.glb");
  const glb = await readFile(glbPath);
  const gltfReport = await validator.validateBytes(new Uint8Array(glb), { uri: `${releaseKey}/scene.glb`, maxIssues: 200 });
  assert(gltfReport.issues.numErrors === 0, `gltf_validation_failed:${releaseKey}:${gltfReport.issues.numErrors}`);
  const actualStats = await glbStats(glbPath);
  assert(JSON.stringify(release.stats) === JSON.stringify(actualStats), `release_stats_mismatch:${releaseKey}`);
  assert(actualStats.triangles <= 220_000, `art_triangle_budget_exceeded:${releaseKey}`);
  assert(actualStats.nodes <= 1_000, `art_node_budget_exceeded:${releaseKey}`);
  assert(actualStats.meshes <= 600, `art_mesh_budget_exceeded:${releaseKey}`);
  assert(actualStats.materials <= 256, `art_material_budget_exceeded:${releaseKey}`);
  assert(actualStats.textures <= 96, `art_texture_budget_exceeded:${releaseKey}`);
}

const sceneRoot = join(root, "assets/scenes", config.sceneId);
const versionDirectories = (await readdir(sceneRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
assert(JSON.stringify(versionDirectories) === JSON.stringify(manifest.releases.map(({ version }) => version).sort()), "untracked_or_missing_release_directory");

process.stdout.write(`Scene repository is valid (${manifest.releases.length} releases).\n`);
