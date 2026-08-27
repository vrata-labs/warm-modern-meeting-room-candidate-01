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
const projectOwnedLicenseSha256 = "56be457108896a56b706ffcd10d7e1e45778cb33812d98fea6979eb5539fb490";

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
const componentConstructionText = await readFile(join(root, "source/component-constructions.json"), "utf8");
const mediaSurfaceConstructionText = await readFile(join(root, "source/media-surface-constructions.json"), "utf8");
const exteriorConstructionText = await readFile(join(root, "source/exterior-constructions.json"), "utf8");
const lightingConstructionText = await readFile(join(root, "source/lighting-constructions.json"), "utf8");
const assetLedgerText = await readFile(join(root, "provenance/asset-ledger.json"), "utf8");
const generationLedgerText = await readFile(join(root, "provenance/generation-ledger.json"), "utf8");
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
assert(manifest.releases.length === 0, "source_specification_release_manifest_must_remain_empty");
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
