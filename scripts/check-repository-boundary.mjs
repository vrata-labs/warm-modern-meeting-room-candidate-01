import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(resolve(root, "scene-repository.json"), "utf8"));
const forbiddenTopLevel = new Set(["compiler", "experiment", "lab", "schemas"]);
const binaryExtensions = new Set([".avif", ".blend", ".fbx", ".gif", ".glb", ".gltf", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const allowedBinaryPaths = new Set([
  "source/accepted-scene.blend",
  "source/review/entry.webp",
  "source/review/participant.webp",
  "source/review/presenter.webp",
  "source/review/diagonal-overview.webp",
  `assets/scenes/${config.sceneId}/0.1.0/scene.glb`,
  `assets/scenes/${config.sceneId}/0.1.0/preview.webp`,
  `assets/scenes/${config.sceneId}/0.1.1/scene.glb`,
  `assets/scenes/${config.sceneId}/0.1.1/preview.webp`
]);
const privatePreviewSha256 = new Set([
  "f52b3722e71dd231ebe80424f0411e9771670fa37aff01eebbce42ff7d4c0a21",
  "cd7456afb5c9c10ebf3d4a16fdb5173af2c68a9faf9ce2798ec8238e257309c7"
]);
const execFileAsync = promisify(execFile);

function posix(path) {
  return path.split(sep).join("/");
}

function isRasterPreview(bytes) {
  return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    || (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    || (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii")));
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

process.stdout.write("Single-scene repository boundary is valid.\n");
