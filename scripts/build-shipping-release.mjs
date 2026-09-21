import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { packageGlb, safeOutput } from "../source/releases/0.3.4/package-glb.mjs";

export async function buildShippingRelease(options) {
  assert(!options.lockPath, "shipping_build_uses_version_selector");
  const root = resolve(import.meta.dirname, "..");
  const output = resolve(root, options.outputRoot ?? "build/releases", "0.3.4");
  await safeOutput(output);
  await safeOutput(join(output, "scene.glb"));
  const rawRoot = "build/shipping-source-reproduction";
  const run = spawnSync(process.execPath, ["scripts/build-release.mjs", "--version", "0.3.3", "--output-root", rawRoot, ...(options.twice ? ["--twice"] : [])], { cwd: root, stdio: "inherit", env: process.env });
  assert.equal(run.status, 0, "shipping_base_export_failed");
  const lock = JSON.parse(await readFile(join(root, "source/releases/0.3.4/accepted-source-lock.json"), "utf8"));
  const rawPaths = options.twice
    ? ["reproducibility/run-1/scene.glb", "reproducibility/run-2/scene.glb"]
    : ["scene.glb"];
  let result;
  for (const path of rawPaths) {
    result = await packageGlb(await readFile(join(root, rawRoot, "0.3.3", path)));
    assert.equal(result.report.outputSha256, lock.release.glbSha256, "shipping_export_digest_mismatch");
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "scene.glb"), result.output);
  console.log(`Release 0.3.4 reproducible from accepted Blender source: ${result.report.outputSha256}`);
}
