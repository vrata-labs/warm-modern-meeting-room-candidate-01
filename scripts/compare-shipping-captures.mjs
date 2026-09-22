import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "build/shipping-0.3.4");
const config = JSON.parse(await readFile(resolve(root, "source/releases/0.3.3/visual-parity-config.json"), "utf8"));
const captures = await Promise.all(["baseline", "candidate"].map(async name => JSON.parse(await readFile(resolve(output, name, "capture.json"), "utf8"))));
assert.equal(captures[0].platformCommit, captures[1].platformCommit);
assert.deepEqual(captures[0].cameras, captures[1].cameras);
assert.deepEqual(captures[0].policy, captures[1].policy);
const views = [];
for (const view of config.reviewViews) {
  const bytes = await Promise.all(["baseline", "candidate"].map(name => readFile(resolve(output, name, `${view.id}.png`))));
  const images = await Promise.all(bytes.map(image => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  assert.deepEqual(images[0].info, images[1].info);
  let differentBytes = 0, maxDifference = 0, squaredError = 0;
  for (let index = 0; index < images[0].data.length; index++) {
    const delta = Math.abs(images[0].data[index]-images[1].data[index]);
    if (delta) differentBytes++;
    maxDifference = Math.max(maxDifference, delta);
    squaredError += delta*delta;
  }
  views.push({ id: view.id, differentBytes, maxDifference, normalizedRmse: Math.sqrt(squaredError/images[0].data.length)/255, pngSha256: bytes.map(image => createHash("sha256").update(image).digest("hex")) });
}
const report = { platformCommit: captures[0].platformCommit, baselineGlbSha256: captures[0].assetSha256, candidateGlbSha256: captures[1].assetSha256, views };
await writeFile(resolve(output, "browser-comparison.json"), JSON.stringify(report, null, 2)+"\n");
console.log(JSON.stringify(report, null, 2));
