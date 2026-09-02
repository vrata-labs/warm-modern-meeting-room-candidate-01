import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export const RELEASE_ACCEPTANCE_INDEX_PATH = "source/release-acceptance-index.json";
export const LEGACY_ACCEPTANCE_VERSION = "0.2.0";

export function assert(condition, code) {
  if (!condition) throw new Error(code);
}

export function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function normalizeRepositoryPath(path, code = "invalid_repository_path") {
  assert(typeof path === "string" && path.length > 0 && !isAbsolute(path), code);
  assert(!path.includes("\\") && posix.normalize(path) === path && !path.startsWith("../"), code);
  return path;
}

export function repositoryFilePath(root, path, code = "invalid_repository_path") {
  const repositoryPath = normalizeRepositoryPath(path, code);
  const absolutePath = resolve(root, repositoryPath);
  const relativePath = relative(root, absolutePath);
  assert(relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`), code);
  return absolutePath;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolveHash)
      .on("error", reject);
  });
  return hash.digest("hex");
}

export async function fileRecord(path) {
  const bytes = await readFile(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

function assertExactKeys(value, expected, code) {
  assert(value && typeof value === "object" && !Array.isArray(value), code);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), code);
}

export async function loadReleaseAcceptanceIndex(root) {
  const indexPath = repositoryFilePath(root, RELEASE_ACCEPTANCE_INDEX_PATH);
  const index = await readJson(indexPath);
  assertExactKeys(index, ["schemaVersion", "sceneId", "releases"], "invalid_release_acceptance_index_keys");
  assert(index.schemaVersion === 1 && typeof index.sceneId === "string" && Array.isArray(index.releases), "invalid_release_acceptance_index");
  assert(index.releases.length > 0, "empty_release_acceptance_index");

  const acceptances = [];
  const seenVersions = new Set();
  for (const [recordIndex, record] of index.releases.entries()) {
    assertExactKeys(record, [
      "version",
      "lockPath",
      "lockSha256",
      "visualParityConfigPath",
      "visualParityConfigSha256"
    ], `invalid_release_acceptance_record_keys:${recordIndex}`);
    assert(/^\d+\.\d+\.\d+$/.test(record.version), `invalid_release_acceptance_version:${record.version}`);
    assert(!seenVersions.has(record.version), `duplicate_release_acceptance:${record.version}`);
    seenVersions.add(record.version);
    if (recordIndex > 0) {
      assert(compareVersions(index.releases[recordIndex - 1].version, record.version) < 0, "release_acceptance_index_not_sorted");
    }

    const expectedLockPath = record.version === LEGACY_ACCEPTANCE_VERSION
      ? "source/accepted-source-lock.json"
      : `source/releases/${record.version}/accepted-source-lock.json`;
    assert(record.lockPath === expectedLockPath, `invalid_release_acceptance_lock_path:${record.version}`);
    assert(record.visualParityConfigPath === `source/releases/${record.version}/visual-parity-config.json`, `invalid_visual_parity_config_path:${record.version}`);
    assert(/^[0-9a-f]{64}$/.test(record.lockSha256), `invalid_release_acceptance_lock_digest:${record.version}`);
    assert(/^[0-9a-f]{64}$/.test(record.visualParityConfigSha256), `invalid_visual_parity_config_digest:${record.version}`);

    const lockPath = repositoryFilePath(root, record.lockPath);
    const visualParityConfigPath = repositoryFilePath(root, record.visualParityConfigPath);
    assert(await hashFile(lockPath) === record.lockSha256, `release_acceptance_lock_digest_drift:${record.version}`);
    assert(await hashFile(visualParityConfigPath) === record.visualParityConfigSha256, `visual_parity_config_digest_drift:${record.version}`);
    const lock = await readJson(lockPath);
    const visualParityConfig = await readJson(visualParityConfigPath);
    assert(lock.sceneId === index.sceneId && lock.release?.version === record.version, `release_acceptance_lock_identity_drift:${record.version}`);
    assert(visualParityConfig.sceneId === index.sceneId && visualParityConfig.releaseVersion === record.version, `visual_parity_config_identity_drift:${record.version}`);
    acceptances.push({ record, lock, visualParityConfig });
  }

  const legacy = acceptances.find(({ record }) => record.version === LEGACY_ACCEPTANCE_VERSION);
  assert(legacy?.record.lockPath === "source/accepted-source-lock.json", "legacy_release_acceptance_missing");
  return { index, acceptances };
}

export function selectReleaseAcceptance(acceptances, { version, lockPath }) {
  assert(version || lockPath, "release_selector_required: use --version or --lock");
  const normalizedLockPath = lockPath ? normalizeRepositoryPath(lockPath, "invalid_release_lock_argument") : null;
  const byVersion = version ? acceptances.find(({ record }) => record.version === version) : null;
  const byLock = normalizedLockPath ? acceptances.find(({ record }) => record.lockPath === normalizedLockPath) : null;
  if (version) assert(byVersion, `release_acceptance_not_found:${version}`);
  if (normalizedLockPath) assert(byLock, `release_acceptance_lock_not_found:${normalizedLockPath}`);
  assert(!byVersion || !byLock || byVersion === byLock, "release_selector_mismatch");
  return byVersion ?? byLock;
}
