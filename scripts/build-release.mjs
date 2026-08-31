import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(join(root, "source", "accepted-source-lock.json"), "utf8"));
const blender = process.env.BLENDER_BIN ?? "blender";
const output = resolve(root, process.env.SCENE_BUILD_OUTPUT ?? "build/scene.glb");
const twice = process.argv.includes("--twice");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exportScene(path) {
  const result = spawnSync(blender, [
    "--background",
    join(root, lock.acceptedSource.blendPath),
    "--python",
    join(root, lock.acceptedSource.exportScriptPath),
    "--",
    "--output",
    path
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.signal ?? result.status;
    throw new Error(`blender_export_failed:${reason}`);
  }
}

await mkdir(dirname(output), { recursive: true });
exportScene(output);
const firstSha256 = sha256(await readFile(output));
if (firstSha256 !== lock.release.glbSha256) {
  throw new Error(`release_glb_digest_mismatch:${firstSha256}`);
}

if (twice) {
  const second = join(dirname(output), `${basename(output, ".glb")}.second.glb`);
  exportScene(second);
  const secondSha256 = sha256(await readFile(second));
  await rm(second);
  if (secondSha256 !== firstSha256) {
    throw new Error(`two_run_glb_digest_mismatch:${firstSha256}:${secondSha256}`);
  }
}

process.stdout.write(`Release GLB reproducible: ${firstSha256}\n`);
