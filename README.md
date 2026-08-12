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
source/
provenance/asset-ledger.json
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
pnpm test
```

No scene binary may be committed before source rights are cleared. A release
must contain exactly `scene.json`, `scene.glb`, `preview.webp`, and
`LICENSES.md`, and must satisfy the eight-seat review contract.
