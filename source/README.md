# Source Boundary

Only accepted, cleared source artifacts for
`warm-modern-meeting-room-candidate-01` belong here. Keep original, cleaned,
and release-ready source distinct. Do not add restricted references or raw
rejected attempts.

`concept-selection.json` records the approved low-fidelity layout intent and
the SHA-256 of its private functional correction preview. `scene-spec.json`
records the exact validated room, component, seat, route, media-surface, and
review-view contract. `component-constructions.json` records the exact
candidate-owned beveled-box parts, material slots, and two approved chair
upholstery overrides. `media-surface-constructions.json` binds the two surface
IDs to exact purpose, pixel dimensions, front-face, and input semantics while
leaving physical dimensions, transforms, and yaw solely in `scene-spec.json`.
`exterior-constructions.json` records the project-authored north-window ground,
planted vegetation, middle-distance context, support graph, and scalar materials.
`lighting-constructions.json` records the exact three-light order, scene-to-Blender
emitter mappings, and deterministic entry-view acceptance policy without compiling
or rendering lighting. `scene-contract-lock.json` preserves that historical
pre-release specification boundary and its negative publication claims.

`accepted-scene.blend` is the visual- and rights-approved geometry and material
source. `accepted-lightmap.png` is the accepted 2048px baked irradiance atlas for
release `0.2.0`. `visual-completion.py` records the scene-specific authoring pass;
`export-release.py` regenerates the atlas when invoked with `--bake` and otherwise
deterministically exports the accepted Blend and atlas without embedded lights or
cameras. `render-review.py` recreates the four semantic review views.
`accepted-source-lock.json` pins their hashes, Blender toolchain, rights evidence,
review images, release GLB, visual parity result, and same-host two-run byte identity.
It remains the immutable legacy acceptance lock for release `0.2.0`.

`release-acceptance-index.json` is the append-only map from release versions to
their accepted-source locks and visual parity configs. New accepted releases do
not replace the legacy singleton files: they add source under
`releases/<version>/`, use `releases/<version>/accepted-source-lock.json`, and
store release-specific evidence under `../provenance/releases/<version>/`.

Release `0.3.0` stores its accepted Blender source, baked atlas, reality pass,
exact object and user-scenario contracts, sixteen review views, acceptance lock,
visual parity config, and the exact clean-capture patch for the pinned platform
fixture under `releases/0.3.0/`. Its automated reality,
reproducibility, rights, and visual parity gates are complete, while human visual
acceptance and publication readiness remain explicitly false.

Release `0.3.1` appends the corrected accepted Blender source, baked atlas,
reality pass, 26-object and 18-scenario contracts, sixteen review views,
acceptance lock, visual parity config, and pinned runtime capture patch under
`releases/0.3.1/`. It removes the exterior planter and hedge, moves the route-safe
plant, centers the whiteboard, and closes the window contacts without changing
the legacy singleton or `0.3.0` bytes. Human visual acceptance and publication
readiness remain explicitly false.
