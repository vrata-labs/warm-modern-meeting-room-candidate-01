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
provenance/asset-ledger.json
provenance/generation-ledger.json
provenance/licenses/project-owned.txt
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
```

No scene binary may be committed before source rights are cleared. A release
must contain exactly `scene.json`, `scene.glb`, `preview.webp`, and
`LICENSES.md`, and must satisfy the eight-seat review contract.

The current repository state is an exact source-only component, media-surface,
exterior, and lighting specification. It contains four construction families
resolving to 38 component parts, two media surfaces bound to platform-owned
runtime planes, four project-authored exterior volumes with three scalar
materials, and three resolved lighting constructions. Physical surface
dimensions, positions, and yaw remain solely in `source/scene-spec.json`. The
exterior source binds the north window to nearby ground, one planted hedge, and
one restrained middle-distance context mass. The lighting source specifies the
daylight, architectural fill, pendant emitter mappings, and deterministic entry
view acceptance policy; it does not compile lighting, render that view, or claim
acceptance. The contract is validated by the exact Scene Factory commit recorded
in `source/scene-contract-lock.json`. No compiler, release bundle, preview binary,
or production-track mapping exists, and project-authored inputs remain disallowed
for production.
