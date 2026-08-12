import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "scene-repository.json"), "utf8"));
const sceneRoot = join(root, "assets", "scenes", config.sceneId);
const versions = (await readdir(sceneRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

if (versions.length === 0) {
  process.stdout.write("No GLB releases to inspect.\n");
  process.exit(0);
}

for (const version of versions) {
  const asset = join(sceneRoot, version, "scene.glb");
  const result = spawnSync("gltf-transform", ["inspect", asset], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`gltf_transform_inspect_failed:${version}`);
}
