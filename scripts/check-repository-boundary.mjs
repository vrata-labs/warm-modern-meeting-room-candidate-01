import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "scene-repository.json"), "utf8"));
const forbiddenTopLevel = new Set(["compiler", "experiment", "lab", "schemas"]);
const privatePreviewSha256 = "f52b3722e71dd231ebe80424f0411e9771670fa37aff01eebbce42ff7d4c0a21";
const execFileAsync = promisify(execFile);

function posix(path) {
  return path.split(sep).join("/");
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".platform" || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...await walk(path));
  }
  return paths;
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
}

const { stdout: trackedOutput } = await execFileAsync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "buffer" });
for (const repositoryPath of trackedOutput.toString("utf8").split("\0").filter(Boolean)) {
  const { stdout: indexedBytes } = await execFileAsync("git", ["show", `:${repositoryPath}`], { cwd: root, encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
  const digest = createHash("sha256").update(indexedBytes).digest("hex");
  if (digest === privatePreviewSha256) throw new Error(`private_concept_preview_forbidden:${repositoryPath}`);
}

process.stdout.write("Single-scene repository boundary is valid.\n");
