import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assert,
  fileRecord,
  loadReleaseAcceptanceIndex,
  normalizeRepositoryPath,
  repositoryFilePath
} from "./release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");

function parseArguments(argv) {
  const options = { version: null, configPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split("=", 2);
    if (!["--version", "--config"].includes(name)) throw new Error(`unknown_argument:${argument}`);
    const value = inlineValue ?? argv[++index];
    assert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `missing_argument_value:${name}`);
    const key = name === "--version" ? "version" : "configPath";
    assert(options[key] === null, `duplicate_argument:${name}`);
    options[key] = value;
  }
  assert(options.version || options.configPath, "visual_release_selector_required: use --version or --config");
  return options;
}

function selectAcceptance(acceptances, options) {
  const configPath = options.configPath
    ? normalizeRepositoryPath(options.configPath, "invalid_visual_parity_config_argument")
    : null;
  const byVersion = options.version ? acceptances.find(({ record }) => record.version === options.version) : null;
  const byConfig = configPath ? acceptances.find(({ record }) => record.visualParityConfigPath === configPath) : null;
  if (options.version) assert(byVersion, `release_acceptance_not_found:${options.version}`);
  if (configPath) assert(byConfig, `visual_parity_config_not_indexed:${configPath}`);
  assert(!byVersion || !byConfig || byVersion === byConfig, "visual_release_selector_mismatch");
  return byVersion ?? byConfig;
}

function compare(metric, reference, actual) {
  const result = spawnSync("compare", ["-metric", metric, reference, actual, "null:"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("imagemagick_compare_not_found");
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`image_compare_failed:${metric}:${result.stderr.trim()}`);
  }
  const value = Number.parseFloat(result.stderr.trim().split(/\s+/)[0] ?? "");
  if (!Number.isFinite(value)) throw new Error(`invalid_image_metric:${metric}:${result.stderr.trim()}`);
  return value;
}

function imageMagickVersion() {
  const result = spawnSync("compare", ["-version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("imagemagick_compare_not_found");
  if (result.error || result.status !== 0) throw new Error(`imagemagick_version_failed:${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/, 1)[0].replace(/^Version:\s*/, "").trim();
}

function displayPath(path) {
  const repositoryPath = relative(root, path);
  if (repositoryPath !== ".." && !repositoryPath.startsWith(`..${sep}`) && !isAbsolute(repositoryPath)) {
    return repositoryPath.split(sep).join("/");
  }
  return `external/${basename(path)}`;
}

function boundReleaseGlb(binding) {
  return binding.releaseGlb ?? binding.bindings?.releaseSceneGlb ?? binding.inputs?.sceneGlb;
}

function boundCaptureFile(binding, name) {
  return binding.captureFiles?.[name] ?? binding.files?.[name];
}

function assertBoundFile(actual, bound, name) {
  assert(bound && typeof bound === "object", `capture_binding_file_missing:${name}`);
  assert(basename(bound.path ?? "") === name, `capture_binding_path_mismatch:${name}`);
  assert(bound.sha256 === actual.sha256 && bound.sizeBytes === actual.sizeBytes, `capture_binding_digest_mismatch:${name}`);
}

const options = parseArguments(process.argv.slice(2));
const { index, acceptances } = await loadReleaseAcceptanceIndex(root);
const acceptance = selectAcceptance(acceptances, options);
const { lock, record, visualParityConfig: config } = acceptance;
const version = record.version;

assert(config.schemaVersion === 1, `invalid_visual_parity_config_schema:${version}`);
assert(config.releaseGlb?.path === `${lock.release.path}/scene.glb`, `visual_parity_release_path_drift:${version}`);
assert(config.releaseGlb?.sha256 === lock.release.glbSha256, `visual_parity_release_digest_drift:${version}`);
const releaseGlbPath = repositoryFilePath(root, config.releaseGlb.path, `invalid_visual_parity_release_path:${version}`);
const releaseGlbRecord = await fileRecord(releaseGlbPath);
assert(releaseGlbRecord.sha256 === config.releaseGlb.sha256
  && releaseGlbRecord.sizeBytes === config.releaseGlb.sizeBytes, `visual_parity_release_file_drift:${version}`);
assert(Array.isArray(config.views) && config.views.length > 0, `visual_parity_views_missing:${version}`);
assert(JSON.stringify(config.views.map(({ id }) => id)) === JSON.stringify(lock.reviewViews.map(({ id }) => id)), `visual_parity_review_view_order_drift:${version}`);
for (const [indexValue, view] of config.views.entries()) {
  const acceptedView = lock.reviewViews[indexValue];
  assert(view.referencePath === acceptedView.path && view.referenceSha256 === acceptedView.sha256, `visual_parity_reference_binding_drift:${version}:${view.id}`);
  assert(typeof view.captureFile === "string" && basename(view.captureFile) === view.captureFile, `invalid_visual_capture_file:${version}:${view.id}`);
  assert(Number.isFinite(view.phashMax) && Number.isFinite(view.nccMin), `invalid_visual_threshold:${version}:${view.id}`);
}
assert(Number.isFinite(config.aggregateThresholds?.phashTotalMax)
  && Number.isFinite(config.aggregateThresholds?.nccMeanMin), `invalid_visual_aggregate_threshold:${version}`);

const outputInput = process.env.SCENE_VISUAL_OUTPUT_DIR ?? `build/releases/${version}/runtime-capture`;
const outputDir = isAbsolute(outputInput) ? outputInput : resolve(root, outputInput);
const reportInput = process.env.SCENE_VISUAL_REPORT_PATH ?? `build/releases/${version}/visual-parity.json`;
const reportPath = isAbsolute(reportInput) ? reportInput : resolve(root, reportInput);
const bindingFile = config.capture?.bindingFile;
const diagnosticsFile = config.capture?.runtimeDiagnosticsFile;
const renderSettingsFile = config.capture?.renderSettingsFile;
assert(typeof bindingFile === "string" && basename(bindingFile) === bindingFile, `invalid_capture_binding_file:${version}`);
assert(typeof diagnosticsFile === "string" && basename(diagnosticsFile) === diagnosticsFile, `invalid_runtime_diagnostics_file:${version}`);
if (renderSettingsFile !== undefined) assert(typeof renderSettingsFile === "string" && basename(renderSettingsFile) === renderSettingsFile, `invalid_render_settings_file:${version}`);

const binding = JSON.parse(await readFile(join(outputDir, bindingFile), "utf8"));
const diagnosticsBytes = await readFile(join(outputDir, diagnosticsFile));
const diagnostics = JSON.parse(diagnosticsBytes.toString("utf8"));
const sceneDebug = diagnostics.sceneDebug ?? diagnostics;
assert(binding.schemaVersion === 1 && binding.sceneId === index.sceneId && binding.releaseVersion === version, `invalid_capture_binding_identity:${version}`);
if (config.capture.platformCommit !== undefined) {
  assert(/^[0-9a-f]{40}$/.test(config.capture.platformCommit), `invalid_capture_platform_commit:${version}`);
  assert(binding.platformCommit === config.capture.platformCommit, `capture_platform_commit_drift:${version}`);
}
let platformPatchRecord = null;
if (config.capture.platformPatch !== undefined) {
  const platformPatch = config.capture.platformPatch;
  assert(typeof platformPatch?.path === "string" && /^[0-9a-f]{64}$/.test(platformPatch.sha256 ?? ""), `invalid_capture_platform_patch:${version}`);
  platformPatchRecord = await fileRecord(repositoryFilePath(root, platformPatch.path, `invalid_capture_platform_patch_path:${version}`));
  assert(platformPatchRecord.sha256 === platformPatch.sha256, `capture_platform_patch_digest_drift:${version}`);
  assert(lock.captureHarness?.platformCommit === config.capture.platformCommit
    && lock.captureHarness?.patchPath === platformPatch.path
    && lock.captureHarness?.patchSha256 === platformPatch.sha256, `capture_platform_patch_lock_drift:${version}`);
  assert(JSON.stringify(binding.platformPatch) === JSON.stringify(platformPatch), `capture_platform_patch_binding_drift:${version}`);
}
if (config.capture.runner !== undefined) {
  const runner = config.capture.runner;
  assert(typeof runner?.command === "string" && runner.command.length > 0, `invalid_capture_runner_command:${version}`);
  if (version === "0.3.1") {
    assert(runner.executable === "pnpm" && Array.isArray(runner.argv), `invalid_capture_runner_invocation:${version}`);
    assert(runner.bindingGenerator?.executable === "node"
      && Array.isArray(runner.bindingGenerator.argv)
      && runner.bindingGenerator.environment?.SCENE_VISUAL_OUTPUT_DIR === "<capture-dir>", `invalid_capture_binding_generator:${version}`);
  }
  assert(runner.environment && typeof runner.environment === "object" && !Array.isArray(runner.environment), `invalid_capture_runner_environment:${version}`);
  assert(Array.isArray(runner.batches) && runner.batches.every((batch) => Array.isArray(batch) && batch.length > 0), `invalid_capture_runner_batches:${version}`);
  const batchViews = runner.batches.flat();
  assert(new Set(batchViews).size === batchViews.length
    && JSON.stringify([...batchViews].sort()) === JSON.stringify(config.views.map(({ id }) => id).sort()), `capture_runner_view_coverage_drift:${version}`);
  assert(JSON.stringify(binding.captureRunner) === JSON.stringify(runner), `capture_runner_binding_drift:${version}`);
}
if (config.capture.cleanVisualMode !== undefined) {
  assert(JSON.stringify(binding.capturePolicy) === JSON.stringify(config.capture.cleanVisualMode), `capture_clean_visual_mode_drift:${version}`);
}
const bindingGlb = boundReleaseGlb(binding);
assert(bindingGlb?.path === config.releaseGlb.path
  && bindingGlb?.sha256 === releaseGlbRecord.sha256
  && bindingGlb?.sizeBytes === releaseGlbRecord.sizeBytes, `capture_release_glb_binding_drift:${version}`);
assertBoundFile(await fileRecord(join(outputDir, diagnosticsFile)), boundCaptureFile(binding, diagnosticsFile), diagnosticsFile);
if (renderSettingsFile !== undefined) {
  const renderSettingsRecord = await fileRecord(join(outputDir, renderSettingsFile));
  assertBoundFile(renderSettingsRecord, boundCaptureFile(binding, renderSettingsFile), renderSettingsFile);
  const renderSettings = JSON.parse(await readFile(join(outputDir, renderSettingsFile), "utf8"));
  assert(JSON.stringify(renderSettings) === JSON.stringify(config.capture.renderSettings), `capture_render_settings_drift:${version}`);
}
assert(sceneDebug.state === config.capture.requiredState, `runtime_diagnostics_state_mismatch:${version}`);
assert(sceneDebug.failureReason === config.capture.requiredFailureReason, `runtime_diagnostics_failure_reason:${version}`);
if (config.capture.requireNoMissingAssets) assert(Array.isArray(sceneDebug.missingAssets) && sceneDebug.missingAssets.length === 0, `runtime_diagnostics_missing_assets:${version}`);
assert(sceneDebug.assetBytesLoaded === releaseGlbRecord.sizeBytes
  && sceneDebug.assetBytesExpected === releaseGlbRecord.sizeBytes, `runtime_diagnostics_asset_bytes_mismatch:${version}`);
if (config.capture.requiredRenderProfile !== undefined) assert(sceneDebug.renderProfile === config.capture.requiredRenderProfile, `runtime_render_profile_mismatch:${version}`);
if (config.capture.minimumLightMappedMaterialCount !== undefined) {
  assert(sceneDebug.lightMappedMaterialCount >= config.capture.minimumLightMappedMaterialCount, `runtime_lightmapped_material_count_mismatch:${version}`);
}
for (const [key, expected] of Object.entries(config.capture.expectedRuntime ?? {})) {
  assert(sceneDebug[key] === expected, `runtime_diagnostics_value_mismatch:${version}:${key}`);
}

const results = [];
for (const view of config.views) {
  const reference = repositoryFilePath(root, view.referencePath, `invalid_visual_reference_path:${version}:${view.id}`);
  const actual = join(outputDir, view.captureFile);
  const [referenceRecord, actualRecord] = await Promise.all([fileRecord(reference), fileRecord(actual)]);
  assert(referenceRecord.sha256 === view.referenceSha256, `visual_reference_digest_drift:${version}:${view.id}`);
  assertBoundFile(actualRecord, boundCaptureFile(binding, view.captureFile), view.captureFile);
  const phash = compare("PHASH", reference, actual);
  const ncc = compare("NCC", reference, actual);
  const threshold = { phashMax: view.phashMax, nccMin: view.nccMin };
  results.push({
    view: view.id,
    phash,
    ncc,
    threshold,
    capture: { file: view.captureFile, digest: actualRecord.sha256, sizeBytes: actualRecord.sizeBytes },
    passed: phash <= view.phashMax && ncc >= view.nccMin
  });
}

const phashTotal = results.reduce((total, result) => total + result.phash, 0);
const nccMean = results.reduce((total, result) => total + result.ncc, 0) / results.length;
const report = {
  schemaVersion: 1,
  sceneId: index.sceneId,
  releaseVersion: version,
  acceptanceLockPath: record.lockPath,
  releaseGlb: config.releaseGlb,
  metricTool: "ImageMagick compare",
  metricToolVersion: imageMagickVersion(),
  captureDirectory: displayPath(outputDir),
  captureBindingFile: bindingFile,
  captureBinding: {
    digest: (await fileRecord(join(outputDir, bindingFile))).sha256,
    sizeBytes: (await fileRecord(join(outputDir, bindingFile))).sizeBytes
  },
  platformCommit: config.capture.platformCommit ?? null,
  platformPatch: config.capture.platformPatch === undefined ? null : {
    ...config.capture.platformPatch,
    sizeBytes: platformPatchRecord.sizeBytes
  },
  captureRunner: config.capture.runner ?? null,
  capturePolicy: config.capture.cleanVisualMode ?? null,
  renderSettings: config.capture.renderSettings ?? null,
  runtimeDiagnosticsFile: diagnosticsFile,
  runtimeDiagnostics: {
    digest: (await fileRecord(join(outputDir, diagnosticsFile))).sha256,
    sizeBytes: (await fileRecord(join(outputDir, diagnosticsFile))).sizeBytes,
    state: sceneDebug.state,
    failureReason: sceneDebug.failureReason,
    renderProfile: sceneDebug.renderProfile,
    missingAssets: sceneDebug.missingAssets,
    meshCount: sceneDebug.meshCount,
    materialCount: sceneDebug.materialCount,
    lightMappedMaterialCount: sceneDebug.lightMappedMaterialCount,
    triangleEstimate: sceneDebug.triangleEstimate
  },
  aggregateThresholds: config.aggregateThresholds,
  aggregate: { phashTotal, nccMean },
  views: results,
  passed: results.every(({ passed }) => passed)
    && phashTotal <= config.aggregateThresholds.phashTotalMax
    && nccMean >= config.aggregateThresholds.nccMeanMin
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) throw new Error(`visual_parity_failed:${reportPath}`);
process.stdout.write(`Release ${version} visual parity passed: PHASH total ${phashTotal.toFixed(4)}, NCC mean ${nccMean.toFixed(4)}\n`);
