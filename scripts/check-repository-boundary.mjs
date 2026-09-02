import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  LEGACY_ACCEPTANCE_VERSION,
  RELEASE_ACCEPTANCE_INDEX_PATH,
  assert,
  loadReleaseAcceptanceIndex,
  normalizeRepositoryPath
} from "./release-acceptance.mjs";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "scene-repository.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const { index: acceptanceIndex, acceptances } = await loadReleaseAcceptanceIndex(root);
const forbiddenTopLevel = new Set(["compiler", "experiment", "lab", "schemas"]);
const binaryExtensions = new Set([".avif", ".blend", ".fbx", ".gif", ".glb", ".gltf", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const privatePreviewSha256 = new Set([
  "f52b3722e71dd231ebe80424f0411e9771670fa37aff01eebbce42ff7d4c0a21",
  "cd7456afb5c9c10ebf3d4a16fdb5173af2c68a9faf9ce2798ec8238e257309c7"
]);
const execFileAsync = promisify(execFile);

function posix(path) {
  return path.split(sep).join("/");
}

function isWithin(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

function isRasterPreview(bytes) {
  return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    || (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    || (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii")));
}

function collectPinnedPathRecords(value, records = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPinnedPathRecords(item, records);
    return records;
  }
  if (!value || typeof value !== "object") return records;
  if (typeof value.path === "string" && /^[0-9a-f]{64}$/.test(value.sha256 ?? "")) {
    records.push({ path: value.path, sha256: value.sha256 });
  }
  if (typeof value.repositoryPath === "string" && /^[0-9a-f]{64}$/.test(value.originalSha256 ?? "")) {
    records.push({ path: value.repositoryPath, sha256: value.originalSha256 });
  }
  for (const nested of Object.values(value)) collectPinnedPathRecords(nested, records);
  return records;
}

async function allowPinnedBinaryPaths(value, allowedPaths, context) {
  for (const record of collectPinnedPathRecords(value)) {
    const path = normalizeRepositoryPath(record.path, `invalid_pinned_path:${context}`);
    const bytes = await readFile(resolve(root, path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert(digest === record.sha256, `pinned_path_digest_drift:${context}:${path}`);
    allowedPaths.add(path);
  }
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".platform" || entry.name === ".scene-factory" || entry.name === "node_modules" || entry.name === "build") continue;
    const path = resolve(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...await walk(path));
  }
  return paths;
}

async function gitText(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

async function gitJsonAt(commit, path) {
  try {
    return JSON.parse(await gitText(["show", `${commit}:${path}`]));
  } catch (error) {
    if (error.code === 128 || /does not exist|exists on disk, but not in/.test(error.stderr ?? "")) return null;
    throw error;
  }
}

async function verifyAppendOnly(baseSha) {
  assert(/^[0-9a-f]{40}$/.test(baseSha), "invalid_immutable_baseline_sha");
  await gitText(["cat-file", "-e", `${baseSha}^{commit}`]);
  const baseFiles = (await gitText(["ls-tree", "-r", "--name-only", baseSha, "--", "source", "provenance", "assets/scenes"]))
    .split("\n")
    .filter(Boolean);
  const baseFileSet = new Set(baseFiles);
  const baseManifest = await gitJsonAt(baseSha, "manifest.json");
  const baseIndex = await gitJsonAt(baseSha, RELEASE_ACCEPTANCE_INDEX_PATH);
  const changedPaths = (await gitText(["diff", "--no-renames", "--name-only", baseSha, "HEAD", "--", "source", "provenance", "assets/scenes"]))
    .split("\n")
    .filter(Boolean);

  const releaseRoots = (baseManifest?.releases ?? []).map(({ releasePath }) => releasePath);
  const versionedSourceRoots = [...new Set(baseFiles.flatMap((path) => {
    const match = path.match(/^(source\/releases\/\d+\.\d+\.\d+)\//);
    return match ? [match[1]] : [];
  }))];
  const versionedProvenanceRoots = [...new Set(baseFiles.flatMap((path) => {
    const match = path.match(/^(provenance\/releases\/\d+\.\d+\.\d+)\//);
    return match ? [match[1]] : [];
  }))];

  for (const path of changedPaths) {
    if (releaseRoots.some((directory) => isWithin(path, directory))) throw new Error(`published_scene_version_is_immutable:${path}`);
    if (versionedSourceRoots.some((directory) => isWithin(path, directory))
      || versionedProvenanceRoots.some((directory) => isWithin(path, directory))) {
      throw new Error(`accepted_release_evidence_is_immutable:${path}`);
    }
    if (baseFileSet.has(path) && path.startsWith("source/")
      && path !== "source/README.md" && path !== RELEASE_ACCEPTANCE_INDEX_PATH) {
      throw new Error(`legacy_accepted_source_is_immutable:${path}`);
    }
    if (baseFileSet.has(path) && path.startsWith("provenance/")) throw new Error(`accepted_provenance_is_immutable:${path}`);
    if (!baseFileSet.has(path) && path.startsWith("source/")
      && path !== RELEASE_ACCEPTANCE_INDEX_PATH
      && !/^source\/releases\/\d+\.\d+\.\d+\//.test(path)) {
      throw new Error(`new_accepted_source_must_be_versioned:${path}`);
    }
    if (!baseFileSet.has(path) && path.startsWith("provenance/")
      && !/^provenance\/releases\/\d+\.\d+\.\d+\//.test(path)) {
      throw new Error(`new_accepted_provenance_must_be_versioned:${path}`);
    }
  }

  if (baseIndex) {
    assert(baseIndex.schemaVersion === acceptanceIndex.schemaVersion
      && baseIndex.sceneId === acceptanceIndex.sceneId, "release_acceptance_index_identity_changed");
    assert(baseIndex.releases.length <= acceptanceIndex.releases.length, "release_acceptance_record_removed");
    for (const [recordIndex, record] of baseIndex.releases.entries()) {
      assert(JSON.stringify(record) === JSON.stringify(acceptanceIndex.releases[recordIndex]), `release_acceptance_record_changed:${record.version}`);
    }
  }
}

const allowedBinaryPaths = new Set(manifest.releases.flatMap(({ releasePath }) => [
  `${releasePath}/scene.glb`,
  `${releasePath}/preview.webp`
]));
for (const { record, lock, visualParityConfig } of acceptances) {
  for (const [key, path] of Object.entries(lock.acceptedSource ?? {}).filter(([key]) => key.endsWith("Path"))) {
    allowedBinaryPaths.add(normalizeRepositoryPath(path, `invalid_accepted_source_path:${record.version}:${key}`));
  }
  for (const view of lock.reviewViews ?? []) allowedBinaryPaths.add(normalizeRepositoryPath(view.path, `invalid_accepted_review_path:${record.version}:${view.id}`));
  for (const view of visualParityConfig.views ?? []) allowedBinaryPaths.add(normalizeRepositoryPath(view.referencePath, `invalid_visual_reference_path:${record.version}:${view.id}`));
  for (const repositoryPath of [
    lock.rights?.releaseLedgerPath,
    lock.runtimeCoordinates?.evidencePath,
    lock.visualQuality?.evidencePath
  ].filter((path) => typeof path === "string" && path.endsWith(".json"))) {
    const evidence = JSON.parse(await readFile(resolve(root, normalizeRepositoryPath(repositoryPath)), "utf8"));
    await allowPinnedBinaryPaths(evidence, allowedBinaryPaths, `${record.version}:${repositoryPath}`);
  }

  if (record.version !== LEGACY_ACCEPTANCE_VERSION) {
    const sourcePrefix = `source/releases/${record.version}/`;
    const provenancePrefix = `provenance/releases/${record.version}/`;
    for (const [key, path] of Object.entries(lock.acceptedSource ?? {}).filter(([key]) => key.endsWith("Path"))) {
      assert(path.startsWith(sourcePrefix), `versioned_accepted_source_path_required:${record.version}:${key}`);
    }
    for (const view of lock.reviewViews ?? []) assert(view.path.startsWith(sourcePrefix), `versioned_review_path_required:${record.version}:${view.id}`);
    for (const [key, path] of [
      ["rightsEvidence", lock.rights?.evidencePath],
      ["releaseLedger", lock.rights?.releaseLedgerPath],
      ["runtimeCoordinates", lock.runtimeCoordinates?.evidencePath],
      ["visualQuality", lock.visualQuality?.evidencePath]
    ]) {
      if (path !== undefined) assert(path.startsWith(provenancePrefix), `versioned_provenance_path_required:${record.version}:${key}`);
    }
  }
}

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isDirectory() && forbiddenTopLevel.has(entry.name)) throw new Error(`forbidden_scene_repository_path:${entry.name}`);
}

const sceneRoots = (await readdir(resolve(root, "assets/scenes"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (JSON.stringify(sceneRoots) !== JSON.stringify([config.sceneId])) throw new Error(`single_scene_boundary_violated:${sceneRoots.join(",")}`);

const siblingId = config.sceneId.endsWith("01")
  ? config.sceneId.replace(/01$/, "02")
  : config.sceneId.replace(/02$/, "01");
for (const path of await walk(root)) {
  const repositoryPath = posix(relative(root, path));
  if (repositoryPath.includes(siblingId)) throw new Error(`sibling_scene_reference_forbidden:${repositoryPath}`);
  if (/(^|\/)(alpha|beta)(\/|\.|$)/i.test(repositoryPath)) throw new Error(`blind_review_label_forbidden:${repositoryPath}`);
  const bytes = await readFile(path).catch((error) => {
    if (error.code === "EISDIR") return null;
    throw error;
  });
  if (bytes && (binaryExtensions.has(extname(repositoryPath).toLowerCase()) || isRasterPreview(bytes)) && !allowedBinaryPaths.has(repositoryPath)) {
    throw new Error(`unapproved_binary_forbidden:${repositoryPath}`);
  }
  if (bytes) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (privatePreviewSha256.has(digest)) throw new Error(`private_concept_preview_forbidden:${repositoryPath}`);
  }
}

const { stdout: trackedOutput } = await execFileAsync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "buffer" });
for (const repositoryPath of trackedOutput.toString("utf8").split("\0").filter(Boolean)) {
  const { stdout: indexedBytes } = await execFileAsync("git", ["show", `:${repositoryPath}`], { cwd: root, encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
  const digest = createHash("sha256").update(indexedBytes).digest("hex");
  if (privatePreviewSha256.has(digest)) throw new Error(`private_concept_preview_forbidden:${repositoryPath}`);
}

let baseSha = process.env.BASE_SHA?.trim() || null;
let baseArgumentSeen = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--base") {
    assert(!baseArgumentSeen, "duplicate_argument:--base");
    const value = process.argv[++index];
    assert(value, "missing_argument_value:--base");
    assert(baseSha === null || baseSha === value, "base_sha_argument_mismatch");
    baseSha = value;
    baseArgumentSeen = true;
  } else if (argument.startsWith("--base=")) {
    assert(!baseArgumentSeen, "duplicate_argument:--base");
    const value = argument.slice("--base=".length);
    assert(value, "missing_argument_value:--base");
    assert(baseSha === null || baseSha === value, "base_sha_argument_mismatch");
    baseSha = value;
    baseArgumentSeen = true;
  } else {
    throw new Error(`unknown_argument:${argument}`);
  }
}
if (baseSha && !/^0+$/.test(baseSha)) await verifyAppendOnly(baseSha);

process.stdout.write("Single-scene append-only repository boundary is valid.\n");
