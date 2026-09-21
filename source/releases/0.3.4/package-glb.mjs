import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";
import validator from "gltf-validator";

const root = resolve(import.meta.dirname, "../../..");
const sourcePath = "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.glb";
const sourceSha256 = "705999f50ce98c9a6760509ee731610f8e416e53d0f3b48b1d87481d267549d6";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const arrayBytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

function geometry(document) {
  return document.getRoot().listMeshes().map(mesh => ({
    name: mesh.getName(), extras: mesh.getExtras(),
    primitives: mesh.listPrimitives().map(primitive => {
      const indices = Array.from(primitive.getIndices().getArray());
      assert.equal(primitive.getMode(), 4);
      // Meshopt may cyclically rotate each triangle's indices. Winding and
      // ordered triangles must remain the same; reversed triangles do not match.
      for (let i = 0; i < indices.length; i += 3) {
        const triangle = indices.slice(i, i+3);
        const start = triangle.indexOf(Math.min(...triangle));
        indices.splice(i, 3, ...triangle.slice(start), ...triangle.slice(0, start));
      }
      return {
        indices,
        attributes: Object.fromEntries(primitive.listSemantics().sort().map(name => {
          const accessor = primitive.getAttribute(name);
          return [name, { type: accessor.getType(), componentType: accessor.getComponentType(), normalized: accessor.getNormalized(), bytes: sha256(arrayBytes(accessor.getArray())) }];
        }))
      };
    })
  }));
}

export async function packageGlb(input) {
  assert.equal(sha256(input), sourceSha256, "accepted_source_glb_mismatch");
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  const document = await io.readBinary(input);
  const beforeGeometry = geometry(document);
  const beforeJson = (await io.writeJSON(document)).json;
  const textures = [];
  for (const texture of document.getRoot().listTextures()) {
    const before = Buffer.from(texture.getImage());
    const metadata = await sharp(before).metadata();
    let after = before;
    if (texture.getName() === "accepted-lightmap") {
      after = await sharp(before).toColourspace("srgb").png({ compressionLevel: 9, adaptiveFiltering: true, palette: false, effort: 10 }).toBuffer();
      const originalTexels = await sharp(before).ensureAlpha().raw().toBuffer();
      const packedTexels = await sharp(after).ensureAlpha().raw().toBuffer();
      assert.deepEqual(packedTexels, originalTexels, "decoded_lightmap_texels_changed");
      texture.setImage(after);
    }
    textures.push({ name: texture.getName(), width: metadata.width, height: metadata.height, inputDepth: metadata.depth, beforeBytes: before.length, afterBytes: after.length, beforeSha256: sha256(before), afterSha256: sha256(after) });
  }
  document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const output = await io.writeBinary(document);
  const decoded = await io.readBinary(output);
  assert.deepEqual(geometry(decoded), beforeGeometry, "geometry_changed_during_packaging");
  decoded.getRoot().listExtensionsUsed().find(extension => extension.extensionName === "EXT_meshopt_compression").dispose();
  const afterJson = (await io.writeJSON(decoded)).json;
  for (const key of ["scenes", "scene", "nodes", "materials", "textures", "samplers", "skins", "animations"]) {
    assert.deepEqual(afterJson[key], beforeJson[key], `scene_semantics_changed:${key}`);
  }
  const validation = await validator.validateBytes(output, { maxIssues: 100000 });
  assert.equal(validation.issues.numErrors, 0);
  assert.equal(validation.issues.numWarnings, 0);
  const report = { inputSha256: sourceSha256, inputBytes: input.length, outputSha256: sha256(output), outputBytes: output.length, geometryUnchanged: true, textureBrowserEquivalence: "pending-browser-check", sharpDecodedTexelsUnchanged: true, textures, gltfErrors: 0, gltfWarnings: 0 };
  return { output, report };
}

export async function safeOutput(path) {
  const rel = relative(root, path);
  assert(rel.startsWith("build/"), "scratch_output_required");
  for (let current = path; current !== root; current = dirname(current)) {
    const entry = await lstat(current).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    assert(!entry?.isSymbolicLink(), "symlink_output_rejected");
  }
  for (const args of [["ls-files", "--", rel], ["ls-tree", "--name-only", "HEAD", "--", rel]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "", "tracked_output_rejected");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(root, process.argv[2] ?? "build/shipping-0.3.4");
  await safeOutput(directory);
  const { output, report } = await packageGlb(await readFile(resolve(root, sourcePath)));
  await safeOutput(resolve(directory, "scene.glb"));
  await safeOutput(resolve(directory, "packaging.json"));
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "scene.glb"), output);
  await writeFile(resolve(directory, "packaging.json"), JSON.stringify(report, null, 2)+"\n");
  console.log(JSON.stringify(report, null, 2));
}
