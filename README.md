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
source/accepted-source-lock.json
source/accepted-scene.blend
source/visual-completion.py
source/export-release.py
source/render-review.py
source/review/*.webp
provenance/asset-ledger.json
provenance/generation-ledger.json
provenance/licenses/project-owned.txt
provenance/release-asset-ledger.json
provenance/rights-verdict-2026-08-29.md
provenance/licenses/project-owned-release.txt
assets/scenes/warm-modern-meeting-room-candidate-01/<version>/
manifest.json
platform-validator.lock
```

Published version directories are immutable. Runtime URLs must use a full
40-character commit SHA.

## Validation

```bash
pnpm install
pnpm validate
pnpm inspect
pnpm test
BLENDER_BIN=/path/to/pinned/blender pnpm verify:reproducibility
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
