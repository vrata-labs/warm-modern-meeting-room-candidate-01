import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDir = resolve(root, process.env.SCENE_VISUAL_OUTPUT_DIR ?? "build/review-runtime");
const reportPath = resolve(root, process.env.SCENE_VISUAL_REPORT_PATH ?? "build/visual-parity.json");
const thresholds = {
  entry: { phashMax: 32, nccMin: 0.47 },
  participant: { phashMax: 58, nccMin: 0.64 },
  presenter: { phashMax: 23, nccMin: 0.64 },
  "diagonal-overview": { phashMax: 28, nccMin: 0.4 }
};

function compare(metric, reference, actual) {
  const result = spawnSync("compare", ["-metric", metric, reference, actual, "null:"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`image_compare_failed:${metric}:${result.stderr.trim()}`);
  }
  const value = Number.parseFloat(result.stderr.trim().split(/\s+/)[0] ?? "");
  if (!Number.isFinite(value)) throw new Error(`invalid_image_metric:${metric}:${result.stderr.trim()}`);
  return value;
}

const results = [];
for (const [view, threshold] of Object.entries(thresholds)) {
  const reference = join(root, "source", "review", `${view}.webp`);
  const actual = join(outputDir, `${view}.png`);
  await Promise.all([readFile(reference), readFile(actual)]);
  const phash = compare("PHASH", reference, actual);
  const ncc = compare("NCC", reference, actual);
  results.push({ view, phash, ncc, threshold, passed: phash <= threshold.phashMax && ncc >= threshold.nccMin });
}

const phashTotal = results.reduce((total, result) => total + result.phash, 0);
const nccMean = results.reduce((total, result) => total + result.ncc, 0) / results.length;
const report = {
  schemaVersion: 1,
  metricTool: "ImageMagick compare",
  outputDirectory: outputDir,
  aggregateThresholds: { phashTotalMax: 130, nccMeanMin: 0.55 },
  aggregate: { phashTotal, nccMean },
  views: results,
  passed: results.every(({ passed }) => passed) && phashTotal <= 130 && nccMean >= 0.55
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) throw new Error(`visual_parity_failed:${reportPath}`);
process.stdout.write(`Visual parity passed: PHASH total ${phashTotal.toFixed(4)}, NCC mean ${nccMean.toFixed(4)}\n`);
