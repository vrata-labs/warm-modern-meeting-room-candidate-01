import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeTestApi } from "../../apps/runtime-web/src/testing/runtime-test-api.js";

test("@private-assets shipping packaging preserves fixed browser views", async ({ browser, request }) => {
  const root = process.env.MEETING_SHIPPING_ROOT;
  test.skip(!root, "Meeting shipping inputs are not configured");
  test.setTimeout(600000);
  const source = join(root!, "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3");
  const output = join(root!, "build/shipping-0.3.4");
  const original = JSON.parse(await readFile(join(source, "scene.json"), "utf8"));
  const config = JSON.parse(await readFile(join(root!, "source/releases/0.3.3/visual-parity-config.json"), "utf8"));
  const assets = new Map([
    ["baseline", await readFile(join(source, "scene.glb"))],
    ["candidate", await readFile(join(output, "scene.glb"))]
  ]);
  const manifest = { ...original };
  delete manifest.anchors;
  delete manifest.preview;
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const server = createServer((req, res) => {
    const [variant, filename] = (req.url ?? "").split("/").filter(Boolean);
    const asset = assets.get(variant);
    const bytes = asset && (filename === "scene.glb" ? asset : filename === "scene.json" ? manifestBytes : null);
    res.writeHead(bytes ? 200 : 404, { "access-control-allow-origin": "*", "content-type": filename === "scene.json" ? "application/json" : "model/gltf-binary" });
    res.end(bytes ?? "missing");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const admin = { "x-vrata-admin-token": process.env.STAGING_ADMIN_TOKEN ?? "test-admin-token" };
  const platformCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  try {
    for (const [variant, asset] of assets) {
      const directory = join(output, variant);
      await mkdir(directory, { recursive: true });
      const created = await request.post("/api/rooms", { headers: admin, data: {
        tenantId: "demo-tenant", templateId: "meeting-room-basic", name: `Shipping comparison ${variant}`,
        visibility: "public", guestAllowed: true, sceneBundleUrl: `${origin}/${variant}/scene.json`,
        avatarConfig: { avatarsEnabled: true, avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: false }
      } });
      expect(created.ok()).toBe(true);
      const room = await created.json();
      const context = await browser.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:4000", viewport: { width: 960, height: 540 } });
      try {
        const page = await context.newPage();
        await page.addInitScript(() => {
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (response.ok && new URL(response.url).pathname.endsWith("/scene.glb")) {
              void response.clone().arrayBuffer().then(bytes => crypto.subtle.digest("SHA-256", bytes)).then(digest => {
                (window as any).__SHIPPING_ASSET_SHA256__ = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
              });
            }
            return response;
          };
        });
        const received = page.waitForResponse(response => response.url() === `${origin}/${variant}/scene.glb` && response.ok());
        await page.goto(`/rooms/${room.roomId}?debug=1&scenefit=0`);
        if (await page.locator("#guest-onboarding").isVisible()) {
          await page.locator("#guest-name-input").fill("Shipping comparison");
          await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
        }
        await (await received).finished();
        await expect.poll(() => page.evaluate(() => (window as any).__SHIPPING_ASSET_SHA256__), { timeout: 30000 }).toBe(createHash("sha256").update(asset).digest("hex"));
        await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneDebug?.state), { timeout: 90000 }).toBe("loaded");
        await page.addStyleTag({ content: ".hud { display: none !important; }" });
        expect(await page.evaluate(settings => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.setSceneReviewRendering(settings), { environmentIntensity: .35, exposure: 1.2 })).toBe(true);
        const cameras = [];
        for (const view of config.reviewViews) {
          const position = { ...view.position, z: -view.position.z };
          const target = { ...view.target, z: -view.target.z };
          const dx = target.x-position.x, dy = target.y-position.y, dz = target.z-position.z;
          const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
          const length = Math.hypot(dx, dy, dz);
          // The accepted reality-pass assigns Blender camera.angle_y, so these
          // config values already describe the vertical field of view.
          const pose = { position: { x: position.x-1.6*Math.sin(yaw)*Math.sin(pitch), y: position.y-1.6*Math.cos(pitch), z: position.z-1.6*Math.cos(yaw)*Math.sin(pitch) }, yaw, pitch, fovDegrees: view.fovDegrees };
          expect(await page.evaluate(value => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.setSceneReviewPose(value), pose)).toBe(true);
          await expect.poll(() => page.evaluate(({ eye, direction }) => {
            const { world, forward } = (window as any).__VRATA_DEBUG__.sceneDebug.camera;
            return Math.hypot(world.x-eye.x, world.y-eye.y, world.z-eye.z) < .002
              && Math.hypot(forward.x-direction.x, forward.y-direction.y, forward.z-direction.z) < .002;
          }, { eye: position, direction: { x: dx/length, y: dy/length, z: dz/length } }), { timeout: 30000, message: view.id }).toBe(true);
          const camera = await page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneDebug.camera);
          expect(Math.hypot(camera.forward.x-dx/length, camera.forward.y-dy/length, camera.forward.z-dz/length)).toBeLessThan(.002);
          await page.screenshot({ path: join(directory, `${view.id}.png`), timeout: 60000 });
          cameras.push({ id: view.id, requestedEye: position, fovDegrees: view.fovDegrees, camera });
        }
        const debug = await page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneDebug);
        expect(debug.missingAssets).toEqual([]);
        expect(debug.failureReason).toBeNull();
        expect(debug.meshCount).toBe(133);
        expect(debug.materialCount).toBe(18);
        debug.bundleUrl = `${variant}/scene.json`;
        debug.assetUrl = `${variant}/scene.glb`;
        await writeFile(join(directory, "capture.json"), JSON.stringify({ platformCommit, variant, assetSha256: createHash("sha256").update(asset).digest("hex"), assetBytes: asset.length, syntheticReviewCameras: true, policy: { stripAnchors: true, avatarsEnabled: true, fallbackCapsules: false, seatAvatars: false, mediaSurfacesVisible: true }, cameras, debug }, null, 2)+"\n");
      } finally {
        await context.close();
        expect((await request.delete(`/api/rooms/${room.roomId}`, { headers: admin })).ok()).toBe(true);
      }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
