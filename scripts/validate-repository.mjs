import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import validator from "gltf-validator";

import {
  LEGACY_ACCEPTANCE_VERSION,
  compareVersions,
  loadReleaseAcceptanceIndex,
  repositoryFilePath
} from "./release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");
const requiredReleaseFiles = ["LICENSES.md", "preview.webp", "scene.glb", "scene.json"];
const execFileAsync = promisify(execFile);
const projectOwnedLicenseSha256 = "56be457108896a56b706ffcd10d7e1e45778cb33812d98fea6979eb5539fb490";
const projectOwnedReleaseLicenseSha256 = "a99a2ae2a44522eac4713085699f0623b1f766f0ee26d565153393243fdd2152";

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function assertExactKeys(value, expected, code) {
  assert(value && typeof value === "object" && !Array.isArray(value), code);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function toRuntimePosition(position) {
  return { x: position.x, y: position.y, z: -position.z };
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

function embeddedImageSha256(glb) {
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").replace(/\0+$/, ""));
  const binaryStart = 20 + jsonLength + 8;
  return (gltf.images ?? []).map(({ bufferView }) => {
    const view = gltf.bufferViews[bufferView];
    const bytes = glb.subarray(binaryStart + (view.byteOffset ?? 0), binaryStart + (view.byteOffset ?? 0) + view.byteLength);
    return createHash("sha256").update(bytes).digest("hex");
  });
}

const config = await json(join(root, "scene-repository.json"));
const validatorCommit = (await readFile(join(root, "platform-validator.lock"), "utf8")).trim();
const manifest = await json(join(root, "manifest.json"));
const concept = await json(join(root, "source/concept-selection.json"));
const sceneText = await readFile(join(root, "source/scene-spec.json"), "utf8");
const componentConstructionText = await readFile(join(root, "source/component-constructions.json"), "utf8");
const mediaSurfaceConstructionText = await readFile(join(root, "source/media-surface-constructions.json"), "utf8");
const exteriorConstructionText = await readFile(join(root, "source/exterior-constructions.json"), "utf8");
const lightingConstructionText = await readFile(join(root, "source/lighting-constructions.json"), "utf8");
const assetLedgerText = await readFile(join(root, "provenance/asset-ledger.json"), "utf8");
const generationLedgerText = await readFile(join(root, "provenance/generation-ledger.json"), "utf8");
const { index: releaseAcceptanceIndex, acceptances } = await loadReleaseAcceptanceIndex(root);
const legacyAcceptance = acceptances.find(({ record }) => record.version === LEGACY_ACCEPTANCE_VERSION);
assert(legacyAcceptance, "legacy_release_acceptance_missing");
const acceptedSourceLock = legacyAcceptance.lock;
const releaseAssetLedger = await json(repositoryFilePath(root, acceptedSourceLock.rights.releaseLedgerPath));
const runtimeCoordinateCorrection = await json(repositoryFilePath(root, acceptedSourceLock.runtimeCoordinates.evidencePath));
const bakedLightmapEvidence = await json(repositoryFilePath(root, acceptedSourceLock.visualQuality.evidencePath));
const sceneSpec = JSON.parse(sceneText);
const componentConstruction = JSON.parse(componentConstructionText);
const mediaSurfaceConstruction = JSON.parse(mediaSurfaceConstructionText);
const exteriorConstruction = JSON.parse(exteriorConstructionText);
const lightingConstruction = JSON.parse(lightingConstructionText);
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
const historicalReleaseVersions = ["0.1.0", "0.1.1", "0.1.2", "0.2.0"];
const manifestVersions = manifest.releases.map(({ version }) => version);
assert(manifestVersions.length >= historicalReleaseVersions.length
  && JSON.stringify(manifestVersions.slice(0, historicalReleaseVersions.length)) === JSON.stringify(historicalReleaseVersions), "historical_release_prefix_drift");
assert(manifestVersions.every((version, index) => index === 0 || compareVersions(manifestVersions[index - 1], version) < 0), "manifest_releases_not_sorted");
const currentReleases = manifest.releases.filter(({ isCurrent }) => isCurrent === true);
assert(currentReleases.length === 1 && currentReleases[0].status === "active", "invalid_current_release_set");
for (const release of manifest.releases) {
  if (release.status === "superseded") {
    const successor = manifest.releases.find(({ version }) => version === release.supersededBy);
    assert(release.isCurrent === false && successor
      && compareVersions(release.version, successor.version) < 0, `invalid_superseded_release:${release.version}`);
  } else if (release.status === "active") {
    assert(release.isCurrent === true && !Object.hasOwn(release, "supersededBy"), `invalid_active_release:${release.version}`);
  } else if (release.status === "review") {
    assert(release.isCurrent === false && release.publicationReady === false
      && !Object.hasOwn(release, "supersededBy"), `invalid_review_release:${release.version}`);
  } else {
    throw new Error(`invalid_release_status:${release.version}:${release.status}`);
  }
}
assert(releaseAcceptanceIndex.sceneId === config.sceneId, "release_acceptance_index_scene_mismatch");
const acceptanceVersions = new Set(acceptances.map(({ record }) => record.version));
assert(acceptanceVersions.has(LEGACY_ACCEPTANCE_VERSION), "legacy_release_acceptance_missing");
for (const version of manifestVersions.slice(historicalReleaseVersions.length)) {
  assert(acceptanceVersions.has(version), `release_acceptance_missing:${version}`);
}
for (const version of acceptanceVersions) assert(manifestVersions.includes(version), `accepted_release_manifest_record_missing:${version}`);
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
assert(componentConstruction.sceneId === config.sceneId, "invalid_component_construction_identity");
assert(componentConstruction.sourceRecordId === "asset-component-constructions-project", "invalid_component_construction_source");
assert(componentConstruction.materialSourceRecordId === "asset-layout-project", "invalid_component_material_source");
assert(sceneSpec.components.every(({ sourceRecordId, generationRecordId }) => sourceRecordId === componentConstruction.sourceRecordId && generationRecordId === null), "invalid_component_provenance_binding");
assert(mediaSurfaceConstruction.sceneId === config.sceneId, "invalid_media_surface_construction_identity");
assert(mediaSurfaceConstruction.sourceRecordId === "asset-media-surface-constructions-project", "invalid_media_surface_construction_source");
assert(exteriorConstruction.sceneId === config.sceneId, "invalid_exterior_construction_identity");
assert(exteriorConstruction.sourceRecordId === "asset-exterior-constructions-project", "invalid_exterior_construction_source");
assert(exteriorConstruction.strategy === sceneSpec.exterior.strategy
  && exteriorConstruction.windowOpeningId === sceneSpec.exterior.windowOpeningId
  && JSON.stringify(sceneSpec.exterior.sourceRecordIds) === JSON.stringify([exteriorConstruction.sourceRecordId]), "invalid_exterior_scene_binding");
assert(lightingConstructionText === `${JSON.stringify(lightingConstruction, null, 2)}\n`, "lighting_construction_encoding_noncanonical");
assert(lightingConstruction.sceneId === config.sceneId, "invalid_lighting_construction_identity");
assert(lightingConstruction.sourceRecordId === "asset-lighting-constructions-project", "invalid_lighting_construction_source");
assert(lightingConstruction.styleBibleSha256 === "d8147f9495fb8d2cb50bbccf6849cf272b30b662bffb985b6e46e3c604384656", "invalid_lighting_style_bible_digest");
assert(JSON.stringify(sceneSpec.lighting.map(({ id }) => id)) === JSON.stringify(["window-daylight", "ceiling-fill", "table-pendant"]), "invalid_scene_lighting_order");
assert(JSON.stringify(lightingConstruction.lights.map(({ sceneLightId }) => sceneLightId)) === JSON.stringify(sceneSpec.lighting.map(({ id }) => id)), "invalid_lighting_construction_order");
assert(JSON.stringify(sceneSpec.generator.acceptedInputSha256) === JSON.stringify([
  "978d0c7d75dd73d9c4d4419daa2f1530b0fdfac26c0eee1bcd7ef4e76501272a",
  sceneContractLock.componentConstructionRawSha256,
  sceneContractLock.mediaSurfaceConstructionRawSha256,
  sceneContractLock.exteriorConstructionRawSha256,
  sceneContractLock.lightingConstructionRawSha256
]), "invalid_generator_accepted_inputs");
assert(sceneSpec.materialRecipes?.length === 5, "invalid_candidate_material_count");
assert(sceneSpec.materialRecipes.every(({ sourceRecordId }) => sourceRecordId === componentConstruction.materialSourceRecordId), "invalid_component_material_provenance_binding");
assert(JSON.stringify(sceneSpec.materialRecipes.find(({ id }) => id === "muted-grey-green-fabric")) === JSON.stringify({
  id: "muted-grey-green-fabric",
  category: "fabric",
  baseColorSrgb: "#77877B",
  roughness: 0.8,
  metalness: 0,
  textureScaleM: 0.003,
  sourceRecordId: "asset-layout-project"
}), "invalid_muted_grey_green_material");
assert(assetLedger.sceneId === config.sceneId && assetLedger.records?.length === 5, "invalid_candidate_asset_ledger");
assert(generationLedger.sceneId === config.sceneId && generationLedger.records?.length === 0, "invalid_candidate_generation_ledger");
assertExactKeys(sceneContractLock, [
  "schemaVersion", "status", "sceneId", "validatorRepository", "validatorCommit",
  "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "componentConstructionSha256", "componentConstructionRawSha256",
  "mediaSurfaceConstructionSha256", "mediaSurfaceConstructionRawSha256",
  "exteriorConstructionSha256", "exteriorConstructionRawSha256",
  "lightingConstructionSha256", "lightingConstructionRawSha256", "styleBibleSha256",
  "assetRecordCount", "generationRecordCount", "familyCount", "partCount",
  "overrideCount", "componentCount", "resolvedComponentCount", "materialCount",
  "resolvedMaterialCount", "seatCount", "minimumRouteWidthM", "objectNamePattern",
  "surfaceCount", "resolvedSurfaceCount", "representation", "exteriorObjectCount",
  "exteriorResolvedObjectCount", "exteriorMaterialCount", "exteriorRoleCount",
  "exteriorStrategy", "exteriorWindowOpeningId", "exteriorObjectNamePattern",
  "exteriorBoundsM", "lightCount", "resolvedLightCount", "lightingObjectNamePattern",
  "resolvedIntensityOutputs", "firstViewAcceptance", "boundaries"
], "invalid_scene_contract_lock_keys");
assertExactKeys(sceneContractLock.boundaries, [
  "releaseAssetsApproved", "componentsCompiled", "mediaSurfacesCompiled",
  "exteriorCompiled", "lightingCompiled", "firstViewRendered",
  "firstViewAcceptanceVerified", "finalCandidateGlbVerified",
  "sceneBinaryCreated", "previewBinaryIncluded", "publicationReady"
], "invalid_scene_contract_boundary_keys");
assert(sceneContractLock.schemaVersion === 5
  && sceneContractLock.status === "exact-lighting-construction-specification-valid"
  && sceneContractLock.validatorRepository === "vrata-labs/warm-modern-meeting-room-scene-factory"
  && sceneContractLock.validatorCommit === "ec0a8fb118ef9c5589ebb0bd4a9b9047616a56c2", "invalid_scene_contract_lock");
assert(sceneContractLock.specificationSha256 === canonicalSha256(sceneSpec), "scene_specification_digest_drift");
assert(sceneContractLock.assetLedgerSha256 === canonicalSha256(assetLedger), "asset_ledger_digest_drift");
assert(sceneContractLock.generationLedgerSha256 === canonicalSha256(generationLedger), "generation_ledger_digest_drift");
assert(sceneContractLock.componentConstructionSha256 === canonicalSha256(componentConstruction), "component_construction_digest_drift");
assert(sceneContractLock.componentConstructionRawSha256 === (await fileRecord(join(root, "source/component-constructions.json"))).sha256, "component_construction_raw_digest_drift");
assert(sceneContractLock.mediaSurfaceConstructionSha256 === canonicalSha256(mediaSurfaceConstruction), "media_surface_construction_digest_drift");
assert(sceneContractLock.mediaSurfaceConstructionRawSha256 === (await fileRecord(join(root, "source/media-surface-constructions.json"))).sha256, "media_surface_construction_raw_digest_drift");
assert(sceneContractLock.exteriorConstructionSha256 === canonicalSha256(exteriorConstruction), "exterior_construction_digest_drift");
assert(sceneContractLock.exteriorConstructionRawSha256 === (await fileRecord(join(root, "source/exterior-constructions.json"))).sha256, "exterior_construction_raw_digest_drift");
assert(sceneContractLock.lightingConstructionSha256 === canonicalSha256(lightingConstruction), "lighting_construction_digest_drift");
assert(sceneContractLock.lightingConstructionRawSha256 === (await fileRecord(join(root, "source/lighting-constructions.json"))).sha256, "lighting_construction_raw_digest_drift");
assert(sceneContractLock.styleBibleSha256 === lightingConstruction.styleBibleSha256, "lighting_style_bible_digest_drift");
assert(sceneContractLock.assetRecordCount === assetLedger.records.length
  && sceneContractLock.generationRecordCount === generationLedger.records.length
  && sceneContractLock.familyCount === componentConstruction.families.length
  && sceneContractLock.overrideCount === componentConstruction.instanceMaterialOverrides.length
  && sceneContractLock.componentCount === sceneSpec.components.length
  && sceneContractLock.resolvedComponentCount === sceneSpec.components.length
  && sceneContractLock.materialCount === sceneSpec.materialRecipes.length
  && sceneContractLock.resolvedMaterialCount === 4
  && sceneContractLock.seatCount === sceneSpec.seats.length
  && sceneContractLock.minimumRouteWidthM === sceneSpec.clearance.minimumRouteWidthM
  && sceneContractLock.surfaceCount === mediaSurfaceConstruction.surfaces.length
  && sceneContractLock.resolvedSurfaceCount === sceneSpec.mediaSurfaces.length
  && sceneContractLock.representation === "platform-runtime-plane"
  && sceneContractLock.exteriorObjectCount === exteriorConstruction.objects.length
  && sceneContractLock.exteriorResolvedObjectCount === exteriorConstruction.objects.length
  && sceneContractLock.exteriorMaterialCount === exteriorConstruction.materials.length
  && sceneContractLock.exteriorRoleCount === new Set(exteriorConstruction.objects.map(({ role }) => role)).size
  && sceneContractLock.exteriorStrategy === exteriorConstruction.strategy
  && sceneContractLock.exteriorWindowOpeningId === exteriorConstruction.windowOpeningId
  && sceneContractLock.exteriorObjectNamePattern === "exterior.<objectId>"
  && stableJson(sceneContractLock.exteriorBoundsM) === stableJson(exteriorConstruction.boundsM)
  && sceneContractLock.lightCount === lightingConstruction.lights.length
  && sceneContractLock.resolvedLightCount === sceneSpec.lighting.length
  && sceneContractLock.lightingObjectNamePattern === "light.<sceneLightId>"
  && stableJson(sceneContractLock.firstViewAcceptance) === stableJson(lightingConstruction.firstViewAcceptance), "scene_contract_count_drift");
assert(Object.values(sceneContractLock.boundaries ?? {}).every((value) => value === false), "scene_contract_release_boundaries_must_remain_false");

const expectedAssetSources = new Map([
  ["asset-layout-project", { repositoryPath: "source/concept-selection.json", sha256: "978d0c7d75dd73d9c4d4419daa2f1530b0fdfac26c0eee1bcd7ef4e76501272a", acquiredOn: "2026-08-24" }],
  ["asset-component-constructions-project", { repositoryPath: "source/component-constructions.json", sha256: sceneContractLock.componentConstructionRawSha256, acquiredOn: "2026-08-25" }],
  ["asset-media-surface-constructions-project", { repositoryPath: "source/media-surface-constructions.json", sha256: sceneContractLock.mediaSurfaceConstructionRawSha256, acquiredOn: "2026-08-25" }],
  ["asset-exterior-constructions-project", { repositoryPath: "source/exterior-constructions.json", sha256: sceneContractLock.exteriorConstructionRawSha256, acquiredOn: "2026-08-26" }],
  ["asset-lighting-constructions-project", { repositoryPath: "source/lighting-constructions.json", sha256: sceneContractLock.lightingConstructionRawSha256, acquiredOn: "2026-08-27" }]
]);
assert(JSON.stringify(assetLedger.records.map(({ id }) => id).sort()) === JSON.stringify([...expectedAssetSources.keys()].sort()), "candidate_asset_record_set_drift");
for (const record of assetLedger.records) {
  const expectedSource = expectedAssetSources.get(record.id);
  assert(expectedSource !== undefined, `unexpected_asset_source:${record.id}`);
  assert(record.kind === "project-authored-input"
    && record.source.classification === "project-authored"
    && record.source.publicUrl === null
    && record.source.repositoryPath === expectedSource.repositoryPath, `asset_source_provenance_drift:${record.id}`);
  assert(record.authorProvider === "project-team" && record.acquiredOn === expectedSource.acquiredOn, `asset_source_authorship_drift:${record.id}`);
  const sourceRecord = await fileRecord(join(root, record.source.repositoryPath));
  assert(sourceRecord.sha256 === expectedSource.sha256 && sourceRecord.sha256 === record.originalSha256, `asset_source_digest_drift:${record.id}`);
  assert(JSON.stringify(record.license) === JSON.stringify({
    name: "LicenseRef-Project-Owned",
    reference: "provenance/licenses/project-owned.txt",
    commercialUse: true,
    redistribution: true,
    mlProcessing: true
  }), `asset_license_rights_drift:${record.id}`);
  assert(JSON.stringify(record.allowedUse) === JSON.stringify({
    staging: true,
    production: false,
    webRuntime: true,
    screenshots: true,
    optimization: true,
    redistribution: true
  }), `asset_allowed_use_drift:${record.id}`);
  assert(JSON.stringify(record.modifications) === "[]"
    && JSON.stringify(record.outputSha256) === "[]"
    && record.attribution === null, `asset_source_output_drift:${record.id}`);
}
const projectOwnedLicense = await fileRecord(join(root, "provenance/licenses/project-owned.txt"));
assert(projectOwnedLicense.sha256 === projectOwnedLicenseSha256, "project_owned_license_digest_drift");

const releaseLedgerByVersion = new Map();
for (const { record, lock, visualParityConfig } of acceptances) {
  const version = record.version;
  const expectedReleasePath = `assets/scenes/${config.sceneId}/${version}`;
  const manifestRelease = manifest.releases.find((release) => release.version === version);
  assert(lock.schemaVersion === 1
    && lock.status === "accepted-reproducible-source"
    && lock.sceneId === config.sceneId
    && lock.release?.version === version
    && lock.release?.path === expectedReleasePath, `invalid_release_acceptance_lock:${version}`);
  assert(manifestRelease?.releasePath === expectedReleasePath, `accepted_release_manifest_binding_drift:${version}`);
  assert(lock.rights?.decision === "approved"
    && lock.boundaries?.rightsApproved === true
    && lock.boundaries?.acceptedSourceStored === true
    && lock.boundaries?.releaseGlbVerified === true, `invalid_release_acceptance_boundaries:${version}`);
  if (manifestRelease.status === "review") {
    const visualPending = lock.boundaries.visualAccepted === false
      && lock.visualQuality?.humanAcceptance === "pending";
    const visualAccepted = lock.boundaries.visualAccepted === true
      && lock.visualQuality?.humanAcceptance === "accepted"
      && typeof lock.visualQuality?.humanAcceptanceEvidencePath === "string";
    assert(lock.boundaries.publicationReady === false
      && (visualPending || visualAccepted), `invalid_review_release_acceptance_state:${version}`);
  } else if (manifestRelease.status === "active") {
    assert(lock.boundaries.visualAccepted === true
      && lock.boundaries.publicationReady === true, `active_release_acceptance_missing:${version}`);
  }

  if (lock.captureHarness !== undefined) {
    const harness = lock.captureHarness;
    assert(/^[0-9a-f]{40}$/.test(harness?.platformCommit ?? "")
      && typeof harness?.patchPath === "string"
      && /^[0-9a-f]{64}$/.test(harness?.patchSha256 ?? ""), `invalid_capture_harness_lock:${version}`);
    if (version !== LEGACY_ACCEPTANCE_VERSION) assert(harness.patchPath.startsWith(`source/releases/${version}/`), `versioned_capture_harness_patch_required:${version}`);
    const patchRecord = await fileRecord(repositoryFilePath(root, harness.patchPath, `invalid_capture_harness_patch_path:${version}`));
    assert(patchRecord.sha256 === harness.patchSha256, `capture_harness_patch_digest_drift:${version}`);
    assert(visualParityConfig.capture?.platformCommit === harness.platformCommit
      && visualParityConfig.capture?.platformPatch?.path === harness.patchPath
      && visualParityConfig.capture?.platformPatch?.sha256 === harness.patchSha256, `capture_harness_visual_config_drift:${version}`);
  }

  if (visualParityConfig.capture?.runner !== undefined) {
    const runner = visualParityConfig.capture.runner;
    assert(typeof runner?.command === "string" && runner.command.length > 0
      && runner.environment && typeof runner.environment === "object" && !Array.isArray(runner.environment)
      && Array.isArray(runner.batches) && runner.batches.every((batch) => Array.isArray(batch) && batch.length > 0), `invalid_capture_runner:${version}`);
    const batchViews = runner.batches.flat();
    assert(new Set(batchViews).size === batchViews.length
      && JSON.stringify([...batchViews].sort()) === JSON.stringify(visualParityConfig.views.map(({ id }) => id).sort()), `capture_runner_view_coverage_drift:${version}`);
    if (compareVersions(version, "0.3.1") >= 0) {
      assert(runner.executable === "pnpm"
        && JSON.stringify(runner.argv) === JSON.stringify(["test:e2e:private-assets", "tests/e2e/scene-visual.spec.ts", "--workers=1"])
        && runner.bindingGenerator?.executable === "node"
        && JSON.stringify(runner.bindingGenerator.argv) === JSON.stringify(["scripts/create-capture-binding.mjs", "--version", version])
        && runner.bindingGenerator.environment?.SCENE_VISUAL_OUTPUT_DIR === "<capture-dir>", `capture_runner_invocation_drift:${version}`);
    }
  }

  const sourcePrefix = `source/releases/${version}/`;
  const provenancePrefix = `provenance/releases/${version}/`;
  const acceptedInputEntries = Object.entries(lock.acceptedSource ?? {}).filter(([key]) => key.endsWith("Path"));
  assert(acceptedInputEntries.length > 0, `accepted_source_inputs_missing:${version}`);
  for (const [pathKey, repositoryPath] of acceptedInputEntries) {
    const digestKey = `${pathKey.slice(0, -4)}Sha256`;
    assert(typeof repositoryPath === "string" && /^[0-9a-f]{64}$/.test(lock.acceptedSource[digestKey] ?? ""), `invalid_accepted_source_record:${version}:${pathKey}`);
    if (version !== LEGACY_ACCEPTANCE_VERSION) assert(repositoryPath.startsWith(sourcePrefix), `versioned_accepted_source_path_required:${version}:${pathKey}`);
    assert((await fileRecord(repositoryFilePath(root, repositoryPath))).sha256 === lock.acceptedSource[digestKey], `accepted_source_digest_drift:${version}:${pathKey}`);
  }
  assert(Array.isArray(lock.reviewViews) && lock.reviewViews.length > 0, `accepted_review_views_missing:${version}`);
  for (const reviewView of lock.reviewViews) {
    if (version !== LEGACY_ACCEPTANCE_VERSION) assert(reviewView.path.startsWith(sourcePrefix), `versioned_review_path_required:${version}:${reviewView.id}`);
    assert((await fileRecord(repositoryFilePath(root, reviewView.path))).sha256 === reviewView.sha256, `accepted_review_digest_drift:${version}:${reviewView.id}`);
  }

  const provenancePaths = [
    ["rightsEvidence", lock.rights?.evidencePath],
    ["releaseLedger", lock.rights?.releaseLedgerPath],
    ["runtimeCoordinates", lock.runtimeCoordinates?.evidencePath],
    ["visualQuality", lock.visualQuality?.evidencePath]
  ];
  if (lock.visualQuality?.humanAcceptanceEvidencePath !== undefined) {
    provenancePaths.push(["humanVisualAcceptance", lock.visualQuality.humanAcceptanceEvidencePath]);
  }
  for (const [pathKey, repositoryPath] of provenancePaths) {
    assert(typeof repositoryPath === "string", `accepted_provenance_path_missing:${version}:${pathKey}`);
    if (version !== LEGACY_ACCEPTANCE_VERSION) assert(repositoryPath.startsWith(provenancePrefix), `versioned_provenance_path_required:${version}:${pathKey}`);
    await readFile(repositoryFilePath(root, repositoryPath));
  }

  const releaseLedger = await json(repositoryFilePath(root, lock.rights.releaseLedgerPath));
  assert(releaseLedger.schemaVersion === 1 && releaseLedger.sceneId === config.sceneId
    && releaseLedger.releaseVersion === version, `invalid_release_asset_ledger:${version}`);
  const releaseRecordIds = releaseLedger.records?.map(({ id }) => id) ?? [];
  assert(releaseRecordIds.length > 0 && new Set(releaseRecordIds).size === releaseRecordIds.length,
    `invalid_release_asset_record_set:${version}`);
  for (const assetRecord of releaseLedger.records) {
    if (assetRecord.repositoryPath !== undefined) {
      assert((await fileRecord(repositoryFilePath(root, assetRecord.repositoryPath))).sha256 === assetRecord.originalSha256,
        `release_asset_digest_drift:${version}:${assetRecord.id}`);
    }
    if (assetRecord.license?.reference !== undefined) {
      await readFile(repositoryFilePath(root, assetRecord.license.reference, `invalid_asset_license_path:${version}:${assetRecord.id}`));
    }
  }
  assert(releaseLedger.approval?.decision === "approved"
    && releaseLedger.allowedUse?.staging === true
    && releaseLedger.allowedUse?.production === true
    && releaseLedger.allowedUse?.webRuntime === true
    && releaseLedger.allowedUse?.screenshots === true
    && releaseLedger.allowedUse?.optimization === true
    && releaseLedger.allowedUse?.redistribution === true, `invalid_release_rights_scope:${version}`);
  await readFile(repositoryFilePath(root, releaseLedger.license?.reference, `invalid_release_license_path:${version}`));
  releaseLedgerByVersion.set(version, releaseLedger);
  const releaseGlb = await fileRecord(join(root, expectedReleasePath, "scene.glb"));
  const releaseSceneManifest = await fileRecord(join(root, expectedReleasePath, "scene.json"));
  const releasePreview = await fileRecord(join(root, expectedReleasePath, "preview.webp"));
  assert(releaseGlb.sha256 === lock.release.glbSha256
    && releaseSceneManifest.sha256 === lock.release.sceneManifestSha256
    && releasePreview.sha256 === lock.release.previewSha256, `accepted_release_file_digest_drift:${version}`);
  assert(manifestRelease.files?.["scene.glb"]?.sha256 === releaseGlb.sha256
    && manifestRelease.files?.["scene.glb"]?.sizeBytes === releaseGlb.sizeBytes, `accepted_release_glb_manifest_drift:${version}`);
  assert(visualParityConfig.releaseGlb?.path === `${expectedReleasePath}/scene.glb`
    && visualParityConfig.releaseGlb?.sha256 === releaseGlb.sha256
    && visualParityConfig.releaseGlb?.sizeBytes === releaseGlb.sizeBytes, `visual_parity_release_binding_drift:${version}`);
  assert(JSON.stringify(visualParityConfig.views?.map(({ id, referencePath, referenceSha256 }) => ({ id, path: referencePath, sha256: referenceSha256 })))
    === JSON.stringify(lock.reviewViews.map(({ id, path, sha256 }) => ({ id, path, sha256 }))), `visual_parity_review_binding_drift:${version}`);

  const visualEvidence = await json(repositoryFilePath(root, lock.visualQuality.evidencePath));
  assert(visualEvidence.sceneId === config.sceneId && visualEvidence.releaseVersion === version, `visual_quality_evidence_identity_drift:${version}`);
  if (manifestRelease.status === "review") {
    assert(visualEvidence.schemaVersion === 1
      && visualEvidence.acceptanceLockPath === record.lockPath
      && visualEvidence.passed === true, `invalid_review_visual_evidence:${version}`);
    assert(JSON.stringify(visualEvidence.releaseGlb) === JSON.stringify(visualParityConfig.releaseGlb), `review_visual_release_binding_drift:${version}`);
    assert(visualEvidence.platformCommit === visualParityConfig.capture?.platformCommit
      && JSON.stringify(visualEvidence.capturePolicy) === JSON.stringify(visualParityConfig.capture?.cleanVisualMode)
      && JSON.stringify(visualEvidence.captureRunner) === JSON.stringify(visualParityConfig.capture?.runner)
      && JSON.stringify(visualEvidence.renderSettings) === JSON.stringify(visualParityConfig.capture?.renderSettings), `review_visual_capture_binding_drift:${version}`);
    if (visualParityConfig.capture?.platformPatch !== undefined) {
      assert(visualEvidence.platformPatch?.path === visualParityConfig.capture.platformPatch.path
        && visualEvidence.platformPatch?.sha256 === visualParityConfig.capture.platformPatch.sha256
        && Number.isInteger(visualEvidence.platformPatch?.sizeBytes)
        && visualEvidence.platformPatch.sizeBytes > 0, `review_visual_platform_patch_drift:${version}`);
    }
    assert(JSON.stringify(visualEvidence.aggregateThresholds) === JSON.stringify(visualParityConfig.aggregateThresholds)
      && Math.abs(visualEvidence.aggregate?.phashTotal - lock.visualQuality.phashTotal) <= 0.0001
      && Math.abs(visualEvidence.aggregate?.nccMean - lock.visualQuality.nccMean) <= 0.0001, `review_visual_aggregate_drift:${version}`);
    assert(JSON.stringify(visualEvidence.views?.map(({ view, threshold, passed }) => ({ view, threshold, passed })))
      === JSON.stringify(visualParityConfig.views.map(({ id, phashMax, nccMin }) => ({
        view: id,
        threshold: { phashMax, nccMin },
        passed: true
      }))), `review_visual_view_evidence_drift:${version}`);
    assert(visualEvidence.runtimeDiagnostics?.state === visualParityConfig.capture.requiredState
      && visualEvidence.runtimeDiagnostics?.failureReason === visualParityConfig.capture.requiredFailureReason
      && visualEvidence.runtimeDiagnostics?.renderProfile === visualParityConfig.capture.requiredRenderProfile
      && visualEvidence.runtimeDiagnostics?.missingAssets?.length === 0
      && visualEvidence.runtimeDiagnostics?.lightMappedMaterialCount >= visualParityConfig.capture.minimumLightMappedMaterialCount,
    `review_visual_runtime_diagnostics_drift:${version}`);
  }
}

assert(acceptedSourceLock.schemaVersion === 1
  && acceptedSourceLock.status === "accepted-reproducible-source"
  && acceptedSourceLock.sceneId === config.sceneId
  && acceptedSourceLock.acceptedOn === "2026-08-29", "invalid_accepted_source_lock");
assert(acceptedSourceLock.toolchain?.blenderVersion === manifest.blenderVersion
  && acceptedSourceLock.toolchain?.blenderBuildHash === "84afd5f785f7"
  && acceptedSourceLock.toolchain?.blenderBinarySha256 === "33ac108ebce3c271f5357e5c664d0488717263bcf2145c80300edd0b12c31880"
  && acceptedSourceLock.toolchain?.gltfExporter === "Khronos glTF Blender I/O v4.5.51"
  && acceptedSourceLock.toolchain?.reviewImageConverter === "cwebp 1.6.0"
  && acceptedSourceLock.toolchain?.reviewImageQuality === 90
  && JSON.stringify(acceptedSourceLock.toolchain?.bakedLightmap) === JSON.stringify({
    resolution: 2048,
    samples: 128,
    scale: 0.25,
    device: "CUDA",
    transport: "emissiveTexture TEXCOORD_1 with baked-pbr-v1 metadata"
  }), "accepted_source_toolchain_drift");
for (const [pathKey, digestKey] of [
  ["blendPath", "blendSha256"],
  ["lightmapPath", "lightmapSha256"],
  ["visualCompletionScriptPath", "visualCompletionScriptSha256"],
  ["exportScriptPath", "exportScriptSha256"],
  ["renderScriptPath", "renderScriptSha256"]
]) {
  const path = acceptedSourceLock.acceptedSource?.[pathKey];
  assert(typeof path === "string" && !/(^\/|^[A-Za-z]:[\\/]|^\\\\|\/home\/|\/mnt\/)/.test(path), `invalid_accepted_source_path:${pathKey}`);
  assert((await fileRecord(join(root, path))).sha256 === acceptedSourceLock.acceptedSource[digestKey], `accepted_source_digest_drift:${pathKey}`);
}
assert(acceptedSourceLock.reviewViews?.length === 4
  && JSON.stringify(acceptedSourceLock.reviewViews.map(({ id }) => id)) === JSON.stringify(["entry", "participant", "presenter", "diagonal-overview"]), "invalid_accepted_review_views");
for (const reviewView of acceptedSourceLock.reviewViews) {
  assert((await fileRecord(join(root, reviewView.path))).sha256 === reviewView.sha256, `accepted_review_digest_drift:${reviewView.id}`);
}
assert(acceptedSourceLock.rights?.decision === "approved"
  && acceptedSourceLock.rights?.evidencePath === "provenance/rights-verdict-2026-08-29.md"
  && acceptedSourceLock.rights?.releaseLedgerPath === "provenance/release-asset-ledger.json", "invalid_accepted_rights_binding");
assert(JSON.stringify(acceptedSourceLock.boundaries) === JSON.stringify({
  visualAccepted: true,
  rightsApproved: true,
  acceptedSourceStored: true,
  releaseGlbVerified: true,
  publicationReady: true
}), "invalid_accepted_source_boundaries");
assert(acceptedSourceLock.reproducibility?.scope === "same-host-same-blender-binary-two-run"
  && acceptedSourceLock.reproducibility?.runs === 2
  && acceptedSourceLock.reproducibility?.result === "byte-identical-glb"
  && acceptedSourceLock.reproducibility?.sha256 === acceptedSourceLock.release?.glbSha256, "invalid_reproducibility_evidence");
assert(acceptedSourceLock.runtimeCoordinates?.transform === "x=x,y=y,z=-z"
  && acceptedSourceLock.runtimeCoordinates?.evidencePath === "provenance/runtime-coordinate-correction-0.1.1.json", "invalid_runtime_coordinate_lock");
assert(runtimeCoordinateCorrection.sceneId === config.sceneId
  && runtimeCoordinateCorrection.releaseVersion === "0.1.1"
  && runtimeCoordinateCorrection.supersedes === "0.1.0"
  && JSON.stringify(runtimeCoordinateCorrection.coordinateTransform) === JSON.stringify({ x: "x", y: "y", z: "-z" })
  && runtimeCoordinateCorrection.verification?.repositoryCoordinatesLocked === true
  && runtimeCoordinateCorrection.verification?.staging?.status === "passed"
  && runtimeCoordinateCorrection.verification.staging.releaseCommit === "e9891721220bbcda8099d8bbad52e08b3b59427c"
  && runtimeCoordinateCorrection.verification.staging.sceneState === "loaded"
  && runtimeCoordinateCorrection.verification.staging.failureReason === null
  && runtimeCoordinateCorrection.verification.staging.spawn?.applied === true
  && JSON.stringify(runtimeCoordinateCorrection.verification.staging.spawn.position) === JSON.stringify({ x: 2.6, y: 0, z: 1.64 })
  && runtimeCoordinateCorrection.verification.staging.diagnostics?.missingAssets?.length === 0
  && runtimeCoordinateCorrection.verification.staging.consoleErrorCount === 0, "invalid_runtime_coordinate_correction");
assert(bakedLightmapEvidence.sceneId === config.sceneId
  && bakedLightmapEvidence.releaseVersion === acceptedSourceLock.release.version
  && bakedLightmapEvidence.platformCommit === validatorCommit
  && bakedLightmapEvidence.bake?.lightmapSha256 === acceptedSourceLock.acceptedSource.lightmapSha256
  && bakedLightmapEvidence.asset?.glbSha256 === acceptedSourceLock.release.glbSha256
  && bakedLightmapEvidence.localRuntime?.state === "loaded"
  && bakedLightmapEvidence.localRuntime?.missingAssets?.length === 0
  && bakedLightmapEvidence.visualParity?.result === "passed", "invalid_baked_lightmap_evidence");

assert(releaseAssetLedger.schemaVersion === 1
  && releaseAssetLedger.sceneId === config.sceneId
  && releaseAssetLedger.releaseVersion === acceptedSourceLock.release.version, "invalid_release_asset_ledger");
assert(releaseAssetLedger.approval?.decision === "approved"
  && releaseAssetLedger.approval?.approvedOn === acceptedSourceLock.acceptedOn
  && releaseAssetLedger.approval?.ownerRole === "human-rights-owner"
  && releaseAssetLedger.approval?.evidencePath === acceptedSourceLock.rights.evidencePath, "invalid_release_rights_approval");
assert(releaseAssetLedger.upstreamLedgerPath === "provenance/asset-ledger.json"
  && JSON.stringify([...releaseAssetLedger.upstreamSourceRecordIds].sort()) === JSON.stringify(assetLedger.records.map(({ id }) => id).sort()), "invalid_release_upstream_provenance");
assert(JSON.stringify(releaseAssetLedger.license) === JSON.stringify({
  name: "LicenseRef-Project-Owned-Release",
  reference: "provenance/licenses/project-owned-release.txt",
  commercialUse: true,
  redistribution: true,
  mlProcessing: true
}), "invalid_release_license");
assert(JSON.stringify(releaseAssetLedger.allowedUse) === JSON.stringify({
  staging: true,
  production: true,
  webRuntime: true,
  screenshots: true,
  optimization: true,
  redistribution: true
}), "invalid_release_allowed_use");
assert(JSON.stringify(releaseAssetLedger.reviewImageConversion) === JSON.stringify({
  sourceFormat: "PNG",
  outputFormat: "WebP",
  tool: "cwebp",
  version: "1.6.0",
  quality: 90
}), "invalid_review_image_conversion");
const releaseLicense = await fileRecord(join(root, releaseAssetLedger.license.reference));
assert(releaseLicense.sha256 === projectOwnedReleaseLicenseSha256, "project_owned_release_license_digest_drift");
const releaseRecordIds = releaseAssetLedger.records.map(({ id }) => id);
assert(releaseRecordIds.length === 18 && new Set(releaseRecordIds).size === releaseRecordIds.length, "invalid_release_asset_record_set");
for (const record of releaseAssetLedger.records.filter(({ repositoryPath }) => repositoryPath)) {
  assert((await fileRecord(join(root, record.repositoryPath))).sha256 === record.originalSha256, `release_asset_digest_drift:${record.id}`);
}
const releaseGlbPath = join(root, acceptedSourceLock.release.path, "scene.glb");
const releaseGlb = await readFile(releaseGlbPath);
const releaseGlbSha256 = createHash("sha256").update(releaseGlb).digest("hex");
assert(releaseGlbSha256 === acceptedSourceLock.release.glbSha256, "accepted_release_glb_digest_drift");
assert((await fileRecord(join(root, acceptedSourceLock.release.path, "scene.json"))).sha256 === acceptedSourceLock.release.sceneManifestSha256, "accepted_release_manifest_digest_drift");
assert((await fileRecord(join(root, acceptedSourceLock.release.path, "preview.webp"))).sha256 === acceptedSourceLock.release.previewSha256, "accepted_release_preview_digest_drift");
const textureDigests = releaseAssetLedger.records
  .filter(({ kind }) => kind === "project-authored-generated-texture")
  .map(({ originalSha256 }) => originalSha256)
  .sort();
assert(JSON.stringify(textureDigests) === JSON.stringify(embeddedImageSha256(releaseGlb).sort()), "embedded_texture_provenance_drift");

const sceneFactoryDir = resolve(root, process.env.SCENE_FACTORY_DIR ?? "../warm-modern-meeting-room-scene-factory");
const { stdout: sceneFactoryHead } = await execFileAsync("git", ["-C", sceneFactoryDir, "rev-parse", "HEAD"]);
assert(sceneFactoryHead.trim() === sceneContractLock.validatorCommit, "scene_factory_checkout_commit_mismatch");
const { stdout: sceneFactoryStatus } = await execFileAsync("git", ["-C", sceneFactoryDir, "status", "--porcelain", "--untracked-files=no"]);
assert(sceneFactoryStatus === "", "scene_factory_checkout_tracked_bytes_modified");
const {
  parseComponentConstructionContract,
  parseExteriorConstructionContract,
  parseLightingConstructionContract,
  parseMediaSurfaceConstructionContract
} = await import(pathToFileURL(join(sceneFactoryDir, "compiler/scene-contract.mjs")).href);
const componentReport = parseComponentConstructionContract({ sceneText, assetLedgerText, generationLedgerText, componentConstructionText });
assertExactKeys(componentReport, [
  "status", "sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount",
  "componentConstructionSha256", "componentConstructionRawSha256", "familyCount", "partCount",
  "overrideCount", "resolvedComponentCount", "resolvedMaterialCount", "objectNamePattern", "boundaries"
], "scene_contract_report_keys_drift");
assertExactKeys(componentReport.boundaries, [
  "componentsSpecified", "componentsCompiled", "finalCandidateGlbVerified", "publicationReady"
], "scene_contract_report_boundary_keys_drift");
assert(componentReport.status === "stage3-component-construction-contract-valid", "scene_contract_report_status_drift");
assert(componentReport.sceneId === sceneContractLock.sceneId, "scene_contract_identity_drift");
for (const key of [
  "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "componentConstructionSha256", "componentConstructionRawSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount",
  "familyCount", "partCount", "overrideCount", "resolvedComponentCount",
  "resolvedMaterialCount", "objectNamePattern"
]) {
  assert(componentReport[key] === sceneContractLock[key], `scene_contract_report_drift:${key}`);
}
assert(componentReport.boundaries.componentsSpecified === true, "scene_contract_components_not_specified");
for (const key of ["componentsCompiled", "finalCandidateGlbVerified", "publicationReady"]) {
  assert(componentReport.boundaries[key] === sceneContractLock.boundaries[key], `scene_contract_report_boundary_drift:${key}`);
}

const mediaSurfaceReport = parseMediaSurfaceConstructionContract({ sceneText, assetLedgerText, generationLedgerText, mediaSurfaceConstructionText });
assertExactKeys(mediaSurfaceReport, [
  "status", "sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount",
  "mediaSurfaceConstructionSha256", "mediaSurfaceConstructionRawSha256", "surfaceCount",
  "resolvedSurfaceCount", "representation", "boundaries"
], "media_surface_contract_report_keys_drift");
assertExactKeys(mediaSurfaceReport.boundaries, [
  "mediaSurfacesSpecified", "mediaSurfacesCompiled", "finalCandidateGlbVerified", "publicationReady"
], "media_surface_contract_report_boundary_keys_drift");
assert(mediaSurfaceReport.status === "stage3-media-surface-construction-contract-valid", "media_surface_contract_report_status_drift");
assert(mediaSurfaceReport.sceneId === sceneContractLock.sceneId, "media_surface_contract_identity_drift");
for (const key of [
  "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "mediaSurfaceConstructionSha256", "mediaSurfaceConstructionRawSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount",
  "surfaceCount", "resolvedSurfaceCount", "representation"
]) {
  assert(mediaSurfaceReport[key] === sceneContractLock[key], `media_surface_contract_report_drift:${key}`);
}
assert(mediaSurfaceReport.boundaries.mediaSurfacesSpecified === true, "scene_contract_media_surfaces_not_specified");
for (const key of ["mediaSurfacesCompiled", "finalCandidateGlbVerified", "publicationReady"]) {
  assert(mediaSurfaceReport.boundaries[key] === sceneContractLock.boundaries[key], `media_surface_contract_report_boundary_drift:${key}`);
}
for (const key of ["sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256", "assetRecordCount", "generationRecordCount", "componentCount", "seatCount"]) {
  assert(componentReport[key] === mediaSurfaceReport[key], `scene_contract_common_report_drift:${key}`);
}

const exteriorReport = parseExteriorConstructionContract({ sceneText, assetLedgerText, generationLedgerText, exteriorConstructionText });
assertExactKeys(exteriorReport, [
  "status", "sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount",
  "exteriorConstructionSha256", "exteriorConstructionRawSha256", "objectCount",
  "resolvedObjectCount", "materialCount", "roleCount", "strategy", "windowOpeningId",
  "objectNamePattern", "boundsM", "boundaries"
], "exterior_contract_report_keys_drift");
assertExactKeys(exteriorReport.boundaries, [
  "exteriorSpecified", "exteriorCompiled", "finalCandidateGlbVerified", "publicationReady"
], "exterior_contract_report_boundary_keys_drift");
assert(exteriorReport.status === "stage3-exterior-construction-contract-valid", "exterior_contract_report_status_drift");
assert(exteriorReport.sceneId === sceneContractLock.sceneId, "exterior_contract_identity_drift");
for (const [reportKey, lockKey] of [
  ["specificationSha256", "specificationSha256"],
  ["assetLedgerSha256", "assetLedgerSha256"],
  ["generationLedgerSha256", "generationLedgerSha256"],
  ["assetRecordCount", "assetRecordCount"],
  ["generationRecordCount", "generationRecordCount"],
  ["componentCount", "componentCount"],
  ["seatCount", "seatCount"],
  ["exteriorConstructionSha256", "exteriorConstructionSha256"],
  ["exteriorConstructionRawSha256", "exteriorConstructionRawSha256"],
  ["objectCount", "exteriorObjectCount"],
  ["resolvedObjectCount", "exteriorResolvedObjectCount"],
  ["materialCount", "exteriorMaterialCount"],
  ["roleCount", "exteriorRoleCount"],
  ["strategy", "exteriorStrategy"],
  ["windowOpeningId", "exteriorWindowOpeningId"],
  ["objectNamePattern", "exteriorObjectNamePattern"]
]) assert(exteriorReport[reportKey] === sceneContractLock[lockKey], `exterior_contract_report_drift:${reportKey}`);
assert(stableJson(exteriorReport.boundsM) === stableJson(sceneContractLock.exteriorBoundsM), "exterior_contract_bounds_drift");
assert(exteriorReport.boundaries.exteriorSpecified === true, "scene_contract_exterior_not_specified");
for (const key of ["exteriorCompiled", "finalCandidateGlbVerified", "publicationReady"]) {
  assert(exteriorReport.boundaries[key] === sceneContractLock.boundaries[key], `exterior_contract_report_boundary_drift:${key}`);
}
for (const key of ["sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256", "assetRecordCount", "generationRecordCount", "componentCount", "seatCount"]) {
  assert(componentReport[key] === exteriorReport[key] && mediaSurfaceReport[key] === exteriorReport[key], `scene_contract_all_reports_drift:${key}`);
}

const lightingReport = parseLightingConstructionContract({ sceneText, assetLedgerText, generationLedgerText, lightingConstructionText });
assertExactKeys(lightingReport, [
  "status", "sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount",
  "lightingConstructionSha256", "lightingConstructionRawSha256", "lightCount",
  "resolvedLightCount", "objectNamePattern", "resolvedIntensityOutputs",
  "firstViewAcceptance", "boundaries"
], "lighting_contract_report_keys_drift");
assertExactKeys(lightingReport.boundaries, [
  "lightingSpecified", "firstViewAcceptanceSpecified", "lightingCompiled",
  "firstViewRendered", "firstViewAcceptanceVerified", "finalCandidateGlbVerified",
  "publicationReady"
], "lighting_contract_report_boundary_keys_drift");
assert(lightingReport.status === "stage3-lighting-construction-contract-valid", "lighting_contract_report_status_drift");
for (const [reportKey, lockKey] of [
  ["sceneId", "sceneId"],
  ["specificationSha256", "specificationSha256"],
  ["assetLedgerSha256", "assetLedgerSha256"],
  ["generationLedgerSha256", "generationLedgerSha256"],
  ["assetRecordCount", "assetRecordCount"],
  ["generationRecordCount", "generationRecordCount"],
  ["componentCount", "componentCount"],
  ["seatCount", "seatCount"],
  ["lightingConstructionSha256", "lightingConstructionSha256"],
  ["lightingConstructionRawSha256", "lightingConstructionRawSha256"],
  ["lightCount", "lightCount"],
  ["resolvedLightCount", "resolvedLightCount"],
  ["objectNamePattern", "lightingObjectNamePattern"]
]) assert(lightingReport[reportKey] === sceneContractLock[lockKey], `lighting_contract_report_drift:${reportKey}`);
assert(stableJson(lightingReport.resolvedIntensityOutputs) === stableJson(sceneContractLock.resolvedIntensityOutputs), "lighting_contract_intensity_outputs_drift");
assert(stableJson(lightingReport.firstViewAcceptance) === stableJson(sceneContractLock.firstViewAcceptance), "lighting_contract_first_view_acceptance_drift");
assert(lightingReport.boundaries.lightingSpecified === true, "scene_contract_lighting_not_specified");
assert(lightingReport.boundaries.firstViewAcceptanceSpecified === true, "scene_contract_first_view_acceptance_not_specified");
for (const key of ["lightingCompiled", "firstViewRendered", "firstViewAcceptanceVerified", "finalCandidateGlbVerified", "publicationReady"]) {
  assert(lightingReport.boundaries[key] === sceneContractLock.boundaries[key], `lighting_contract_report_boundary_drift:${key}`);
}

const commonReportKeys = [
  "sceneId", "specificationSha256", "assetLedgerSha256", "generationLedgerSha256",
  "assetRecordCount", "generationRecordCount", "componentCount", "seatCount"
];
const constructionReports = [componentReport, mediaSurfaceReport, exteriorReport, lightingReport];
for (const key of commonReportKeys) {
  assert(constructionReports.every((report) => report[key] === constructionReports[0][key]), `scene_contract_all_reports_drift:${key}`);
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
  if (compareVersions(release.version, "0.1.2") >= 0) assert(scene.version === release.version, `invalid_scene_manifest_version:${releaseKey}`);
  assert(scene.glbPath === "scene.glb" && scene.preview === "preview.webp", `invalid_scene_relative_paths:${releaseKey}`);
  assert(scene.spawnPoints?.[0]?.id === "main", `invalid_main_spawn:${releaseKey}`);
  assert(scene.anchors?.seatAnchors?.length === 8, `invalid_eight_seat_contract:${releaseKey}`);
  assert(new Set(scene.anchors.seatAnchors.map(({ id }) => id)).size === 8, `duplicate_seat_id:${releaseKey}`);
  const surfaces = [...new Set((scene.mediaSurfaces ?? []).map(({ surfaceId }) => surfaceId))].sort();
  assert(JSON.stringify(surfaces) === JSON.stringify(["debug-main", "whiteboard-wall"]), `invalid_surface_contract:${releaseKey}`);
  assert(scene.bounds?.width > 0 && scene.bounds?.height > 0 && scene.bounds?.depth > 0, `invalid_bounds:${releaseKey}`);
  assert(scene.rights?.sourceAssets?.length > 0, `missing_rights_provenance:${releaseKey}`);
  const rightsLedger = releaseLedgerByVersion.get(release.version) ?? (historicalReleaseVersions.includes(release.version) ? releaseAssetLedger : null);
  assert(rightsLedger, `release_rights_ledger_missing:${releaseKey}`);
  const rightsRecordsById = new Map(rightsLedger.records.map((record) => [record.id, record]));
  assert(scene.rights?.owner === "vrata"
    && scene.rights?.license === rightsLedger.license.name
    && ["staging", "production", "web-runtime", "screenshots", "optimization", "redistribution"].every((use) => scene.rights.clearedFor?.includes(use)), `invalid_release_rights:${releaseKey}`);
  assert(scene.rights.sourceAssets.every(({ id, author, licenseRef }) => {
    const record = rightsRecordsById.get(id);
    const expectedAuthor = record?.manifestAuthor
      ?? (record?.authorProvider === "project-team" ? "Vrata project team" : null);
    return record !== undefined && author === expectedAuthor && licenseRef === "LICENSES.md";
  }), `invalid_release_source_asset_binding:${releaseKey}`);
  assert(!/(^\/|^[A-Za-z]:[\\/]|^\\\\|\/home\/|\/mnt\/)/.test(scene.source ?? ""), `private_source_path:${releaseKey}`);
  assert(!/(alpha|beta|curated|ai[- ]?generated)/i.test(scene.label ?? ""), `non_neutral_release_label:${releaseKey}`);
  if (release.status === "review") {
    const acceptance = acceptances.find(({ record }) => record.version === release.version);
    const expectedReviewStage = acceptance?.lock.boundaries?.visualAccepted === true ? "accepted" : "human-acceptance-pending";
    assert(scene.visual?.reviewStage === expectedReviewStage, `review_scene_stage_drift:${releaseKey}`);
  }
  if (release.version === LEGACY_ACCEPTANCE_VERSION) {
    assert(scene.renderMode === "clean" && scene.renderProfile === "baked-pbr-v1", `invalid_legacy_render_profile:${releaseKey}`);
    assert(JSON.stringify(scene.spawnPoints[0].position) === JSON.stringify(toRuntimePosition(sceneSpec.spawn.position)), `runtime_spawn_coordinate_drift:${releaseKey}`);
    const tablePosition = toRuntimePosition(sceneSpec.components.find(({ id }) => id === "conference-table").transform.position);
    const dx = tablePosition.x - scene.spawnPoints[0].position.x;
    const dz = tablePosition.z - scene.spawnPoints[0].position.z;
    assert(scene.spawnPoints[0].yaw === Math.atan2(-dx, -dz), `runtime_spawn_yaw_drift:${releaseKey}`);
    assert(JSON.stringify(scene.anchors.seatAnchors.map(({ id, position, yaw, seatHeight, radius }) => ({ id, position, yaw, seatHeight, radius })))
      === JSON.stringify(sceneSpec.seats.map(({ id, position, yaw, seatHeight, radius }) => ({ id, position: toRuntimePosition(position), yaw, seatHeight, radius }))), `runtime_seat_coordinate_drift:${releaseKey}`);
    assert(JSON.stringify(scene.mediaSurfaces.map(({ surfaceId, transform }) => ({ surfaceId, transform })))
      === JSON.stringify(sceneSpec.mediaSurfaces.map(({ surfaceId, position, yaw }) => ({ surfaceId, transform: { ...toRuntimePosition(position), yaw } }))), `runtime_media_surface_coordinate_drift:${releaseKey}`);
  }
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
