import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { assert, fileRecord, repositoryFilePath } from "./release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");

function parseArguments(argv) {
  const options = { version: null, outputDir: process.env.SCENE_VISUAL_OUTPUT_DIR ?? null };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = argv[index].split("=", 2);
    assert(["--version", "--output-dir"].includes(name), `unknown_argument:${argv[index]}`);
    const value = inlineValue ?? argv[++index];
    assert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `missing_argument_value:${name}`);
    const key = name === "--version" ? "version" : "outputDir";
    options[key] = value;
  }
  assert(/^\d+\.\d+\.\d+$/.test(options.version ?? ""), "capture_binding_version_required");
  assert(typeof options.outputDir === "string" && options.outputDir.length > 0, "capture_binding_output_dir_required");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const version = options.version;
const outputDir = isAbsolute(options.outputDir) ? options.outputDir : resolve(root, options.outputDir);
const configPath = repositoryFilePath(root, `source/releases/${version}/visual-parity-config.json`);
const config = JSON.parse(await readFile(configPath, "utf8"));
assert(config.schemaVersion === 1 && config.releaseVersion === version, `invalid_capture_binding_config:${version}`);

const captureFileNames = [
  ...config.views.map(({ captureFile }) => captureFile),
  config.capture.runtimeDiagnosticsFile,
  config.capture.renderSettingsFile
];
assert(captureFileNames.every((name) => typeof name === "string" && basename(name) === name), `invalid_capture_file_name:${version}`);
assert(new Set(captureFileNames).size === captureFileNames.length, `duplicate_capture_file_name:${version}`);

const captureFiles = {};
for (const name of captureFileNames) {
  captureFiles[name] = { path: name, ...await fileRecord(resolve(outputDir, name)) };
}

const releaseGlbRecord = await fileRecord(repositoryFilePath(root, config.releaseGlb.path));
assert(releaseGlbRecord.sha256 === config.releaseGlb.sha256
  && releaseGlbRecord.sizeBytes === config.releaseGlb.sizeBytes, `capture_binding_release_glb_drift:${version}`);
if (config.capture.platformPatch !== undefined) {
  const patchRecord = await fileRecord(repositoryFilePath(root, config.capture.platformPatch.path));
  assert(patchRecord.sha256 === config.capture.platformPatch.sha256, `capture_binding_platform_patch_drift:${version}`);
}

const binding = {
  schemaVersion: 1,
  sceneId: config.sceneId,
  releaseVersion: version,
  platformCommit: config.capture.platformCommit,
  platformPatch: config.capture.platformPatch,
  captureRunner: config.capture.runner,
  capturePolicy: config.capture.cleanVisualMode,
  releaseGlb: config.releaseGlb,
  captureFiles
};
await mkdir(outputDir, { recursive: true });
const bindingPath = resolve(outputDir, config.capture.bindingFile);
await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
process.stdout.write(`Capture binding ${version}: ${bindingPath}\n`);
