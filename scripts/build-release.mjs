import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  assert,
  hashFile,
  loadReleaseAcceptanceIndex,
  repositoryFilePath,
  selectReleaseAcceptance
} from "./release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");

function parseArguments(argv) {
  const options = { twice: false, version: null, lockPath: null, outputRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--twice") {
      assert(!options.twice, "duplicate_argument:--twice");
      options.twice = true;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    if (!["--version", "--lock", "--output-root"].includes(name)) throw new Error(`unknown_argument:${argument}`);
    const value = inlineValue ?? argv[++index];
    assert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `missing_argument_value:${name}`);
    const key = name === "--version" ? "version" : name === "--lock" ? "lockPath" : "outputRoot";
    assert(options[key] === null, `duplicate_argument:${name}`);
    options[key] = value;
  }
  return options;
}

function blenderPathFromEnvironment() {
  const configured = process.env.BLENDER_BIN?.trim();
  assert(configured, "blender_bin_required: set BLENDER_BIN to the pinned Blender binary");
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

function runBlender(blender, args, code) {
  const result = spawnSync(blender, args, { cwd: root, stdio: "inherit" });
  if (result.error?.code === "ENOENT") throw new Error("blender_not_found: set BLENDER_BIN to the pinned Blender binary");
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.signal ?? result.status;
    throw new Error(`${code}:${reason}`);
  }
}

async function verifyBlender(blender, toolchain) {
  assert(/^[0-9a-f]{64}$/.test(toolchain?.blenderBinarySha256 ?? ""), "invalid_pinned_blender_digest");
  const actualSha256 = await hashFile(blender);
  assert(actualSha256 === toolchain.blenderBinarySha256, `blender_binary_digest_mismatch:${actualSha256}`);
  const version = spawnSync(blender, ["--version"], { cwd: root, encoding: "utf8" });
  if (version.error?.code === "ENOENT") throw new Error("blender_not_found: set BLENDER_BIN to the pinned Blender binary");
  if (version.error || version.status !== 0) throw new Error(`blender_version_failed:${version.error?.message ?? version.status}`);
  assert(version.stdout.includes(`Blender ${toolchain.blenderVersion}`), `blender_version_mismatch:${version.stdout.split("\n")[0]}`);
  assert(version.stdout.includes(`build hash: ${toolchain.blenderBuildHash}`), "blender_build_hash_mismatch");
}

async function verifyAcceptedInputs(lock) {
  const acceptedSource = lock.acceptedSource;
  assert(acceptedSource && typeof acceptedSource === "object" && !Array.isArray(acceptedSource), "invalid_accepted_source_inputs");
  const pathEntries = Object.entries(acceptedSource).filter(([key]) => key.endsWith("Path"));
  assert(pathEntries.length > 0, "accepted_source_inputs_missing");
  const resolved = new Map();
  for (const [pathKey, repositoryPath] of pathEntries) {
    const digestKey = `${pathKey.slice(0, -4)}Sha256`;
    const expectedSha256 = acceptedSource[digestKey];
    assert(/^[0-9a-f]{64}$/.test(expectedSha256 ?? ""), `accepted_source_input_digest_missing:${pathKey}`);
    const absolutePath = repositoryFilePath(root, repositoryPath, `invalid_accepted_source_input_path:${pathKey}`);
    const actualSha256 = await hashFile(absolutePath);
    assert(actualSha256 === expectedSha256, `accepted_source_input_digest_mismatch:${pathKey}:${actualSha256}`);
    resolved.set(pathKey, absolutePath);
  }
  for (const required of ["blendPath", "lightmapPath", "exportScriptPath"]) {
    assert(resolved.has(required), `accepted_source_build_input_missing:${required}`);
  }
  return resolved;
}

function exportArguments(inputs, scale, output) {
  return [
    "--background",
    inputs.get("blendPath"),
    "--python",
    inputs.get("exportScriptPath"),
    "--",
    "--output",
    output,
    "--lightmap",
    inputs.get("lightmapPath"),
    "--scale",
    String(scale)
  ];
}

const options = parseArguments(process.argv.slice(2));
const { acceptances } = await loadReleaseAcceptanceIndex(root);
const acceptance = selectReleaseAcceptance(acceptances, options);
const { lock, record } = acceptance;
const blender = blenderPathFromEnvironment();
const scale = lock.toolchain?.bakedLightmap?.scale;
assert(Number.isFinite(scale) && scale > 0, `invalid_release_lightmap_scale:${record.version}`);
await verifyBlender(blender, lock.toolchain);
const inputs = await verifyAcceptedInputs(lock);

const outputRootInput = options.outputRoot ?? process.env.SCENE_BUILD_OUTPUT_ROOT ?? "build/releases";
const outputRoot = isAbsolute(outputRootInput) ? outputRootInput : resolve(root, outputRootInput);
const versionOutput = join(outputRoot, record.version);
const releaseOutput = join(versionOutput, "scene.glb");
await mkdir(versionOutput, { recursive: true });
await rm(releaseOutput, { force: true });

const exportAndVerify = async (output, runName) => {
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  runBlender(blender, exportArguments(inputs, scale, output), `blender_export_failed:${record.version}:${runName}`);
  const actualSha256 = await hashFile(output);
  assert(actualSha256 === lock.release.glbSha256, `release_glb_digest_mismatch:${record.version}:${runName}:${actualSha256}`);
  return actualSha256;
};

let releaseSha256;
if (options.twice) {
  const reproducibilityRoot = join(versionOutput, "reproducibility");
  await rm(reproducibilityRoot, { recursive: true, force: true });
  const firstOutput = join(reproducibilityRoot, "run-1", "scene.glb");
  const secondOutput = join(reproducibilityRoot, "run-2", "scene.glb");
  const firstSha256 = await exportAndVerify(firstOutput, "run-1");
  const secondSha256 = await exportAndVerify(secondOutput, "run-2");
  assert(secondSha256 === firstSha256, `two_run_glb_digest_mismatch:${record.version}:${firstSha256}:${secondSha256}`);
  await copyFile(firstOutput, releaseOutput);
  assert(await hashFile(releaseOutput) === firstSha256, `release_glb_copy_mismatch:${record.version}`);
  releaseSha256 = firstSha256;
} else {
  releaseSha256 = await exportAndVerify(releaseOutput, "run-1");
}

process.stdout.write(`Release ${record.version} GLB reproducible: ${releaseSha256}\n`);
