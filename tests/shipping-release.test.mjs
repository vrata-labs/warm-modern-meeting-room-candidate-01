import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileRecord, loadReleaseAcceptanceIndex } from "../scripts/release-acceptance.mjs";
import { validateShippingRelease } from "../scripts/validate-shipping-release.mjs";
import { safeOutput } from "../source/releases/0.3.4/package-glb.mjs";

const root = resolve(import.meta.dirname, "..");
test("shipping validation rejects altered pixels, incomplete interactions and changed artifacts", async t => {
  await mkdir(join(root, "build"), { recursive: true });
  const fixture = await mkdtemp(join(root, "build/shipping-validation-"));
  try {
    for (const directory of ["source/releases", "provenance/releases", "assets/scenes/warm-modern-meeting-room-candidate-01"]) {
      await mkdir(join(fixture, directory), { recursive: true });
      await symlink(join(root, directory, "0.3.3"), join(fixture, directory, "0.3.3"), "dir");
      await cp(join(root, directory, "0.3.4"), join(fixture, directory, "0.3.4"), { recursive: true });
    }
    const { acceptances } = await loadReleaseAcceptanceIndex(root);
    const baseline = acceptances.find(value => value.record.version === "0.3.4");
    const release = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).releases.find(value => value.version === "0.3.4");
    await validateShippingRelease(fixture, baseline, release);
    const receiptPath = "provenance/releases/0.3.4/visual-equivalence.json";
    const originals = new Map();
    async function change(path, mutate) {
      const bytes = await readFile(join(fixture, path));
      if (!originals.has(path)) originals.set(path, bytes);
      const value = JSON.parse(bytes); mutate(value);
      await writeFile(join(fixture, path), JSON.stringify(value, null, 2)+"\n");
    }
    async function rebind(path, acceptance) {
      const file = await fileRecord(join(fixture, path));
      if (path !== receiptPath) await change(receiptPath, receipt => Object.assign(receipt.files.find(input => input.path === path), file));
      Object.assign(acceptance.lock.shipping.inputs.find(input => input.path === receiptPath), await fileRecord(join(fixture, receiptPath)));
    }
    const cases = [
      ["changed pixels with recomputed hashes", receiptPath, value => { value.views[0].differentBytes = 1; }, /shipping_browser_pixels_changed/],
      ["incomplete normal capture with recomputed hashes", "provenance/releases/0.3.4/normal/functional.json", value => { value.completed = false; }, /shipping_normal_capture_incomplete/],
      ["failed authoritative seat release with recomputed hashes", "provenance/releases/0.3.4/normal/functional.json", value => { value.seats[0].authoritativeClaimAndRelease = false; }, /shipping_seat_flow_failed/],
      ["camera drift with recomputed hashes", "provenance/releases/0.3.4/candidate/capture.json", value => { value.cameras[0].camera.world.x += 1; }, /shipping_capture_camera_mismatch/]
    ];
    for (const [name, path, mutate, error] of cases) await t.test(name, async () => {
      try {
        const acceptance = structuredClone(baseline);
        await change(path, mutate);
        await rebind(path, acceptance);
        await assert.rejects(() => validateShippingRelease(fixture, acceptance, release), error);
      } finally {
        for (const [path, bytes] of originals) await writeFile(join(fixture, path), bytes);
        originals.clear();
      }
    });
    await t.test("corrupt shipping GLB", async () => {
      const path = join(fixture, release.releasePath, "scene.glb");
      const original = await readFile(path);
      try {
        const damaged = Buffer.from(original); damaged[damaged.length-1] ^= 1;
        await writeFile(path, damaged);
        await assert.rejects(() => validateShippingRelease(fixture, baseline, release), /shipping_file_record_drift/);
      } finally { await writeFile(path, original); }
    });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("shipping builder refuses published destinations and symlink escapes before writing", async () => {
  await assert.rejects(() => safeOutput(join(root, "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.glb")), /scratch_output_required/);
  const fixture = await mkdtemp(join(root, "build/shipping-path-"));
  try {
    await symlink(join(root, "source"), join(fixture, "source-link"), "dir");
    await assert.rejects(() => safeOutput(join(fixture, "source-link/new.bin")), /symlink_output_rejected/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
