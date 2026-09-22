# Meeting 0.3.4 shipping task

Outcome: READY_FOR_USER_REVIEW (shipping derivative of the accepted appearance).
Accepted visual/source baseline: 0.3.3 at
5580a7b080cf6195e28ebc77b654fd71111b0cd1. Current source repository baseline:
6bdcaf939adcdbcf61cf3404de5a3d981703875c.
Shared quality contract and task packet: platform
a3a905ea3bcbe290e77fa4c7fc2dd92214097a4d, including Q8.

The user selected this accepted eight-seat room for the main template catalog,
and agreed to perform Android Chrome, iOS Safari and Quest checks after automated
staging verification. The earlier four-seat product plan is superseded by that
explicit choice; historical four-seat template definitions remain immutable.

## Goal and boundary

Reduce the 20,320,032-byte GLB below the 15 MiB bundle budget without altering the
accepted layout, hierarchy, construction, material response, panorama, seats or
the debug-main/whiteboard-wall surfaces. Retain the original accepted source and
published release. Derive a new immutable shipping version from those bytes.

## Requirement / evidence matrix

| Requirement | Evidence obligation | State |
| --- | --- | --- |
| Q1 | Accepted source images and seventeen baseline/candidate browser views; decoded texture equivalence | passed locally; all seventeen PNG pairs are byte-identical |
| Q2 | Exact node, mesh, primitive, material and part identity across packaging | passed; semantic/geometry comparisons |
| Q3 | Vertices, normals, indices/winding, transforms and existing construction/support evidence | preserved; accepted source checks still pass |
| Q4 | Eight seats, shared display and collaboration wall in normal product mode | passed locally; authoritative observer and rendered synchronized notes |
| Q5 | Anchors/room geometry; movement, real seated viewpoints and display/board use | passed locally; all eight seat/floor transitions |
| Q6 | Cleared photographic 8K Cannon panorama and window/coastal views | passed; JPEG bytes unchanged and browser views inspected |
| Q7 | Preserve accepted 0.3.3 quality; no self-calibrated weaker visual target | required |
| Q8 | Purposeful table group, access routes and useful AV placement | retained from accepted source; group views inspected |

## Packaging investigation

The 2048-square baked-light PNG occupies approximately 10.81 MB. Test a standard
8-bit PNG representation against the texture actually decoded by the browser;
preserving browser texels is a different assertion from preserving unused 16-bit
source precision. Keep the original PNG in accepted source. Lossless Meshopt
encoding must retain Float32 attributes and triangle winding. Do not quantize,
simplify, resize the panorama or hide objects to meet the byte budget.

## Completion gates

Two exact packaging runs, Khronos validation, existing reality/source checks,
full baseline/candidate browser views, normal media/seating flows, immutable release
records and exact-SHA staging verification precede product integration. Physical
device results remain explicit user-performed acceptance, not inferred from mocks.

Local result: 11,576,640-byte GLB, zero Khronos errors/warnings, two identical
Blender-export-plus-packaging runs, 32 passing tests including negative evidence
and write-safety cases. Browser PNG decoding matches exactly in default and
no-color-conversion modes. All seventeen source-relative review views use the
original vertical FOV (the Blender source sets camera.angle_y); actual camera eye
position and direction are polled together before capture.

Capture retries corrected test instrumentation: the 20 MB original response was
evicted from the inspector cache, so the pair test hashes the actual fetch clone;
initial-spawn position alone could match stale camera telemetry, so direction is
also awaited. Observer readiness for the heavy scene uses an explicit timeout.
These retries do not change scene geometry, thresholds or assets. Exact-SHA public
staging and physical-device records follow publication.
