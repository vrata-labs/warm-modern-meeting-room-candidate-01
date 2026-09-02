import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const SCENE_ID = "warm-modern-meeting-room-candidate-01";
const RELEASE_VERSION = "0.3.0";
const REALITY_PATH = `source/releases/${RELEASE_VERSION}/scene-reality.json`;
const SCENARIOS_PATH = `source/releases/${RELEASE_VERSION}/user-scenarios.json`;
const DEFAULT_RELEASE_ROOT = `assets/scenes/${SCENE_ID}/${RELEASE_VERSION}`;
const DEFAULT_REPORT_PATH = `build/reports/scene-reality-${RELEASE_VERSION}.json`;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;
const FORBIDDEN_NEUTRAL_TEXT = /(alpha|beta|curated|ai[- ]?generated)/i;
const EPSILON = 1e-6;

const chairParts = ["seat", "back", "mechanism", "gas-column", "five-star-base", "back-supports", "arm-assembly"];
const expectedObjects = [
  ["area-rug", "passive", ["rug"]],
  ["av-credenza", "deferred", ["carcass", "floor-plinth", "door-01", "door-02", "door-03", "door-04", "pulls"]],
  ["baseboards", "passive", ["east-baseboard-segment-01", "north-baseboard-segment-01", "south-baseboard-segment-01", "south-baseboard-segment-02", "west-baseboard-segment-01"]],
  ...Array.from({ length: 8 }, (_, index) => [`chair-${String(index + 1).padStart(2, "0")}`, "interactive", chairParts]),
  ["conference-speakerphone", "deferred", ["body", "grille", "grille-perforations", "mute-button", "status-ring"]],
  ["conference-table", "passive", ["top", "pedestal-west-base", "pedestal-west-column", "pedestal-east-base", "pedestal-east-column"]],
  ["conference-table-cable-management", "deferred", ["cable-cover", "cable-cover-support"]],
  ["debug-main", "interactive", ["frame", "surface"]],
  ["exterior-landscape", "passive", ["planter", "hedge"]],
  ["exterior-neighbor-building", "passive", ["concrete-mass", "window-glass", "window-frame"]],
  ["exterior-site", "passive", ["near-ground"]],
  ["main-door", "deferred", ["panel", "handle-rosette", "handle-spindle", "handle-lever", "frame-head", "frame-left", "frame-right"]],
  ["main-window", "passive", ["glass", "glazing-bead-bottom", "glazing-bead-top", "glazing-bead-left", "glazing-bead-right", "frame-bottom", "frame-head", "frame-left", "frame-right", "reveal-head", "reveal-left", "reveal-right", "sill"]],
  ["media-wall-acoustics", "passive", ["panel-01", "panel-01-mount-lower", "panel-01-mount-upper", "panel-02", "panel-02-mount-lower", "panel-02-mount-upper", "panel-03", "panel-03-mount-lower", "panel-03-mount-upper"]],
  ["pendant-fixture", "passive", ["canopy-west", "diffuser-west", "cable-west-left", "cable-west-right", "housing-west", "canopy-east", "diffuser-east", "cable-east-left", "cable-east-right", "housing-east"]],
  ["room-shell", "passive", ["floor", "ceiling", "walls"]],
  ["route-safe-plant", "passive", ["pot", "stems", "foliage"]],
  ["whiteboard-accessories", "passive", ["tray"]],
  ["whiteboard-marker", "deferred", ["body", "cap"]],
  ["whiteboard-wall", "interactive", ["frame", "surface"]]
].map(([id, status, parts]) => ({ id, status, parts: [...parts] }));

const expectedObjectById = new Map(expectedObjects.map((value) => [value.id, value]));
const expectedPartKeys = expectedObjects.flatMap(({ id, parts }) => parts.map((partId) => `${id}/${partId}`));
const expectedPartsByStatus = Object.fromEntries(["passive", "deferred", "interactive"].map((status) => [
  status,
  expectedObjects.filter((value) => value.status === status).reduce((total, value) => total + value.parts.length, 0)
]));

const expectedSeatBindings = Array.from({ length: 8 }, (_, index) => {
  const number = index + 1;
  const id = `seat-${String(number).padStart(2, "0")}`;
  const objectId = `chair-${String(number).padStart(2, "0")}`;
  const northSide = number <= 4;
  const x = [-1.95, -0.95, 0.05, 1.05][index % 4];
  return {
    id,
    objectId,
    partId: "seat",
    position: { x, y: 0, z: northSide ? -1.15 : 1.1 },
    yaw: northSide ? 3.141593 : 0,
    seatHeight: 0.47,
    radius: 0.4,
    label: `Seat ${String(number).padStart(2, "0")}`
  };
});

const expectedMediaBindings = [
  {
    surfaceId: "debug-main",
    objectId: "debug-main",
    partId: "surface",
    label: "Shared display",
    kind: "wall",
    widthM: 3.2,
    heightM: 1.8,
    widthPx: 1920,
    heightPx: 1080,
    transform: { x: -3.4, y: 1.55, z: -0.15, yaw: Math.PI / 2 },
    visible: true
  },
  {
    surfaceId: "whiteboard-wall",
    objectId: "whiteboard-wall",
    partId: "surface",
    label: "Collaboration wall",
    kind: "wall",
    widthM: 2.4,
    heightM: 1.25,
    widthPx: 1920,
    heightPx: 1000,
    transform: { x: 3.4, y: 1.5, z: -0.5, yaw: -Math.PI / 2 },
    visible: true
  }
];

const expectedScenarioIds = [
  "entry-route",
  ...Array.from({ length: 8 }, (_, index) => `seat-${String(index + 1).padStart(2, "0")}-approach-sit-stand`),
  "shared-display-visible-from-all-seats",
  "whiteboard-standing-reach",
  "door-counterfactual-operation",
  "table-knee-and-arm-clearance",
  "route-safe-plant-clearance",
  "speakerphone-deferred-use",
  "cable-management-deferred-use",
  "whiteboard-marker-deferred-use"
];

const expectedClearanceIds = [
  "table-knee-height",
  ...Array.from({ length: 8 }, (_, index) => `chair-${String(index + 1).padStart(2, "0")}-arm-gap`),
  "plant-route-east-bound",
  "plant-west-bound",
  "plant-height-bound"
];

const expectedExtrasMetrics = [
  ["table-top-height", "conference-table", "top", "vrataTopHeightM", 0.74],
  ["table-top-thickness", "conference-table", "top", "vrataThicknessM", 0.055],
  ["speakerphone-device-type", "conference-speakerphone", "body", "vrataDeviceType", "conference-speakerphone"],
  ["plant-route-center", "route-safe-plant", "pot", "vrataRouteCenterX", 2.8],
  ["plant-route-half-width", "route-safe-plant", "pot", "vrataRouteHalfWidthM", 0.45],
  ...Array.from({ length: 8 }, (_, index) => {
    const chairId = `chair-${String(index + 1).padStart(2, "0")}`;
    return [
      [`${chairId}-seat-top`, chairId, "seat", "vrataSeatTopM", 0.47],
      [`${chairId}-star-count`, chairId, "five-star-base", "vrataStarCount", 5],
      [`${chairId}-caster-count`, chairId, "five-star-base", "vrataCasterCount", 5],
      [`${chairId}-arm-top`, chairId, "arm-assembly", "vrataArmTopM", 0.655]
    ];
  }).flat()
].map(([id, objectId, partId, key, value]) => ({ id, objectId, partId, key, value }));

export function expectedMeshNodeName(objectId, partId) {
  if (objectId === "area-rug") return "reality.area-rug";
  if (objectId === "av-credenza") return `reality.av-credenza.${partId}`;
  if (objectId === "baseboards") return `profile.${partId.replace("-segment-", ".segment-")}`;
  if (objectId.startsWith("chair-")) return `component.${objectId}.${partId}`;
  if (objectId === "conference-speakerphone") return `component.conference-speakerphone.${partId}`;
  if (objectId === "conference-table") return `component.conference-table.${partId}`;
  if (objectId === "conference-table-cable-management") return `component.conference-table.${partId}`;
  if (objectId === "debug-main") return `media.debug-main.${partId === "surface" ? "backing" : partId}`;
  if (objectId === "exterior-landscape") return `exterior.${partId}`;
  if (objectId === "exterior-neighbor-building") {
    return partId === "concrete-mass" ? "exterior.context-mass" : `exterior.context-window.${partId === "window-glass" ? "glass" : "frame"}`;
  }
  if (objectId === "exterior-site") return "exterior.near-ground";
  if (objectId === "main-door") {
    if (partId === "panel") return "opening.main-door.panel";
    if (partId.startsWith("handle-")) return `opening.main-door.hardware.${partId.slice("handle-".length)}`;
    return `opening.main-door.${partId.replace("-", ".")}`;
  }
  if (objectId === "main-window") {
    if (partId === "glass" || partId === "sill" || partId.startsWith("glazing-bead-")) return `opening.main-window.${partId}`;
    return `opening.main-window.${partId.replace("-", ".")}`;
  }
  if (objectId === "media-wall-acoustics") return `reality.media-wall.acoustic-${partId}`;
  if (objectId === "pendant-fixture") {
    if (partId === "housing-west") return "component.pendant-fixture.bar-negative-x";
    if (partId === "housing-east") return "component.pendant-fixture.bar-positive-x";
    return `component.pendant-fixture.${partId}`;
  }
  if (objectId === "room-shell") return `shell.${partId}`;
  if (objectId === "route-safe-plant") return `reality.route-safe-plant.${partId}`;
  if (objectId === "whiteboard-accessories") return "reality.whiteboard.tray";
  if (objectId === "whiteboard-marker") return `reality.whiteboard.marker-${partId}`;
  if (objectId === "whiteboard-wall") return `media.whiteboard-wall.${partId === "surface" ? "backing" : partId}`;
  throw new Error(`unknown_expected_mesh_part:${objectId}/${partId}`);
}

const expectedNodeNameByPart = new Map(expectedPartKeys.map((key) => {
  const separator = key.indexOf("/");
  return [key, expectedMeshNodeName(key.slice(0, separator), key.slice(separator + 1))];
}));

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, code) {
  assert(isRecord(value), code);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  assert(JSON.stringify(actualKeys) === JSON.stringify(expectedKeys), `${code}:${actualKeys.join(",")}`);
}

function assertIdentifier(value, code) {
  assert(typeof value === "string" && IDENTIFIER.test(value), code);
}

function assertEnglishText(value, code) {
  assert(typeof value === "string" && value.trim() === value && value.length > 0, code);
  assert(/^[\x20-\x7e]+$/.test(value), `${code}:non_ascii`);
  assert(!FORBIDDEN_NEUTRAL_TEXT.test(value), `${code}:non_neutral`);
}

function assertFiniteNumber(value, code) {
  assert(typeof value === "number" && Number.isFinite(value), code);
}

function assertScalar(value, code) {
  assert(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)), code);
}

function assertVector3(value, code) {
  assertExactKeys(value, ["x", "y", "z"], code);
  for (const axis of ["x", "y", "z"]) assertFiniteNumber(value[axis], `${code}:${axis}`);
}

function assertUnique(values, code) {
  assert(new Set(values).size === values.length, code);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertCanonicalEqual(actual, expected, code) {
  assert(canonical(actual) === canonical(expected), code);
}

function partKey(objectId, partId) {
  return `${objectId}/${partId}`;
}

function assertPartReference(reference, partByKey, code, allowWholeObject = false) {
  assertExactKeys(reference, ["objectId", "partId"], code);
  assertIdentifier(reference.objectId, `${code}:object_id`);
  if (allowWholeObject && reference.partId === null) {
    assert(expectedObjectById.has(reference.objectId), `${code}:unknown_object`);
    return;
  }
  assertIdentifier(reference.partId, `${code}:part_id`);
  assert(partByKey.has(partKey(reference.objectId, reference.partId)), `${code}:unknown_part`);
}

function validateSupportDag(reality, partByKey) {
  const rootKeys = reality.supportRoots.map(({ objectId, partId }) => partKey(objectId, partId));
  assertUnique(rootKeys, "duplicate_support_root");
  assertCanonicalEqual(reality.supportRoots, [
    { objectId: "room-shell", partId: "floor" },
    { objectId: "exterior-site", partId: "near-ground" }
  ], "support_roots_drift");
  const rootSet = new Set(rootKeys);
  let supportEdges = 0;

  for (const [key, part] of partByKey) {
    const edgeKeys = [];
    for (const [edgeIndex, edge] of part.supports.entries()) {
      assertExactKeys(edge, ["relation", "objectId", "partId"], `invalid_support_keys:${key}:${edgeIndex}`);
      assert(["supported-by", "attached-to"].includes(edge.relation), `invalid_support_relation:${key}:${edgeIndex}`);
      assertIdentifier(edge.objectId, `invalid_support_object:${key}:${edgeIndex}`);
      assertIdentifier(edge.partId, `invalid_support_part:${key}:${edgeIndex}`);
      const targetKey = partKey(edge.objectId, edge.partId);
      assert(partByKey.has(targetKey), `unknown_support_target:${key}:${targetKey}`);
      assert(targetKey !== key, `self_support_edge:${key}`);
      edgeKeys.push(`${edge.relation}:${targetKey}`);
      supportEdges += 1;
    }
    assertUnique(edgeKeys, `duplicate_support_edge:${key}`);
    if (rootSet.has(key)) assert(part.supports.length === 0, `support_root_has_parent:${key}`);
    else assert(part.supports.length > 0, `unsupported_non_root_part:${key}`);
  }

  const state = new Map();
  const reachesRoot = new Map();
  const visit = (key) => {
    if (state.get(key) === "visiting") throw new Error(`support_cycle:${key}`);
    if (state.get(key) === "visited") return reachesRoot.get(key);
    state.set(key, "visiting");
    const part = partByKey.get(key);
    let terminates = rootSet.has(key);
    for (const edge of part.supports) {
      const targetTerminates = visit(partKey(edge.objectId, edge.partId));
      assert(targetTerminates, `support_chain_without_root:${key}`);
      terminates = terminates || targetTerminates;
    }
    state.set(key, "visited");
    reachesRoot.set(key, terminates);
    return terminates;
  };
  for (const key of partByKey.keys()) assert(visit(key), `support_chain_without_root:${key}`);
  return supportEdges;
}

export function validateSceneRealityContract(reality) {
  assertExactKeys(reality, ["schemaVersion", "sceneId", "releaseVersion", "coordinateSystem", "expectedCounts", "supportRoots", "runtimeBindings", "objects"], "invalid_scene_reality_keys");
  assert(reality.schemaVersion === 1, "invalid_scene_reality_schema_version");
  assert(reality.sceneId === SCENE_ID, "scene_reality_scene_id_mismatch");
  assert(reality.releaseVersion === RELEASE_VERSION, "scene_reality_release_version_mismatch");
  assertCanonicalEqual(reality.coordinateSystem, {
    geometry: "glTF right-handed Y-up meters",
    runtime: "Vrata right-handed Y-up meters",
    authoringToRuntime: "x=x,y=z,z=-y"
  }, "scene_reality_coordinate_system_drift");

  assertExactKeys(reality.expectedCounts, ["objects", "parts", "partsByStatus"], "invalid_expected_counts_keys");
  assertExactKeys(reality.expectedCounts.partsByStatus, ["passive", "deferred", "interactive"], "invalid_status_counts_keys");
  assert(reality.expectedCounts.objects === 27 && reality.expectedCounts.parts === 139, "invalid_expected_model_counts");
  assertCanonicalEqual(reality.expectedCounts.partsByStatus, expectedPartsByStatus, "invalid_expected_status_counts");
  assert(Array.isArray(reality.objects), "invalid_scene_reality_objects");
  assertCanonicalEqual(reality.objects.map(({ id }) => id), expectedObjects.map(({ id }) => id), "scene_reality_object_order_or_set_drift");

  const objectById = new Map();
  const partByKey = new Map();
  const actualPartsByStatus = { passive: 0, deferred: 0, interactive: 0 };
  const implementationBindings = [];
  for (const [objectIndex, object] of reality.objects.entries()) {
    const expected = expectedObjects[objectIndex];
    assertExactKeys(object, ["id", "label", "class", "purpose", "status", "expectedAffordances", "implementedInteractions", "parts"], `invalid_object_keys:${expected.id}`);
    assert(object.id === expected.id, `object_id_drift:${expected.id}`);
    assertEnglishText(object.label, `invalid_object_label:${object.id}`);
    assertIdentifier(object.class, `invalid_object_class:${object.id}`);
    assertEnglishText(object.purpose, `invalid_object_purpose:${object.id}`);
    assert(object.status === expected.status, `object_status_drift:${object.id}`);
    assert(Array.isArray(object.expectedAffordances) && object.expectedAffordances.length > 0, `invalid_expected_affordances:${object.id}`);
    for (const affordance of object.expectedAffordances) assertIdentifier(affordance, `invalid_expected_affordance:${object.id}`);
    assertUnique(object.expectedAffordances, `duplicate_expected_affordance:${object.id}`);
    assert(Array.isArray(object.implementedInteractions), `invalid_implemented_interactions:${object.id}`);
    if (object.status === "interactive") assert(object.implementedInteractions.length === 1, `interactive_binding_required:${object.id}`);
    else assert(object.implementedInteractions.length === 0, `non_interactive_implementation_forbidden:${object.id}`);
    for (const [interactionIndex, interaction] of object.implementedInteractions.entries()) {
      assertExactKeys(interaction, ["type", "bindingId"], `invalid_interaction_keys:${object.id}:${interactionIndex}`);
      assert(["seat-anchor", "media-surface"].includes(interaction.type), `invalid_interaction_type:${object.id}`);
      assertIdentifier(interaction.bindingId, `invalid_interaction_binding:${object.id}`);
      implementationBindings.push(`${interaction.type}:${interaction.bindingId}`);
    }
    assert(Array.isArray(object.parts), `invalid_parts:${object.id}`);
    assertCanonicalEqual(object.parts.map(({ id }) => id), expected.parts, `object_parts_drift:${object.id}`);
    objectById.set(object.id, object);
    actualPartsByStatus[object.status] += object.parts.length;

    for (const [partIndex, part] of object.parts.entries()) {
      const expectedPartId = expected.parts[partIndex];
      assertExactKeys(part, ["id", "label", "purpose", "supports"], `invalid_part_keys:${object.id}:${expectedPartId}`);
      assert(part.id === expectedPartId, `part_id_drift:${object.id}:${expectedPartId}`);
      assertEnglishText(part.label, `invalid_part_label:${object.id}:${part.id}`);
      assertEnglishText(part.purpose, `invalid_part_purpose:${object.id}:${part.id}`);
      assert(Array.isArray(part.supports), `invalid_part_supports:${object.id}:${part.id}`);
      const key = partKey(object.id, part.id);
      assert(!partByKey.has(key), `duplicate_part:${key}`);
      partByKey.set(key, part);
    }
  }
  assert(partByKey.size === 139, `scene_reality_part_count_mismatch:${partByKey.size}`);
  assertCanonicalEqual(actualPartsByStatus, expectedPartsByStatus, "scene_reality_status_count_mismatch");

  assertExactKeys(reality.runtimeBindings, ["seatAnchors", "mediaSurfaces"], "invalid_runtime_bindings_keys");
  assert(Array.isArray(reality.runtimeBindings.seatAnchors), "invalid_seat_bindings");
  assert(Array.isArray(reality.runtimeBindings.mediaSurfaces), "invalid_media_bindings");
  for (const [index, binding] of reality.runtimeBindings.seatAnchors.entries()) {
    assertExactKeys(binding, ["id", "objectId", "partId", "position", "yaw", "seatHeight", "radius", "label"], `invalid_seat_binding_keys:${index}`);
    assertVector3(binding.position, `invalid_seat_binding_position:${binding.id}`);
    for (const key of ["yaw", "seatHeight", "radius"]) assertFiniteNumber(binding[key], `invalid_seat_binding_number:${binding.id}:${key}`);
    assertEnglishText(binding.label, `invalid_seat_binding_label:${binding.id}`);
  }
  for (const [index, binding] of reality.runtimeBindings.mediaSurfaces.entries()) {
    assertExactKeys(binding, ["surfaceId", "objectId", "partId", "label", "kind", "widthM", "heightM", "widthPx", "heightPx", "transform", "visible"], `invalid_media_binding_keys:${index}`);
    assertExactKeys(binding.transform, ["x", "y", "z", "yaw"], `invalid_media_transform_keys:${binding.surfaceId}`);
    for (const key of ["x", "y", "z", "yaw"]) assertFiniteNumber(binding.transform[key], `invalid_media_transform_number:${binding.surfaceId}:${key}`);
    for (const key of ["widthM", "heightM", "widthPx", "heightPx"]) assertFiniteNumber(binding[key], `invalid_media_binding_number:${binding.surfaceId}:${key}`);
    assertEnglishText(binding.label, `invalid_media_binding_label:${binding.surfaceId}`);
    assert(binding.kind === "wall" && binding.visible === true, `invalid_media_binding_semantics:${binding.surfaceId}`);
  }
  assertCanonicalEqual(reality.runtimeBindings.seatAnchors, expectedSeatBindings, "seat_runtime_bindings_drift");
  assertCanonicalEqual(reality.runtimeBindings.mediaSurfaces, expectedMediaBindings, "media_runtime_bindings_drift");

  const expectedImplementationBindings = [
    ...expectedSeatBindings.map(({ id }) => `seat-anchor:${id}`),
    ...expectedMediaBindings.map(({ surfaceId }) => `media-surface:${surfaceId}`)
  ];
  assertCanonicalEqual(implementationBindings, expectedImplementationBindings, "implemented_runtime_bindings_drift");
  const supportEdges = validateSupportDag(reality, partByKey);
  return { objectById, partByKey, supportEdges, partsByStatus: actualPartsByStatus };
}

function validateActorProfiles(profiles) {
  assert(Array.isArray(profiles) && profiles.length === 1, "invalid_actor_profiles");
  const profile = profiles[0];
  assertExactKeys(profile, ["id", "label", "standingEyeHeightM", "seatedEyeHeightM", "shoulderWidthM", "minimumKneeClearanceHeightM", "standingReachHeightRangeM"], "invalid_actor_profile_keys");
  assertCanonicalEqual(profile, {
    id: "meeting-participant",
    label: "Meeting participant",
    standingEyeHeightM: 1.65,
    seatedEyeHeightM: 1.2,
    shoulderWidthM: 0.5,
    minimumKneeClearanceHeightM: 0.68,
    standingReachHeightRangeM: { minimum: 0.84, maximum: 2.1 }
  }, "actor_profile_drift");
}

function validateRoutes(routes) {
  assert(Array.isArray(routes) && routes.length === 2, "invalid_routes");
  for (const route of routes) {
    assertExactKeys(route, ["id", "label", "minimumWidthM", "points"], `invalid_route_keys:${route.id}`);
    assertIdentifier(route.id, "invalid_route_id");
    assertEnglishText(route.label, `invalid_route_label:${route.id}`);
    assertFiniteNumber(route.minimumWidthM, `invalid_route_width:${route.id}`);
    assert(route.minimumWidthM >= 0.9, `route_width_below_minimum:${route.id}`);
    assert(Array.isArray(route.points) && route.points.length >= 2, `invalid_route_points:${route.id}`);
    for (const point of route.points) assertVector3(point, `invalid_route_point:${route.id}`);
  }
  assertCanonicalEqual(routes.map(({ id }) => id), ["entry-route", "presenter-route"], "route_set_drift");
  assertCanonicalEqual(routes[0].points, [
    { x: 2.25, y: 0, z: 2.35 },
    { x: 2.25, y: 0, z: 1.94 },
    { x: 2.6, y: 0, z: 1.64 }
  ], "entry_route_points_drift");
  assertCanonicalEqual(routes[1].points, [
    { x: 2.25, y: 0, z: 2.35 },
    { x: 2.25, y: 0, z: 1.94 },
    { x: 2.8, y: 0, z: 1.94 },
    { x: 2.8, y: 0, z: -1.94 },
    { x: 0, y: 0, z: -1.94 }
  ], "presenter_route_points_drift");
}

function validateScenarios(scenarios, realityContext) {
  assert(Array.isArray(scenarios), "invalid_scenarios");
  assertCanonicalEqual(scenarios.map(({ id }) => id), expectedScenarioIds, "scenario_set_or_order_drift");
  const bindingIds = new Set([
    ...expectedSeatBindings.map(({ id }) => id),
    ...expectedMediaBindings.map(({ surfaceId }) => surfaceId)
  ]);
  for (const scenario of scenarios) {
    assertExactKeys(scenario, ["id", "label", "purpose", "actorProfileId", "objectIds", "runtimeBindingIds", "implementationRequired", "steps", "acceptanceCriteria"], `invalid_scenario_keys:${scenario.id}`);
    assertIdentifier(scenario.id, "invalid_scenario_id");
    assertEnglishText(scenario.label, `invalid_scenario_label:${scenario.id}`);
    assertEnglishText(scenario.purpose, `invalid_scenario_purpose:${scenario.id}`);
    assert(scenario.actorProfileId === "meeting-participant", `invalid_scenario_actor:${scenario.id}`);
    assert(Array.isArray(scenario.objectIds) && scenario.objectIds.length > 0, `invalid_scenario_objects:${scenario.id}`);
    assertUnique(scenario.objectIds, `duplicate_scenario_object:${scenario.id}`);
    for (const objectId of scenario.objectIds) assert(realityContext.objectById.has(objectId), `unknown_scenario_object:${scenario.id}:${objectId}`);
    assert(Array.isArray(scenario.runtimeBindingIds), `invalid_scenario_bindings:${scenario.id}`);
    assertUnique(scenario.runtimeBindingIds, `duplicate_scenario_binding:${scenario.id}`);
    for (const bindingId of scenario.runtimeBindingIds) assert(bindingIds.has(bindingId), `unknown_scenario_binding:${scenario.id}:${bindingId}`);
    assert(typeof scenario.implementationRequired === "boolean", `invalid_scenario_implementation_requirement:${scenario.id}`);
    assert(Array.isArray(scenario.steps) && scenario.steps.length > 0, `invalid_scenario_steps:${scenario.id}`);
    for (const [stepIndex, step] of scenario.steps.entries()) {
      assertExactKeys(step, ["action", "target", "expectedResult"], `invalid_scenario_step_keys:${scenario.id}:${stepIndex}`);
      assertIdentifier(step.action, `invalid_scenario_action:${scenario.id}:${stepIndex}`);
      assertIdentifier(step.target, `invalid_scenario_target:${scenario.id}:${stepIndex}`);
      assertEnglishText(step.expectedResult, `invalid_scenario_result:${scenario.id}:${stepIndex}`);
    }
    assert(Array.isArray(scenario.acceptanceCriteria) && scenario.acceptanceCriteria.length > 0, `invalid_scenario_acceptance:${scenario.id}`);
    const criterionIds = [];
    for (const [criterionIndex, criterion] of scenario.acceptanceCriteria.entries()) {
      assertExactKeys(criterion, ["id", "measure", "operator", "value", "unit"], `invalid_scenario_criterion_keys:${scenario.id}:${criterionIndex}`);
      for (const key of ["id", "measure", "unit"]) assertIdentifier(criterion[key], `invalid_scenario_criterion_identifier:${scenario.id}:${criterionIndex}:${key}`);
      assert(["equals", "greater-than-or-equal", "less-than-or-equal"].includes(criterion.operator), `invalid_scenario_criterion_operator:${scenario.id}:${criterionIndex}`);
      assertScalar(criterion.value, `invalid_scenario_criterion_value:${scenario.id}:${criterionIndex}`);
      criterionIds.push(criterion.id);
    }
    assertUnique(criterionIds, `duplicate_scenario_criterion:${scenario.id}`);
  }

  for (const seatBinding of expectedSeatBindings) {
    const scenario = scenarios.find(({ id }) => id === `${seatBinding.id}-approach-sit-stand`);
    assertCanonicalEqual(scenario.objectIds, [seatBinding.objectId, "conference-table"], `seat_scenario_objects_drift:${seatBinding.id}`);
    assertCanonicalEqual(scenario.runtimeBindingIds, [seatBinding.id], `seat_scenario_binding_drift:${seatBinding.id}`);
    assertCanonicalEqual(scenario.steps.map(({ action }) => action), ["approach", "sit", "stand"], `seat_scenario_steps_drift:${seatBinding.id}`);
    assert(scenario.implementationRequired === true, `seat_scenario_implementation_required:${seatBinding.id}`);
  }

  const displayScenario = scenarios.find(({ id }) => id === "shared-display-visible-from-all-seats");
  assert(displayScenario.implementationRequired === true, "display_visibility_implementation_required");
  assertCanonicalEqual(displayScenario.runtimeBindingIds, ["debug-main", ...expectedSeatBindings.map(({ id }) => id)], "display_visibility_bindings_drift");
  const eyeHeight = displayScenario.acceptanceCriteria.find(({ id }) => id === "seated-eye-height");
  assert(eyeHeight?.value === 1.2 && eyeHeight.operator === "equals", "display_seated_eye_height_drift");
  for (const { id } of expectedSeatBindings) {
    const visibility = displayScenario.acceptanceCriteria.find(({ id: criterionId }) => criterionId === `display-visible-${id}`);
    assert(visibility?.measure === "display-visible-from-seat" && visibility.value === id, `display_visibility_missing:${id}`);
  }

  const whiteboardScenario = scenarios.find(({ id }) => id === "whiteboard-standing-reach");
  assert(whiteboardScenario.implementationRequired === true && whiteboardScenario.runtimeBindingIds.includes("whiteboard-wall"), "whiteboard_reach_binding_missing");
  assert(whiteboardScenario.objectIds.includes("whiteboard-wall") && whiteboardScenario.objectIds.includes("whiteboard-marker"), "whiteboard_reach_objects_missing");

  const entryScenario = scenarios.find(({ id }) => id === "entry-route");
  assert(entryScenario.implementationRequired === true && entryScenario.steps.some(({ target }) => target === "entry-route"), "entry_route_scenario_incomplete");
  const tableScenario = scenarios.find(({ id }) => id === "table-knee-and-arm-clearance");
  assert(tableScenario.objectIds.filter((id) => id.startsWith("chair-")).length === 8, "table_clearance_seat_coverage_incomplete");
  const plantScenario = scenarios.find(({ id }) => id === "route-safe-plant-clearance");
  assert(plantScenario.steps.some(({ target }) => target === "presenter-route"), "plant_route_scenario_incomplete");

  for (const [scenarioId, deferredObjectId] of [
    ["door-counterfactual-operation", "main-door"],
    ["speakerphone-deferred-use", "conference-speakerphone"],
    ["cable-management-deferred-use", "conference-table-cable-management"],
    ["whiteboard-marker-deferred-use", "whiteboard-marker"]
  ]) {
    const scenario = scenarios.find(({ id }) => id === scenarioId);
    assert(scenario.implementationRequired === false, `deferred_scenario_requires_implementation:${scenarioId}`);
    assert(scenario.objectIds.includes(deferredObjectId), `deferred_scenario_object_missing:${scenarioId}`);
    assert(realityContext.objectById.get(deferredObjectId).status === "deferred", `deferred_scenario_status_drift:${scenarioId}`);
    assert(scenario.acceptanceCriteria.some(({ measure, value }) => measure === "runtime-implementation-required" && value === false), `deferred_scenario_boundary_missing:${scenarioId}`);
  }
}

function validateBuilderPhysics(acceptance, realityContext) {
  assertExactKeys(acceptance, ["supportChains", "contacts", "scaleRanges", "clearances", "extrasMetrics", "unknownObjects"], "invalid_builder_physics_keys");
  assertCanonicalEqual(acceptance.supportChains, {
    source: "scene-reality.json#objects.parts.supports",
    coverage: "all-non-root-parts",
    mustBeAcyclic: true,
    mustTerminateAtSupportRoot: true
  }, "support_chain_acceptance_drift");
  assertCanonicalEqual(acceptance.contacts, {
    coverage: "all-support-edges",
    metric: "world-aabb-separation",
    maximumGapM: 0.035
  }, "contact_acceptance_drift");

  assert(Array.isArray(acceptance.scaleRanges), "invalid_scale_ranges");
  assertCanonicalEqual(acceptance.scaleRanges.map(({ objectId }) => objectId), expectedObjects.map(({ id }) => id), "scale_range_object_coverage_drift");
  for (const range of acceptance.scaleRanges) {
    assertExactKeys(range, ["objectId", "minimumM", "maximumM"], `invalid_scale_range_keys:${range.objectId}`);
    assertVector3(range.minimumM, `invalid_scale_minimum:${range.objectId}`);
    assertVector3(range.maximumM, `invalid_scale_maximum:${range.objectId}`);
    for (const axis of ["x", "y", "z"]) {
      assert(range.minimumM[axis] > 0 && range.maximumM[axis] >= range.minimumM[axis], `invalid_scale_interval:${range.objectId}:${axis}`);
    }
  }

  assert(Array.isArray(acceptance.clearances), "invalid_clearances");
  assertCanonicalEqual(acceptance.clearances.map(({ id }) => id), expectedClearanceIds, "clearance_coverage_drift");
  for (const clearance of acceptance.clearances) {
    assertExactKeys(clearance, ["id", "metric", "subject", "target", "axis", "operator", "valueM"], `invalid_clearance_keys:${clearance.id}`);
    assertIdentifier(clearance.id, "invalid_clearance_id");
    assert(["world-aabb-min", "world-aabb-max", "world-aabb-axis-gap"].includes(clearance.metric), `invalid_clearance_metric:${clearance.id}`);
    assertPartReference(clearance.subject, realityContext.partByKey, `invalid_clearance_subject:${clearance.id}`, true);
    if (clearance.metric === "world-aabb-axis-gap") {
      assertPartReference(clearance.target, realityContext.partByKey, `invalid_clearance_target:${clearance.id}`, true);
    } else {
      assert(clearance.target === null, `unexpected_clearance_target:${clearance.id}`);
    }
    assert(["x", "y", "z"].includes(clearance.axis), `invalid_clearance_axis:${clearance.id}`);
    assert(["greater-than-or-equal", "less-than-or-equal"].includes(clearance.operator), `invalid_clearance_operator:${clearance.id}`);
    assertFiniteNumber(clearance.valueM, `invalid_clearance_value:${clearance.id}`);
  }

  assert(Array.isArray(acceptance.extrasMetrics), "invalid_extras_metrics");
  assertCanonicalEqual(acceptance.extrasMetrics.map(({ id }) => id), expectedExtrasMetrics.map(({ id }) => id), "extras_metric_coverage_drift");
  for (const [index, metric] of acceptance.extrasMetrics.entries()) {
    const expected = expectedExtrasMetrics[index];
    assertExactKeys(metric, ["id", "objectId", "partId", "key", "operator", "value"], `invalid_extras_metric_keys:${expected.id}`);
    assert(metric.id === expected.id && metric.objectId === expected.objectId && metric.partId === expected.partId
      && metric.key === expected.key && metric.operator === "equals" && Object.is(metric.value, expected.value), `extras_metric_drift:${expected.id}`);
    assert(realityContext.partByKey.has(partKey(metric.objectId, metric.partId)), `extras_metric_unknown_part:${metric.id}`);
  }

  assertCanonicalEqual(acceptance.unknownObjects, { policy: "reject", expectedObjects: 27, expectedParts: 139 }, "unknown_object_policy_drift");
}

export function validateUserScenariosContract(scenarios, realityContext) {
  assertExactKeys(scenarios, ["schemaVersion", "sceneId", "releaseVersion", "actorProfiles", "routes", "scenarios", "builderPhysicsAcceptance"], "invalid_user_scenarios_keys");
  assert(scenarios.schemaVersion === 1, "invalid_user_scenarios_schema_version");
  assert(scenarios.sceneId === SCENE_ID, "user_scenarios_scene_id_mismatch");
  assert(scenarios.releaseVersion === RELEASE_VERSION, "user_scenarios_release_version_mismatch");
  validateActorProfiles(scenarios.actorProfiles);
  validateRoutes(scenarios.routes);
  validateScenarios(scenarios.scenarios, realityContext);
  validateBuilderPhysics(scenarios.builderPhysicsAcceptance, realityContext);
  return {
    scenarioCount: scenarios.scenarios.length,
    scaleRangeCount: scenarios.builderPhysicsAcceptance.scaleRanges.length,
    clearanceCount: scenarios.builderPhysicsAcceptance.clearances.length,
    extrasMetricCount: scenarios.builderPhysicsAcceptance.extrasMetrics.length
  };
}

function manifestSeatBinding(binding) {
  const { objectId: _objectId, partId: _partId, ...manifestBinding } = binding;
  return manifestBinding;
}

function manifestMediaBinding(binding) {
  const { objectId: _objectId, partId: _partId, ...manifestBinding } = binding;
  return manifestBinding;
}

export function validateSceneManifest(scene, reality) {
  assert(isRecord(scene), "invalid_release_scene_manifest");
  assert(scene.schemaVersion === 1, "invalid_release_scene_schema_version");
  assert(scene.sceneId === SCENE_ID, "release_scene_id_mismatch");
  assert(scene.version === RELEASE_VERSION, "release_scene_version_mismatch");
  assert(scene.glbPath === "scene.glb", "release_scene_glb_path_mismatch");
  assert(isRecord(scene.anchors) && Array.isArray(scene.anchors.seatAnchors), "release_scene_seat_anchors_missing");
  assert(Array.isArray(scene.mediaSurfaces), "release_scene_media_surfaces_missing");
  assertCanonicalEqual(scene.anchors.seatAnchors, reality.runtimeBindings.seatAnchors.map(manifestSeatBinding), "release_scene_seat_bindings_drift");
  assertCanonicalEqual(scene.mediaSurfaces, reality.runtimeBindings.mediaSurfaces.map(manifestMediaBinding), "release_scene_media_bindings_drift");
  return { seatAnchors: scene.anchors.seatAnchors.length, mediaSurfaces: scene.mediaSurfaces.length };
}

function parseGlbDocument(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 20, "invalid_glb_header");
  assert(bytes.subarray(0, 4).toString("ascii") === "glTF", "invalid_glb_magic");
  assert(bytes.readUInt32LE(4) === 2, "invalid_glb_version");
  assert(bytes.readUInt32LE(8) === bytes.length, "invalid_glb_length");
  let offset = 12;
  let jsonChunk = null;
  while (offset < bytes.length) {
    assert(offset + 8 <= bytes.length, "invalid_glb_chunk_header");
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    assert(offset + length <= bytes.length, "invalid_glb_chunk_length");
    if (type === 0x4e4f534a) {
      assert(jsonChunk === null, "duplicate_glb_json_chunk");
      jsonChunk = bytes.subarray(offset, offset + length);
    }
    offset += length;
  }
  assert(offset === bytes.length && jsonChunk, "glb_json_chunk_missing");
  try {
    return JSON.parse(jsonChunk.toString("utf8").replace(/[\u0000\u0020\t\r\n]+$/u, ""));
  } catch (error) {
    throw new Error(`invalid_glb_json:${error.message}`);
  }
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(left, right) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let inner = 0; inner < 4; inner += 1) result[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
    }
  }
  return result;
}

function nodeLocalMatrix(node, index) {
  if (node.matrix !== undefined) {
    assert(Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every(Number.isFinite), `invalid_node_matrix:${index}`);
    assert(!["translation", "rotation", "scale"].some((key) => Object.hasOwn(node, key)), `node_matrix_trs_conflict:${index}`);
    return node.matrix;
  }
  const translation = node.translation ?? [0, 0, 0];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const scale = node.scale ?? [1, 1, 1];
  assert(Array.isArray(translation) && translation.length === 3 && translation.every(Number.isFinite), `invalid_node_translation:${index}`);
  assert(Array.isArray(rotation) && rotation.length === 4 && rotation.every(Number.isFinite), `invalid_node_rotation:${index}`);
  assert(Array.isArray(scale) && scale.length === 3 && scale.every(Number.isFinite), `invalid_node_scale:${index}`);
  const [qx, qy, qz, qw] = rotation;
  const norm = Math.hypot(qx, qy, qz, qw);
  assert(norm > 0, `zero_node_quaternion:${index}`);
  const x = qx / norm;
  const y = qy / norm;
  const z = qz / norm;
  const w = qw / norm;
  const matrix = [
    1 - 2 * y * y - 2 * z * z, 2 * x * y + 2 * w * z, 2 * x * z - 2 * w * y, 0,
    2 * x * y - 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z + 2 * w * x, 0,
    2 * x * z + 2 * w * y, 2 * y * z - 2 * w * x, 1 - 2 * x * x - 2 * y * y, 0,
    translation[0], translation[1], translation[2], 1
  ];
  for (const row of [0, 1, 2]) {
    matrix[row] *= scale[0];
    matrix[4 + row] *= scale[1];
    matrix[8 + row] *= scale[2];
  }
  return matrix;
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  assert(Math.abs(w) > EPSILON, "invalid_transformed_point_w");
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w
  ];
}

function unionBounds(boundsList, code) {
  assert(boundsList.length > 0, code);
  return {
    min: [0, 1, 2].map((axis) => Math.min(...boundsList.map(({ min }) => min[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...boundsList.map(({ max }) => max[axis])))
  };
}

function transformedBounds(bounds, matrix) {
  const corners = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push(transformPoint(matrix, [x, y, z]));
    }
  }
  return {
    min: [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis])))
  };
}

function meshLocalBounds(document, meshIndex, nodeName) {
  const mesh = document.meshes?.[meshIndex];
  assert(isRecord(mesh) && Array.isArray(mesh.primitives) && mesh.primitives.length > 0, `invalid_mesh:${nodeName}`);
  const primitiveBounds = mesh.primitives.map((primitive, primitiveIndex) => {
    assert(isRecord(primitive?.attributes) && Number.isInteger(primitive.attributes.POSITION), `mesh_position_accessor_missing:${nodeName}:${primitiveIndex}`);
    const accessor = document.accessors?.[primitive.attributes.POSITION];
    assert(isRecord(accessor) && accessor.type === "VEC3", `invalid_position_accessor:${nodeName}:${primitiveIndex}`);
    assert(Array.isArray(accessor.min) && accessor.min.length === 3 && accessor.min.every(Number.isFinite), `position_accessor_min_missing:${nodeName}:${primitiveIndex}`);
    assert(Array.isArray(accessor.max) && accessor.max.length === 3 && accessor.max.every(Number.isFinite), `position_accessor_max_missing:${nodeName}:${primitiveIndex}`);
    for (let axis = 0; axis < 3; axis += 1) assert(accessor.max[axis] >= accessor.min[axis], `position_accessor_bounds_invalid:${nodeName}:${primitiveIndex}:${axis}`);
    return { min: accessor.min, max: accessor.max };
  });
  return unionBounds(primitiveBounds, `mesh_bounds_missing:${nodeName}`);
}

function nodeWorldMatrices(document, activeSceneIndex) {
  const nodes = document.nodes ?? [];
  assert(Array.isArray(nodes), "invalid_glb_nodes");
  const parentByChild = new Map();
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.children === undefined) continue;
    assert(Array.isArray(node.children), `invalid_node_children:${nodeIndex}`);
    assertUnique(node.children, `duplicate_node_child:${nodeIndex}`);
    for (const child of node.children) {
      assert(Number.isInteger(child) && child >= 0 && child < nodes.length, `invalid_node_child:${nodeIndex}:${child}`);
      assert(!parentByChild.has(child), `node_has_multiple_parents:${child}`);
      parentByChild.set(child, nodeIndex);
    }
  }
  const activeScene = document.scenes[activeSceneIndex];
  assert(isRecord(activeScene) && Array.isArray(activeScene.nodes), "invalid_active_glb_scene");
  const reachable = new Set();
  const walk = (nodeIndex, stack = new Set()) => {
    assert(Number.isInteger(nodeIndex) && nodeIndex >= 0 && nodeIndex < nodes.length, `invalid_scene_root_node:${nodeIndex}`);
    assert(!stack.has(nodeIndex), `node_hierarchy_cycle:${nodeIndex}`);
    if (reachable.has(nodeIndex)) return;
    reachable.add(nodeIndex);
    const nextStack = new Set(stack).add(nodeIndex);
    for (const child of nodes[nodeIndex].children ?? []) walk(child, nextStack);
  };
  for (const rootIndex of activeScene.nodes) walk(rootIndex);

  const matrices = new Map();
  const computing = new Set();
  const compute = (nodeIndex) => {
    if (matrices.has(nodeIndex)) return matrices.get(nodeIndex);
    assert(!computing.has(nodeIndex), `node_hierarchy_cycle:${nodeIndex}`);
    computing.add(nodeIndex);
    const local = nodeLocalMatrix(nodes[nodeIndex], nodeIndex);
    const parent = parentByChild.get(nodeIndex);
    const world = parent === undefined ? local : multiplyMatrices(compute(parent), local);
    computing.delete(nodeIndex);
    matrices.set(nodeIndex, world);
    return world;
  };
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) compute(nodeIndex);
  return { matrices, reachable };
}

function boundsForReference(reference, partBounds, objectBounds) {
  return reference.partId === null
    ? objectBounds.get(reference.objectId)
    : partBounds.get(partKey(reference.objectId, reference.partId));
}

function compareMetric(actual, operator, expected, code) {
  if (operator === "equals") {
    if (typeof expected === "number") assert(typeof actual === "number" && Math.abs(actual - expected) <= EPSILON, `${code}:${actual}`);
    else assert(actual === expected, `${code}:${String(actual)}`);
  } else if (operator === "greater-than-or-equal") {
    assert(actual + EPSILON >= expected, `${code}:${actual}`);
  } else if (operator === "less-than-or-equal") {
    assert(actual - EPSILON <= expected, `${code}:${actual}`);
  } else {
    throw new Error(`unsupported_metric_operator:${operator}`);
  }
}

function validateGeometryAcceptance(partBounds, objectBounds, nodeByPart, reality, scenarios) {
  const acceptance = scenarios.builderPhysicsAcceptance;
  let contactsValidated = 0;
  for (const object of reality.objects) {
    for (const part of object.parts) {
      const childBounds = partBounds.get(partKey(object.id, part.id));
      for (const edge of part.supports) {
        const parentBounds = partBounds.get(partKey(edge.objectId, edge.partId));
        const gaps = [0, 1, 2].map((axis) => Math.max(childBounds.min[axis] - parentBounds.max[axis], parentBounds.min[axis] - childBounds.max[axis], 0));
        const separation = Math.hypot(...gaps);
        assert(separation <= acceptance.contacts.maximumGapM + EPSILON, `support_contact_gap:${object.id}/${part.id}:${edge.objectId}/${edge.partId}:${separation}`);
        contactsValidated += 1;
      }
    }
  }

  for (const range of acceptance.scaleRanges) {
    const bounds = objectBounds.get(range.objectId);
    assert(bounds, `object_bounds_missing:${range.objectId}`);
    for (const [axisIndex, axis] of ["x", "y", "z"].entries()) {
      const extent = bounds.max[axisIndex] - bounds.min[axisIndex];
      assert(extent + EPSILON >= range.minimumM[axis] && extent - EPSILON <= range.maximumM[axis], `object_scale_out_of_range:${range.objectId}:${axis}:${extent}`);
    }
  }

  for (const clearance of acceptance.clearances) {
    const subject = boundsForReference(clearance.subject, partBounds, objectBounds);
    assert(subject, `clearance_subject_bounds_missing:${clearance.id}`);
    const axis = { x: 0, y: 1, z: 2 }[clearance.axis];
    let actual;
    if (clearance.metric === "world-aabb-min") actual = subject.min[axis];
    else if (clearance.metric === "world-aabb-max") actual = subject.max[axis];
    else {
      const target = boundsForReference(clearance.target, partBounds, objectBounds);
      assert(target, `clearance_target_bounds_missing:${clearance.id}`);
      actual = target.min[axis] - subject.max[axis];
    }
    compareMetric(actual, clearance.operator, clearance.valueM, `clearance_failed:${clearance.id}`);
  }

  for (const metric of acceptance.extrasMetrics) {
    const node = nodeByPart.get(partKey(metric.objectId, metric.partId));
    assert(node && isRecord(node.extras), `extras_metric_node_missing:${metric.id}`);
    assert(Object.hasOwn(node.extras, metric.key), `extras_metric_missing:${metric.id}:${metric.key}`);
    compareMetric(node.extras[metric.key], metric.operator, metric.value, `extras_metric_failed:${metric.id}`);
  }
  return {
    contactsValidated,
    scaleRangesValidated: acceptance.scaleRanges.length,
    clearancesValidated: acceptance.clearances.length,
    extrasMetricsValidated: acceptance.extrasMetrics.length
  };
}

export function validateGlbDocument(document, reality, scenarios, realityContext) {
  assert(isRecord(document) && document.asset?.version === "2.0", "invalid_gltf_asset");
  assert(Array.isArray(document.scenes) && document.scenes.length > 0, "glb_scenes_missing");
  const activeSceneIndex = document.scene ?? 0;
  assert(Number.isInteger(activeSceneIndex) && activeSceneIndex >= 0 && activeSceneIndex < document.scenes.length, "invalid_active_scene_index");
  const activeScene = document.scenes[activeSceneIndex];
  assert(isRecord(activeScene.extras), "glb_scene_extras_missing");
  assert(activeScene.extras.vrataSceneId === SCENE_ID, "glb_scene_id_mismatch");
  assert(activeScene.extras.vrataAuthoringRelease === RELEASE_VERSION, "glb_authoring_release_mismatch");
  assert(activeScene.extras.vrataGeometryStatus === "review", "glb_geometry_status_mismatch");
  assert(activeScene.extras.vrataInteractionSemantics === "passive,deferred,interactive", "glb_interaction_semantics_mismatch");
  assert(!document.cameras?.length, "glb_camera_exported");
  assert(!document.extensionsUsed?.includes("KHR_lights_punctual"), "glb_light_extension_exported");

  const nodes = document.nodes ?? [];
  const { matrices, reachable } = nodeWorldMatrices(document, activeSceneIndex);
  const meshNodes = [];
  const nodeByPart = new Map();
  const partBounds = new Map();
  const objectPartBounds = new Map(expectedObjects.map(({ id }) => [id, []]));
  const names = [];
  const statuses = { passive: 0, deferred: 0, interactive: 0 };
  const transparentExclusions = new Set();

  for (const [nodeIndex, node] of nodes.entries()) {
    const name = node.name ?? "";
    assert(typeof name === "string" && name.length > 0, `unnamed_glb_node:${nodeIndex}`);
    assert(!/unknown/i.test(name), `unknown_glb_node_name:${name}`);
    assert(!/review/i.test(name), `review_glb_node_name:${name}`);
    assert(!name.startsWith("__tmp."), `temporary_glb_node_name:${name}`);
    assert(!/\d+\.\d+/.test(name) && !/\.\d{3}$/.test(name), `float_glb_node_name:${name}`);
    names.push(name);
    if (node.mesh === undefined) continue;
    assert(reachable.has(nodeIndex), `mesh_node_outside_active_scene:${name}`);
    assert(Number.isInteger(node.mesh) && node.mesh >= 0 && node.mesh < (document.meshes?.length ?? 0), `invalid_node_mesh:${name}`);
    assert(node.camera === undefined && node.extensions?.KHR_lights_punctual === undefined, `non_mesh_payload_on_mesh_node:${name}`);
    assert(isRecord(node.extras), `mesh_node_extras_missing:${name}`);
    const extras = node.extras;
    for (const key of ["vrataObjectId", "vrataPartId", "vrataInteractionStatus", "vrataBakePolicy"]) {
      assert(Object.hasOwn(extras, key), `mesh_node_tag_missing:${name}:${key}`);
    }
    assertIdentifier(extras.vrataObjectId, `unstable_mesh_object_id:${name}`);
    assertIdentifier(extras.vrataPartId, `unstable_mesh_part_id:${name}`);
    const key = partKey(extras.vrataObjectId, extras.vrataPartId);
    const object = realityContext.objectById.get(extras.vrataObjectId);
    assert(object && realityContext.partByKey.has(key), `unknown_mesh_object_or_part:${name}:${key}`);
    assert(name === expectedNodeNameByPart.get(key), `mesh_node_name_mismatch:${key}:${name}`);
    assert(extras.vrataInteractionStatus === object.status, `mesh_status_mismatch:${name}:${extras.vrataInteractionStatus}:${object.status}`);
    assert(!nodeByPart.has(key), `duplicate_mesh_object_part:${key}`);
    assert(["include", "exclude-transparent"].includes(extras.vrataBakePolicy), `invalid_mesh_bake_policy:${name}`);
    if (extras.vrataBakePolicy === "exclude-transparent") {
      assert(extras.vrataBakeExclusionReason === "transparent-glass", `invalid_mesh_bake_exclusion:${name}`);
      transparentExclusions.add(key);
    }
    const localBounds = meshLocalBounds(document, node.mesh, name);
    const worldBounds = transformedBounds(localBounds, matrices.get(nodeIndex));
    meshNodes.push(node);
    nodeByPart.set(key, node);
    partBounds.set(key, worldBounds);
    objectPartBounds.get(object.id).push(worldBounds);
    statuses[object.status] += 1;
  }
  assertUnique(names, "duplicate_glb_node_name");
  assert(meshNodes.length === 139, `glb_mesh_node_count_mismatch:${meshNodes.length}`);
  assertCanonicalEqual([...nodeByPart.keys()].sort(), [...expectedPartKeys].sort(), "glb_object_part_set_drift");
  assertCanonicalEqual(statuses, expectedPartsByStatus, "glb_status_counts_drift");
  assertCanonicalEqual([...transparentExclusions].sort(), ["exterior-neighbor-building/window-glass", "main-window/glass"], "glb_transparent_exclusions_drift");
  const objectBounds = new Map([...objectPartBounds].map(([objectId, bounds]) => [objectId, unionBounds(bounds, `object_bounds_missing:${objectId}`)]));
  const geometry = validateGeometryAcceptance(partBounds, objectBounds, nodeByPart, reality, scenarios);
  return { meshNodeCount: meshNodes.length, objectCount: objectBounds.size, ...geometry };
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${code}:${error.message}`);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function resolveInput(root, path) {
  return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function parseArguments(argv) {
  const options = { scenePath: null, glbPath: null, reportPath: null };
  let separatorSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      assert(!separatorSeen, "duplicate_argument_separator");
      separatorSeen = true;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    assert(["--scene", "--glb", "--report"].includes(name), `unknown_argument:${argument}`);
    const key = name === "--scene" ? "scenePath" : name === "--glb" ? "glbPath" : "reportPath";
    assert(options[key] === null, `duplicate_argument:${name}`);
    if (name === "--report" && inlineValue === undefined && (argv[index + 1] === undefined || argv[index + 1].startsWith("--"))) {
      options.reportPath = DEFAULT_REPORT_PATH;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    assert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `missing_argument_value:${name}`);
    options[key] = value;
  }
  return options;
}

export async function runSceneRealityValidation(options = {}) {
  const root = options.root ? resolve(options.root) : repositoryRoot;
  const reality = await readJson(resolve(root, REALITY_PATH), "scene_reality_read_failed");
  const scenarios = await readJson(resolve(root, SCENARIOS_PATH), "user_scenarios_read_failed");
  const realityContext = validateSceneRealityContract(reality);
  const scenarioContext = validateUserScenariosContract(scenarios, realityContext);

  let scenePath = options.scenePath ? resolveInput(root, options.scenePath) : null;
  let glbPath = options.glbPath ? resolveInput(root, options.glbPath) : null;
  const defaultScenePath = resolve(root, DEFAULT_RELEASE_ROOT, "scene.json");
  const defaultGlbPath = resolve(root, DEFAULT_RELEASE_ROOT, "scene.glb");
  if (!scenePath && !glbPath) {
    const [defaultSceneExists, defaultGlbExists] = await Promise.all([exists(defaultScenePath), exists(defaultGlbPath)]);
    if (defaultSceneExists || defaultGlbExists) {
      assert(defaultSceneExists && defaultGlbExists, "incomplete_0_3_0_release_artifacts");
      scenePath = defaultScenePath;
    }
  }

  let manifestResult = null;
  if (scenePath) {
    const scene = await readJson(scenePath, "release_scene_read_failed");
    manifestResult = validateSceneManifest(scene, reality);
    const referencedGlb = resolve(dirname(scenePath), scene.glbPath);
    if (glbPath) assert(resolve(glbPath) === referencedGlb, "scene_glb_argument_mismatch");
    else glbPath = referencedGlb;
  }

  let glbResult = null;
  if (glbPath) {
    let bytes;
    try {
      bytes = await readFile(glbPath);
    } catch (error) {
      throw new Error(`release_glb_read_failed:${error.message}`);
    }
    glbResult = validateGlbDocument(parseGlbDocument(bytes), reality, scenarios, realityContext);
  }

  const report = {
    schemaVersion: 1,
    sceneId: SCENE_ID,
    releaseVersion: RELEASE_VERSION,
    result: "valid",
    contracts: {
      objects: realityContext.objectById.size,
      parts: realityContext.partByKey.size,
      partsByStatus: realityContext.partsByStatus,
      supportRoots: reality.supportRoots.length,
      supportEdges: realityContext.supportEdges,
      scenarios: scenarioContext.scenarioCount,
      scaleRanges: scenarioContext.scaleRangeCount,
      clearances: scenarioContext.clearanceCount,
      extrasMetrics: scenarioContext.extrasMetricCount
    },
    release: {
      sceneManifestValidated: manifestResult !== null,
      glbValidated: glbResult !== null,
      seatAnchorsValidated: manifestResult?.seatAnchors ?? 0,
      mediaSurfacesValidated: manifestResult?.mediaSurfaces ?? 0,
      meshNodesValidated: glbResult?.meshNodeCount ?? 0,
      contactsValidated: glbResult?.contactsValidated ?? 0,
      scaleRangesValidated: glbResult?.scaleRangesValidated ?? 0,
      clearancesValidated: glbResult?.clearancesValidated ?? 0,
      extrasMetricsValidated: glbResult?.extrasMetricsValidated ?? 0
    }
  };

  if (options.reportPath) {
    const reportPath = resolveInput(root, options.reportPath);
    assert(reportPath.endsWith(".json"), "report_path_must_be_json");
    assert(![resolve(root, REALITY_PATH), resolve(root, SCENARIOS_PATH), scenePath, glbPath].filter(Boolean).includes(reportPath), "report_path_overwrites_input");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runSceneRealityValidation(options);
  process.stdout.write(`Scene reality ${report.releaseVersion} is valid: ${report.contracts.objects} objects, ${report.contracts.parts} parts.\n`);
  if (options.reportPath) process.stdout.write(`Report: ${options.reportPath === DEFAULT_REPORT_PATH ? DEFAULT_REPORT_PATH : options.reportPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
