# Warm Modern Meeting Room Candidate 01

Single-scene source and immutable release repository for the neutral
warm-modern meeting-room candidate `01`.

The shared experiment, brief, schemas, and cross-candidate reports live in
`vrata-labs/warm-modern-meeting-room-scene-factory`. The normative plan lives
in `vrata-labs/platform` at
`docs/plans/2026-08-12-warm-modern-meeting-room-ab-scene-factory.md`.

Candidate `01` is a production identifier. It does not encode the production
track or the later random `Alpha`/`Beta` review label.

## Boundary

This repository owns exactly one scene ID:

```text
warm-modern-meeting-room-candidate-01
```

It may contain that scene's accepted source, provenance, build scripts, and
immutable release bundles. It must not contain another scene, cross-track
research, reusable Scene Factory code, restricted references, or credentials.

## Layout

```text
source/concept-selection.json
source/scene-spec.json
source/component-constructions.json
source/media-surface-constructions.json
source/exterior-constructions.json
source/lighting-constructions.json
source/scene-contract-lock.json
source/release-acceptance-index.json
source/accepted-source-lock.json
source/accepted-scene.blend
source/accepted-lightmap.png
source/visual-completion.py
source/export-release.py
source/render-review.py
source/review/*.webp
source/releases/<version>/accepted-source-lock.json
source/releases/<version>/visual-parity-config.json
provenance/asset-ledger.json
provenance/generation-ledger.json
provenance/licenses/project-owned.txt
provenance/release-asset-ledger.json
provenance/rights-verdict-2026-08-29.md
provenance/licenses/project-owned-release.txt
provenance/releases/<version>/
assets/scenes/warm-modern-meeting-room-candidate-01/<version>/
manifest.json
platform-validator.lock
```

`source/release-acceptance-index.json` is append-only. It maps legacy release
`0.2.0` to the historical singleton `source/accepted-source-lock.json`; later
accepted releases use `source/releases/<version>/accepted-source-lock.json`, a
same-version visual parity config, and versioned provenance. Accepted source,
provenance, and published version directories become immutable after merge.
Runtime URLs must use a full 40-character commit SHA.

## Validation

```bash
pnpm install
pnpm validate
pnpm inspect
pnpm test
BLENDER_BIN=/path/to/pinned/blender pnpm verify:reproducibility
SCENE_VISUAL_OUTPUT_DIR=/path/to/runtime-captures pnpm capture:bind
SCENE_VISUAL_OUTPUT_DIR=/path/to/runtime-captures pnpm validate:visual
```

No scene binary may be committed before source rights are cleared. A release
must contain exactly `scene.json`, `scene.glb`, `preview.webp`, and
`LICENSES.md`, and must satisfy the eight-seat review contract.

Release `0.1.1` preserves the accepted Blender source, scene-specific authoring
and export scripts, four review views, complete project-owned release provenance,
and a deterministic GLB. The original specification ledger and
`scene-contract-lock.json` remain unchanged historical evidence of the earlier
pre-release boundary; release approval is recorded separately in
`source/accepted-source-lock.json` and `provenance/release-asset-ledger.json`.
The release contains no external or model-generated 3D assets and does not expose
a production-track or blind-review label.

Release `0.1.0` remains immutable and is superseded because its manifest copied
semantic authoring-space `z` coordinates directly into Three.js runtime space.
Release `0.1.1` applies the Blender Y-up export transform `x=x,y=y,z=-z` to spawn,
seat-anchor, and media-surface positions while preserving the accepted GLB,
preview, and license bytes.

The full-SHA release at commit `e9891721220bbcda8099d8bbad52e08b3b59427c`
passed staging runtime verification with `sceneDebug.state=loaded`, the corrected
main spawn and media-surface positions, zero missing assets, and zero console
errors. The exact evidence is recorded in
`provenance/runtime-coordinate-correction-0.1.1.json`.

Release `0.1.2` is an immutable metadata-only release. It preserves the exact
`scene.glb`, `preview.webp`, and `LICENSES.md` bytes from `0.1.1`, selects the
`neutral-pbr` render profile, and gives the runtime spawn a stable yaw toward
the conference-table composition center. For runtime spawn `(2.6, 0, 1.64)`
and table center `(-0.45, 0, -0.05)`, Three.js forward `-Z` gives
`yaw = atan2(-dx, -dz) = 1.0648120280696147` radians. Release `0.1.1` is
superseded; `0.1.2` was the active publication-ready release until `0.2.0`.

Release `0.2.0` supersedes `0.1.2` with a deterministic 2048px Cycles
irradiance atlas and the platform `baked-pbr-v1` render profile. The release
keeps the accepted PBR material parameters, uses `TEXCOORD_1` for baked light,
and retains RoomEnvironment reflections for dynamic and metallic surfaces.
The accepted atlas is stored as a reproducible build input; `export-release.py`
can either rebuild the GLB from that atlas or regenerate it with `--bake`.
Four fixed runtime views must pass `pnpm validate:visual` before publication.

Release `0.3.0` is an append-only review release and does not supersede current
release `0.2.0`. It adds explicit passive/deferred/interactive object semantics,
physical support-contact validation, seventeen role-based user scenarios, and
sixteen fixed source/runtime review views. Automated reality, deterministic GLB,
rights, and visual parity gates pass; human visual acceptance remains pending,
so `isCurrent` and `publicationReady` remain false.

Release `0.3.1` is an append-only correction review release and also leaves
`0.2.0` current. It removes the exterior planter and hedge, moves the interior
plant clear of the primary route, centers the collaboration whiteboard, and
closes the window glass-to-frame contacts. The accepted source binds 26 objects,
137 mesh parts, 18 role-based user scenarios, a deterministic 2048px baked atlas,
and sixteen fixed Blender/runtime review views. Human visual acceptance remains
pending, so `isCurrent` and `publicationReady` remain false.
