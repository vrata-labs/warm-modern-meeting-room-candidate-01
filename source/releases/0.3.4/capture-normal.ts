import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeTestApi } from "../../apps/runtime-web/src/testing/runtime-test-api.js";

const debug = (page: Page) => page.evaluate(() => {
  const d = (window as any).__VRATA_DEBUG__;
  return { participantId: d?.participantId, connected: d?.roomStateConnected, seat: d?.currentSeatId, occupancy: d?.seatOccupancy, root: d?.localPose?.root, camera: d?.sceneDebug?.camera, state: d?.sceneDebug?.state, media: d?.mediaObjects, markdown: d?.markdownBoard };
});

test("@private-assets Meeting shipping retains eight authoritative seats and rendered collaboration surfaces", async ({ page, request }) => {
  const root = process.env.MEETING_SHIPPING_ROOT;
  test.skip(!root, "Meeting shipping inputs are not configured");
  test.setTimeout(360000);
  const output = join(root!, "build/shipping-0.3.4/normal");
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root!, "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.3/scene.json"), "utf8"));
  const asset = await readFile(join(root!, "build/shipping-0.3.4/scene.glb"));
  const assetSha256 = createHash("sha256").update(asset).digest("hex");
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const server = createServer((req, res) => {
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": req.url === "/scene.glb" ? "model/gltf-binary" : "application/json" });
    res.end(req.url === "/scene.glb" ? asset : manifestBytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const headers = { "x-vrata-admin-token": process.env.STAGING_ADMIN_TOKEN ?? "test-admin-token" };
  const created = await request.post("/api/rooms", { headers, data: {
    tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Meeting shipping functional check",
    visibility: "public", guestAllowed: true, sceneBundleUrl: `http://127.0.0.1:${port}/scene.json`,
    avatarConfig: { avatarsEnabled: true, avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: true }
  } });
  expect(created.ok()).toBe(true);
  const { roomId } = await created.json();
  const observer = await page.context().newPage();
  const evidence: any = { platformCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), assetSha256, syntheticReviewPoseUsed: false, seats: [], surfaces: [], completed: false };
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    const invite = await request.post(`/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } });
    expect(invite.ok()).toBe(true);
    const link = new URL((await invite.json()).inviteLink);
    link.searchParams.set("debug", "1"); link.searchParams.set("scenefit", "0");
    const received = page.waitForResponse(response => response.url() === `http://127.0.0.1:${port}/scene.glb` && response.ok(), { timeout: 60000 });
    await page.goto(`${link.pathname}${link.search}`);
    if (await page.locator("#guest-onboarding").isVisible()) {
      await page.locator("#guest-name-input").fill("Meeting shipping host");
      await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    }
    await expect.poll(async () => (await debug(page)).state, { timeout: 60000 }).toBe("loaded");
    expect(createHash("sha256").update(await (await received).body()).digest("hex")).toBe(assetSha256);
    await expect.poll(async () => (await debug(page)).connected, { timeout: 60000 }).toBe(true);
    const initial = await debug(page);
    for (const axis of ["x", "y", "z"]) expect(initial.root[axis]).toBeCloseTo(manifest.spawnPoints[0].position[axis], 2);
    evidence.spawn = { root: initial.root, camera: initial.camera };
    await page.locator(".hud > summary").focus();
    if (await page.locator(".hud").getAttribute("open") !== null) await page.keyboard.press("Enter");
    await page.screenshot({ path: join(output, "spawn.png"), timeout: 60000 });
    await observer.setViewportSize({ width: 320, height: 200 });
    await observer.addInitScript(() => sessionStorage.setItem("vrata.participantId", `observer-${crypto.randomUUID()}`));
    await observer.goto(`/rooms/${roomId}?debug=1&scenefit=0`);
    if (await observer.locator("#guest-onboarding").isVisible()) {
      await observer.locator("#guest-name-input").fill("Meeting observer");
      await observer.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    }
    await expect.poll(async () => (await debug(observer)).connected, { timeout: 60000 }).toBe(true);
    expect((await debug(observer)).participantId).not.toBe(initial.participantId);
    for (const seat of manifest.anchors.seatAnchors) {
      expect(await page.evaluate(id => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.requestSeatClaimById(id), seat.id)).toBe(true);
      await expect.poll(async () => ({ local: (await debug(page)).seat, remote: (await debug(observer)).occupancy[seat.id] }), { timeout: 20000 }).toEqual({ local: seat.id, remote: initial.participantId });
      await expect.poll(async () => (await debug(page)).camera.world.y, { timeout: 20000 }).toBeCloseTo(seat.seatHeight+.72, 2);
      for (const axis of ["x", "z"]) await expect.poll(async () => (await debug(page)).camera.world[axis], { timeout: 20000 }).toBeCloseTo(seat.position[axis], 2);
      const seated = await debug(page);
      await page.keyboard.down("w"); await page.waitForTimeout(200); await page.keyboard.up("w");
      expect((await debug(page)).root).toEqual(seated.root);
      await page.screenshot({ path: join(output, `${seat.id}.png`), timeout: 60000 });
      const spawn = manifest.spawnPoints[0].position;
      expect(await page.evaluate(value => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.teleportToFloor(value.x, value.z), spawn)).toBe(true);
      await expect.poll(async () => ({ local: (await debug(page)).occupancy[seat.id] ?? null, remote: (await debug(observer)).occupancy[seat.id] ?? null }), { timeout: 20000 }).toEqual({ local: null, remote: null });
      await expect.poll(async () => (await debug(page)).root, { timeout: 20000 }).toMatchObject(spawn);
      evidence.seats.push({ id: seat.id, authoritativeClaimAndRelease: true, movementLocked: true, seatedEye: seated.camera.world, returnedRoot: (await debug(page)).root });
    }
    expect((await debug(page)).media.physicalSurfaceIdsWithoutLogicalState).toEqual([]);
    for (const surface of manifest.mediaSurfaces) {
      const id = surface.surfaceId;
      expect(await page.evaluate(id => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.createMarkdownBoardObject(id), id)).toBe(true);
      await expect.poll(async () => (await debug(observer)).media.surfaces.find((s: any) => s.surfaceId === id)?.activeObjectType, { timeout: 20000 }).toBe("markdown-board");
      expect(await page.evaluate(id => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.createStickyNote({ text: `Meeting ${id}`, surfaceId: id, x: .25, y: .25 }), id)).toBe(true);
      expect(await observer.evaluate(id => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.selectMediaSurface(id), id)).toBe(true);
      await expect.poll(async () => (await debug(observer)).markdown.notes.map((note: any) => note.text), { timeout: 20000 }).toContain(`Meeting ${id}`);
      await expect.poll(() => observer.evaluate(id => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.getMediaCanvasRuntimeKinds(id), id), { timeout: 20000 }).toContain("markdown-board");
      const pixels = await observer.evaluate(id => (window as unknown as { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.sampleMediaSurfaceTexture(id, { u: .5, v: .5 }, { width: 1, height: 1 }), id);
      expect(pixels?.samples.length).toBeGreaterThan(0);
      evidence.surfaces.push({ surfaceId: id, actualObjectType: "markdown-board", observerTextReceived: true, textureBound: Boolean((await debug(observer)).media.surfaces.find((s: any) => s.surfaceId === id)?.textureId), sampledPixels: pixels });
    }
    await page.screenshot({ path: join(output, "collaboration.png"), timeout: 60000 });
    evidence.completed = true;
  } finally {
    await writeFile(join(output, "functional.json"), JSON.stringify(evidence, null, 2)+"\n");
    await observer.close();
    await page.goto("about:blank");
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect((await request.delete(`/api/rooms/${roomId}`, { headers })).ok()).toBe(true);
  }
});
