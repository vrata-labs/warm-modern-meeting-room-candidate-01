import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import validator from "gltf-validator";

const root = resolve(import.meta.dirname, "..");
const requiredReleaseFiles = ["LICENSES.md", "preview.webp", "scene.glb", "scene.json"];

function assert(condition, code) {
  if (!condition) throw new Error(code);
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
assert(concept.selection?.conceptId === "concept-03-corrected", "invalid_selected_concept");
assert(concept.selection?.evidence === "interactive-user-approval", "missing_concept_approval");
assert(/^[0-9a-f]{64}$/.test(concept.selection?.previewSha256 ?? ""), "invalid_concept_preview_digest");
assert(concept.selection?.previewIncludedInRepository === false, "concept_preview_must_remain_private");
assert(concept.layoutIntent?.seatCount === 8, "invalid_concept_seat_count");
assert(concept.layoutIntent?.chairOrientation === "seat-facing-table-back-facing-outward", "invalid_chair_orientation");
assert(JSON.stringify(concept.layoutIntent?.roomEnvelopeM) === JSON.stringify({ width: 7, height: 3.1, depth: 5 }), "invalid_concept_room_envelope");
assert(JSON.stringify(concept.layoutIntent?.conferenceTable) === JSON.stringify({
  center: { x: -0.45, y: 0.74, z: 0.05 },
  dimensionsM: { width: 4, height: 0.74, depth: 1.18 },
  yawRadians: -0.20943951
}), "invalid_concept_table_layout");
assert(concept.layoutIntent?.presentationWall === "west" && concept.layoutIntent?.mainWindowWall === "north" && concept.layoutIntent?.entranceWall === "south", "invalid_concept_wall_assignments");
assert(concept.layoutIntent?.composition === "offset-table-axis-with-clear-east-entry-route", "invalid_concept_composition");
assert(concept.boundaries?.approvedCandidateSpecificationCreated === false, "concept_must_not_claim_candidate_specification");
assert(concept.boundaries?.assetRightsCleared === false
  && concept.boundaries?.releaseArtifactsCreated === false
  && concept.boundaries?.previewBinaryIncluded === false
  && concept.boundaries?.publicationReady === false, "concept_must_not_claim_release_readiness");

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
