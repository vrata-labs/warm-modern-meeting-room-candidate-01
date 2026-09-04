import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

import bpy
from mathutils import Vector


RELEASE_VERSION = "0.3.3"
SCENE_ID = "warm-modern-meeting-room-candidate-01"
EXPECTED_BLENDER_VERSION = (4, 5, 12)
EXPECTED_SOURCE_SHA256 = "fbddeac0c0fc8e65f3beb736917574f9515116fdb4ef42e4a9cdaa7d10f12b16"
EXPECTED_PANORAMA_SHA256 = "4e960796faa85fc88d8e8647a713c695bcba92f8b6b27832a28f436428425d30"
SOURCE_BLEND = Path(__file__).resolve().parents[2] / "accepted-scene.blend"
PANORAMA_IMAGE = Path(__file__).resolve().parent / "coastal-panorama-cannon.jpg"
REALITY_COLLECTION = "WMMR_REALITY_0_3_3"
REVIEW_COLLECTION = "WMMR_REALITY_0_3_3_REVIEW"
OBSOLETE_COLLECTION = "WMMR_REVIEW_ART_PASS"
INTERACTION_STATUSES = {"passive", "deferred", "interactive"}
EPSILON = 1.0e-5

CHAIRS = (
    ("chair-01", -1.95, 1.15, 1),
    ("chair-02", -0.95, 1.15, 1),
    ("chair-03", 0.05, 1.15, 1),
    ("chair-04", 1.05, 1.15, 1),
    ("chair-05", -1.95, -1.10, -1),
    ("chair-06", -0.95, -1.10, -1),
    ("chair-07", 0.05, -1.10, -1),
    ("chair-08", 1.05, -1.10, -1),
)

REVIEW_VIEWS = (
    ("entry", (2.60, -1.64, 1.60), (-0.45, 0.05, 1.10), 58.0),
    ("diagonal-overview", (-2.80, -2.00, 1.60), (-0.45, 0.05, 1.20), 62.0),
    ("seat-01-display", (-1.95, 1.15, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-02-display", (-0.95, 1.15, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-03-display", (0.05, 1.15, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-04-display", (1.05, 1.15, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-05-display", (-1.95, -1.10, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-06-display", (-0.95, -1.10, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-07-display", (0.05, -1.10, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("seat-08-display", (1.05, -1.10, 1.20), (-3.32, 0.15, 1.52), 55.0),
    ("whiteboard-standing", (1.62, -0.12, 1.65), (3.32, 0.00, 1.45), 52.0),
    ("table-underside", (-0.45, -0.91, 0.29), (-0.45, 0.05, 0.36), 68.0),
    ("media-wall", (1.52, 0.15, 1.55), (-3.32, 0.15, 1.36), 60.0),
    ("door-detail", (2.25, -1.42, 1.22), (1.96, -2.44, 1.05), 44.0),
    ("window-detail", (-0.20, 0.10, 1.62), (-0.20, 2.46, 1.60), 54.0),
    ("coastal-view", (0.00, -0.62, 1.58), (0.00, 7.40, 1.10), 62.0),
    ("pendant-detail", (-0.45, -0.82, 2.08), (-0.45, 0.05, 2.80), 50.0),
)


def arguments():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(
        description="Build the deterministic WMMR 0.3.3 coastal panorama pass."
    )
    parser.add_argument("--output-blend", required=True)
    parser.add_argument("--review-dir", required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--skip-reviews", action="store_true")
    parser.add_argument(
        "--review-view",
        action="append",
        choices=tuple(view_id for view_id, _, _, _ in REVIEW_VIEWS),
        help="Render only the selected review view; repeat for multiple views.",
    )
    return parser.parse_args(values)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def close(actual, expected, label, tolerance=EPSILON):
    require(abs(actual - expected) <= tolerance, f"{label}:{actual:.9f}!={expected:.9f}")


def close_vector(actual, expected, label, tolerance=EPSILON):
    require(len(actual) == len(expected), f"{label}:vector_length")
    for index, (actual_value, expected_value) in enumerate(zip(actual, expected)):
        close(actual_value, expected_value, f"{label}:{index}", tolerance)


def sanitize_saved_ui_state():
    file_browser_screens = [
        screen
        for screen in bpy.data.screens
        if any(area.type == "FILE_BROWSER" for area in screen.areas)
    ]
    file_browser_screen_names = {screen.name for screen in file_browser_screens}
    file_browser_workspaces = [
        workspace
        for workspace in bpy.data.workspaces
        if workspace.name in file_browser_screen_names
    ]
    bpy.data.batch_remove(ids=[*file_browser_workspaces, *file_browser_screens])


def object_required(name):
    value = bpy.data.objects.get(name)
    require(value is not None, f"missing_object:{name}")
    return value


def material_required(name):
    value = bpy.data.materials.get(name)
    require(value is not None, f"missing_material:{name}")
    return value


def assert_baseline():
    require(bpy.app.version[:3] == EXPECTED_BLENDER_VERSION, "unsupported_blender_version")
    require(len(bpy.data.objects) == 153, "baseline_object_count_changed")
    require(set(bpy.data.collections.keys()) == {
        "WMMR_APPROVED_CANDIDATE_LIGHTING",
        OBSOLETE_COLLECTION,
    }, "baseline_collection_names_changed")
    require(len(bpy.data.collections[OBSOLETE_COLLECTION].objects) == 104, "baseline_art_pass_count_changed")

    expected_core_names = {
        "shell.floor",
        "shell.ceiling",
        "shell.walls",
        "component.conference-table.top",
        "component.conference-table.leg-negative-x",
        "component.conference-table.leg-positive-x",
        "component.conference-av.body",
        "component.pendant-fixture.bar-negative-x",
        "component.pendant-fixture.bar-positive-x",
        "opening.main-door.frame.head",
        "opening.main-window.frame.head",
        "exterior.context-mass",
        "camera.review.entry",
    }
    expected_core_names.update(
        f"component.{chair_id}.{part}"
        for chair_id, _, _, _ in CHAIRS
        for part in ("seat", "back")
    )
    require(expected_core_names.issubset(bpy.data.objects.keys()), "baseline_object_names_changed")

    top = object_required("component.conference-table.top")
    close_vector(top.location, (-0.45, 0.05, 0.68), "baseline_table_top_location")
    close_vector(top.dimensions, (3.60, 1.18, 0.12), "baseline_table_top_dimensions")
    for name, location in (
        ("component.conference-table.leg-negative-x", (-1.80, 0.05, 0.31)),
        ("component.conference-table.leg-positive-x", (0.90, 0.05, 0.31)),
    ):
        close_vector(object_required(name).location, location, f"baseline_transform:{name}")

    for chair_id, x, y, back_sign in CHAIRS:
        seat = object_required(f"component.{chair_id}.seat")
        back = object_required(f"component.{chair_id}.back")
        close_vector(seat.location, (x, y, 0.47), f"baseline_seat_location:{chair_id}")
        close_vector(back.location, (x, y + back_sign * 0.24, 0.75), f"baseline_back_location:{chair_id}")
        close(back.rotation_euler.x, -back_sign * math.radians(7.0), f"baseline_back_rotation:{chair_id}")
        expected_material = (
            "material.muted-grey-green-fabric"
            if chair_id in {"chair-02", "chair-07"}
            else "material.sand-fabric"
        )
        require(seat.data.materials[0].name == expected_material, f"baseline_seat_material:{chair_id}")
        require(back.data.materials[0].name == expected_material, f"baseline_back_material:{chair_id}")

    close_vector(
        object_required("component.pendant-fixture.bar-negative-x").location,
        (-1.10, 0.05, 2.64),
        "baseline_pendant_west",
    )
    close_vector(
        object_required("component.pendant-fixture.bar-positive-x").location,
        (0.20, 0.05, 2.64),
        "baseline_pendant_east",
    )


def srgb_channel(value):
    value /= 255.0
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def color(hex_value, alpha=1.0):
    rgb = tuple(srgb_channel(int(hex_value[index : index + 2], 16)) for index in (1, 3, 5))
    return (*rgb, alpha)


def scalar_material(
    name,
    base_hex,
    roughness,
    metallic=0.0,
    alpha=1.0,
    transmission=0.0,
    emission_hex=None,
    emission_strength=0.0,
):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    base = color(base_hex, alpha)
    shader.inputs["Base Color"].default_value = base
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Alpha"].default_value = alpha
    if "Transmission Weight" in shader.inputs:
        shader.inputs["Transmission Weight"].default_value = transmission
    if "IOR" in shader.inputs:
        shader.inputs["IOR"].default_value = 1.45
    if emission_hex:
        shader.inputs["Emission Color"].default_value = color(emission_hex)
        shader.inputs["Emission Strength"].default_value = emission_strength
    material.diffuse_color = base
    material["vrataMaterialRelease"] = RELEASE_VERSION
    material["vrataNonEmissive"] = emission_strength == 0.0
    if alpha < 1.0:
        try:
            material.surface_render_method = "DITHERED"
        except (AttributeError, TypeError, ValueError):
            pass
    return material


def panorama_material():
    require(PANORAMA_IMAGE.is_file(), "coastal_panorama_missing")
    require(
        sha256(PANORAMA_IMAGE) == EXPECTED_PANORAMA_SHA256,
        "coastal_panorama_sha256_changed",
    )
    image = bpy.data.images.load(str(PANORAMA_IMAGE), check_existing=False)
    image.name = "image.exterior.coastal-panorama"
    image.colorspace_settings.name = "sRGB"
    image.pack()
    image.filepath = "//coastal-panorama-cannon.jpg"

    material = bpy.data.materials.get("material.exterior.coastal-panorama") or bpy.data.materials.new(
        "material.exterior.coastal-panorama"
    )
    material.use_nodes = True
    material.use_backface_culling = False
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "REPEAT"
    shader.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    shader.inputs["Roughness"].default_value = 1.0
    shader.inputs["Emission Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    shader.inputs["Emission Strength"].default_value = 0.8
    material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Emission Color"])
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
    material["vrataMaterialRelease"] = RELEASE_VERSION
    material["vrataNonEmissive"] = False
    return material


def assign_material(value, material):
    value.data.materials.clear()
    value.data.materials.append(material)


def ensure_collection(name):
    collection = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
    return collection


def move_to_collection(value, collection):
    for owner in list(value.users_collection):
        owner.objects.unlink(value)
    collection.objects.link(value)


def tag(value, object_id, part_id, status):
    require(status in INTERACTION_STATUSES, f"invalid_interaction_status:{status}")
    value["vrataObjectId"] = object_id
    value["vrataPartId"] = part_id
    value["vrataInteractionStatus"] = status
    value["vrataBakePolicy"] = "include"


def apply_bevel(value, width, segments=3):
    if width <= 0.0:
        return
    modifier = value.modifiers.new("reality-bevel", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = value
    value.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def rounded_box(
    name,
    location,
    dimensions,
    material,
    collection,
    object_id=None,
    part_id=None,
    status="passive",
    bevel=0.01,
    rotation=(0.0, 0.0, 0.0),
):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=location)
    value = bpy.context.object
    value.name = name
    value.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    apply_bevel(value, min(bevel, min(dimensions) * 0.4))
    value.rotation_euler = rotation
    value.data.name = f"mesh.{name}"
    assign_material(value, material)
    move_to_collection(value, collection)
    if object_id is not None:
        tag(value, object_id, part_id, status)
    return value


def cylinder(
    name,
    location,
    radius,
    depth,
    material,
    collection,
    object_id=None,
    part_id=None,
    status="passive",
    vertices=24,
    bevel=0.0,
):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
    )
    value = bpy.context.object
    value.name = name
    apply_bevel(value, min(bevel, radius * 0.45, depth * 0.2))
    value.data.name = f"mesh.{name}"
    assign_material(value, material)
    move_to_collection(value, collection)
    if object_id is not None:
        tag(value, object_id, part_id, status)
    return value


def cylinder_between(
    name,
    start,
    end,
    radius,
    material,
    collection,
    object_id=None,
    part_id=None,
    status="passive",
    vertices=16,
):
    start_value = Vector(start)
    end_value = Vector(end)
    direction = end_value - start_value
    require(direction.length > EPSILON, f"zero_length_cylinder:{name}")
    value = cylinder(
        name,
        (start_value + end_value) * 0.5,
        radius,
        direction.length,
        material,
        collection,
        object_id,
        part_id,
        status,
        vertices,
    )
    value.rotation_mode = "QUATERNION"
    value.rotation_quaternion = direction.to_track_quat("Z", "Y")
    return value


def ico_sphere(name, location, scale, material, collection):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.0, location=location)
    value = bpy.context.object
    value.name = name
    value.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    value.data.name = f"mesh.{name}"
    assign_material(value, material)
    move_to_collection(value, collection)
    return value


def torus(name, location, major_radius, minor_radius, material, collection, object_id, part_id, status):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.mesh.primitive_torus_add(
        major_segments=32,
        minor_segments=8,
        major_radius=major_radius,
        minor_radius=minor_radius,
        location=location,
    )
    value = bpy.context.object
    value.name = name
    value.data.name = f"mesh.{name}"
    assign_material(value, material)
    move_to_collection(value, collection)
    tag(value, object_id, part_id, status)
    return value


def join_meshes(name, values, material, object_id, part_id, status):
    require(values, f"empty_join:{name}")
    source_meshes = [value.data for value in values[1:]]
    bpy.ops.object.select_all(action="DESELECT")
    for value in values:
        value.select_set(True)
    bpy.context.view_layer.objects.active = values[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    joined.data.name = f"mesh.{name}"
    assign_material(joined, material)
    tag(joined, object_id, part_id, status)
    for mesh in source_meshes:
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    return joined


def remove_object(value):
    data = value.data if hasattr(value, "data") else None
    bpy.data.objects.remove(value, do_unlink=True)
    if data is None or data.users != 0:
        return
    if isinstance(data, bpy.types.Mesh):
        bpy.data.meshes.remove(data)
    elif isinstance(data, bpy.types.Camera):
        bpy.data.cameras.remove(data)
    elif isinstance(data, bpy.types.Light):
        bpy.data.lights.remove(data)


def remove_named(name):
    value = bpy.data.objects.get(name)
    if value is not None:
        remove_object(value)


def remove_obsolete_art_pass():
    collection = bpy.data.collections.get(OBSOLETE_COLLECTION)
    require(collection is not None, "baseline_art_pass_missing")
    for value in list(collection.objects):
        remove_object(value)
    bpy.data.collections.remove(collection)
    remove_named("camera.review.entry")


def vertical_ring_x(
    name,
    center,
    depth,
    outer_width,
    outer_height,
    border,
    material,
    collection,
    object_id,
    part_id,
    status="passive",
):
    x, y, z = center
    parts = [
        rounded_box(f"__tmp.{name}.top", (x, y, z + (outer_height - border) * 0.5), (depth, outer_width, border), material, collection, bevel=border * 0.2),
        rounded_box(f"__tmp.{name}.bottom", (x, y, z - (outer_height - border) * 0.5), (depth, outer_width, border), material, collection, bevel=border * 0.2),
        rounded_box(f"__tmp.{name}.left", (x, y - (outer_width - border) * 0.5, z), (depth, border, outer_height - border * 2.0), material, collection, bevel=border * 0.2),
        rounded_box(f"__tmp.{name}.right", (x, y + (outer_width - border) * 0.5, z), (depth, border, outer_height - border * 2.0), material, collection, bevel=border * 0.2),
    ]
    return join_meshes(name, parts, material, object_id, part_id, status)


def vertical_ring_y(
    name,
    center,
    depth,
    outer_width,
    outer_height,
    border,
    material,
    collection,
    object_id,
    part_id,
    status="passive",
):
    x, y, z = center
    parts = [
        rounded_box(f"__tmp.{name}.top", (x, y, z + (outer_height - border) * 0.5), (outer_width, depth, border), material, collection, bevel=border * 0.2),
        rounded_box(f"__tmp.{name}.bottom", (x, y, z - (outer_height - border) * 0.5), (outer_width, depth, border), material, collection, bevel=border * 0.2),
        rounded_box(f"__tmp.{name}.left", (x - (outer_width - border) * 0.5, y, z), (border, depth, outer_height - border * 2.0), material, collection, bevel=border * 0.2),
        rounded_box(f"__tmp.{name}.right", (x + (outer_width - border) * 0.5, y, z), (border, depth, outer_height - border * 2.0), material, collection, bevel=border * 0.2),
    ]
    return join_meshes(name, parts, material, object_id, part_id, status)


def build_materials():
    materials = {
        "oak": material_required("material.warm-oak"),
        "graphite": material_required("material.graphite-metal"),
        "sand": material_required("material.sand-fabric"),
        "green_fabric": material_required("material.muted-grey-green-fabric"),
        "vegetation": material_required("material.exterior-vegetation"),
        "display": scalar_material("material.reality.display", "#11262D", 0.30),
        "whiteboard": scalar_material("material.reality.whiteboard", "#E9E5DD", 0.34),
        "rug": scalar_material("material.reality.rug", "#707A73", 0.94),
        "acoustic": scalar_material("material.reality.acoustic", "#879088", 0.90),
        "planter": scalar_material("material.reality.planter", "#5A493E", 0.76),
        "grille": scalar_material("material.reality.grille", "#171C1E", 0.52, metallic=0.35),
        "mute": scalar_material("material.reality.mute", "#9B3D37", 0.54),
        "status": scalar_material("material.reality.status", "#4F8A6C", 0.48),
        "marker": scalar_material("material.reality.marker-body", "#E5E2DA", 0.48),
        "diffuser": scalar_material(
            "material.reality.diffuser",
            "#F1D4A7",
            0.40,
            emission_hex="#FFD7A0",
            emission_strength=1.4,
        ),
    }
    return materials


def build_media_surfaces(collection, materials):
    vertical_ring_x(
        "media.debug-main.frame",
        (-3.365, 0.15, 1.55),
        0.05,
        3.38,
        1.98,
        0.11,
        materials["graphite"],
        collection,
        "debug-main",
        "frame",
        "interactive",
    )
    rounded_box(
        "media.debug-main.backing",
        (-3.33, 0.15, 1.55),
        (0.02, 3.16, 1.76),
        materials["display"],
        collection,
        "debug-main",
        "surface",
        "interactive",
        bevel=0.012,
    )
    vertical_ring_x(
        "media.whiteboard-wall.frame",
        (3.365, 0.00, 1.50),
        0.05,
        2.56,
        1.41,
        0.10,
        materials["graphite"],
        collection,
        "whiteboard-wall",
        "frame",
        "interactive",
    )
    rounded_box(
        "media.whiteboard-wall.backing",
        (3.33, 0.00, 1.50),
        (0.02, 2.36, 1.21),
        materials["whiteboard"],
        collection,
        "whiteboard-wall",
        "surface",
        "interactive",
        bevel=0.010,
    )


def build_rug(collection, materials):
    return rounded_box(
        "reality.area-rug",
        (-0.45, 0.05, 0.008),
        (4.70, 3.10, 0.016),
        materials["rug"],
        collection,
        "area-rug",
        "rug",
        "passive",
        bevel=0.025,
    )


def build_table(collection, materials):
    for name in (
        "component.conference-table.top",
        "component.conference-table.leg-negative-x",
        "component.conference-table.leg-positive-x",
    ):
        remove_named(name)

    x_min, x_max = -2.25, 1.35
    y_min, y_max = -0.54, 0.64
    opening_x_min, opening_x_max = -1.42, -0.88
    opening_y_min, opening_y_max = -0.06, 0.16
    top_z = 0.7125
    top_height = 0.055
    pieces = [
        rounded_box(
            "__tmp.table-top.west",
            ((x_min + opening_x_min) * 0.5, (y_min + y_max) * 0.5, top_z),
            (opening_x_min - x_min, y_max - y_min, top_height),
            materials["oak"],
            collection,
            bevel=0.014,
        ),
        rounded_box(
            "__tmp.table-top.east",
            ((opening_x_max + x_max) * 0.5, (y_min + y_max) * 0.5, top_z),
            (x_max - opening_x_max, y_max - y_min, top_height),
            materials["oak"],
            collection,
            bevel=0.014,
        ),
        rounded_box(
            "__tmp.table-top.south",
            ((opening_x_min + opening_x_max) * 0.5, (y_min + opening_y_min) * 0.5, top_z),
            (opening_x_max - opening_x_min, opening_y_min - y_min, top_height),
            materials["oak"],
            collection,
            bevel=0.014,
        ),
        rounded_box(
            "__tmp.table-top.north",
            ((opening_x_min + opening_x_max) * 0.5, (opening_y_max + y_max) * 0.5, top_z),
            (opening_x_max - opening_x_min, y_max - opening_y_max, top_height),
            materials["oak"],
            collection,
            bevel=0.014,
        ),
    ]
    top = join_meshes(
        "component.conference-table.top",
        pieces,
        materials["oak"],
        "conference-table",
        "top",
        "passive",
    )
    top["vrataThicknessM"] = top_height
    top["vrataTopHeightM"] = 0.74

    cover = rounded_box(
        "component.conference-table.cable-cover",
        (-1.15, 0.05, 0.738),
        (0.50, 0.18, 0.004),
        materials["graphite"],
        collection,
        "conference-table-cable-management",
        "cable-cover",
        "deferred",
        bevel=0.004,
    )
    rails = [
        rounded_box(
            f"__tmp.cable-cover-support.{side}",
            (x, 0.05, 0.726),
            (0.03, 0.18, 0.020),
            materials["graphite"],
            collection,
            bevel=0.003,
        )
        for side, x in (("west", -1.405), ("east", -0.895))
    ]
    support = join_meshes(
        "component.conference-table.cable-cover-support",
        rails,
        materials["graphite"],
        "conference-table-cable-management",
        "cable-cover-support",
        "deferred",
    )

    for side, x in (("west", -1.45), ("east", 0.55)):
        rounded_box(
            f"component.conference-table.pedestal-{side}-base",
            (x, 0.05, 0.031),
            (0.56, 0.40, 0.030),
            materials["graphite"],
            collection,
            "conference-table",
            f"pedestal-{side}-base",
            "passive",
            bevel=0.012,
        )
        rounded_box(
            f"component.conference-table.pedestal-{side}-column",
            (x, 0.05, 0.3655),
            (0.13, 0.26, 0.639),
            materials["graphite"],
            collection,
            "conference-table",
            f"pedestal-{side}-column",
            "passive",
            bevel=0.018,
        )
    return top, cover, support


def build_chairs(collection, materials):
    for chair_id, _, _, _ in CHAIRS:
        remove_named(f"component.{chair_id}.seat")
        remove_named(f"component.{chair_id}.back")

    rug_top = 0.016
    for chair_id, x, y, back_sign in CHAIRS:
        upholstery = materials["green_fabric"] if chair_id in {"chair-02", "chair-07"} else materials["sand"]
        prefix = f"component.{chair_id}"
        seat = rounded_box(
            f"{prefix}.seat",
            (x, y, 0.4275),
            (0.54, 0.50, 0.085),
            upholstery,
            collection,
            chair_id,
            "seat",
            "interactive",
            bevel=0.022,
        )
        seat["vrataSeatTopM"] = 0.47
        rounded_box(
            f"{prefix}.back",
            (x, y + back_sign * 0.235, 0.735),
            (0.52, 0.075, 0.50),
            upholstery,
            collection,
            chair_id,
            "back",
            "interactive",
            bevel=0.020,
            rotation=(-back_sign * math.radians(7.0), 0.0, 0.0),
        )
        rounded_box(
            f"{prefix}.mechanism",
            (x, y, 0.3625),
            (0.25, 0.22, 0.045),
            materials["graphite"],
            collection,
            chair_id,
            "mechanism",
            "interactive",
            bevel=0.008,
        )
        cylinder(
            f"{prefix}.gas-column",
            (x, y, 0.2455),
            0.034,
            0.189,
            materials["graphite"],
            collection,
            chair_id,
            "gas-column",
            "interactive",
            vertices=20,
            bevel=0.004,
        )

        base_parts = [
            cylinder(
                f"__tmp.{chair_id}.base-hub",
                (x, y, 0.121),
                0.085,
                0.060,
                materials["graphite"],
                collection,
                vertices=20,
                bevel=0.004,
            )
        ]
        for star_index in range(5):
            angle = math.radians(90.0 + star_index * 72.0)
            direction = Vector((math.cos(angle), math.sin(angle), 0.0))
            tangent = Vector((-math.sin(angle), math.cos(angle), 0.0))
            arm_center = Vector((x, y, 0.101)) + direction * 0.1825
            base_parts.append(
                rounded_box(
                    f"__tmp.{chair_id}.star-arm-{star_index + 1:02d}",
                    arm_center,
                    (0.255, 0.035, 0.020),
                    materials["graphite"],
                    collection,
                    bevel=0.008,
                    rotation=(0.0, 0.0, angle),
                )
            )
            wheel_center = Vector((x, y, rug_top + 0.032)) + direction * 0.31
            wheel_start = wheel_center - tangent * 0.0125
            wheel_end = wheel_center + tangent * 0.0125
            base_parts.append(
                cylinder_between(
                    f"__tmp.{chair_id}.caster-wheel-{star_index + 1:02d}",
                    wheel_start,
                    wheel_end,
                    0.032,
                    materials["graphite"],
                    collection,
                    vertices=16,
                )
            )
            base_parts.append(
                cylinder_between(
                    f"__tmp.{chair_id}.caster-stem-{star_index + 1:02d}",
                    (wheel_center.x, wheel_center.y, rug_top + 0.064),
                    (wheel_center.x, wheel_center.y, 0.091),
                    0.009,
                    materials["graphite"],
                    collection,
                    vertices=12,
                )
            )
        base = join_meshes(
            f"{prefix}.five-star-base",
            base_parts,
            materials["graphite"],
            chair_id,
            "five-star-base",
            "interactive",
        )
        base["vrataStarCount"] = 5
        base["vrataCasterCount"] = 5

        back_supports = [
            cylinder_between(
                f"__tmp.{chair_id}.back-support-{side}",
                (x + offset, y + back_sign * 0.105, 0.385),
                (x + offset, y + back_sign * 0.225, 0.59),
                0.012,
                materials["graphite"],
                collection,
                vertices=12,
            )
            for side, offset in (("left", -0.17), ("right", 0.17))
        ]
        join_meshes(
            f"{prefix}.back-supports",
            back_supports,
            materials["graphite"],
            chair_id,
            "back-supports",
            "interactive",
        )

        arm_parts = []
        for side, offset in (("left", -0.265), ("right", 0.265)):
            arm_parts.append(
                rounded_box(
                    f"__tmp.{chair_id}.arm-support-{side}",
                    (x + offset, y - back_sign * 0.04, 0.54),
                    (0.035, 0.035, 0.14),
                    materials["graphite"],
                    collection,
                    bevel=0.008,
                )
            )
            arm_parts.append(
                rounded_box(
                    f"__tmp.{chair_id}.arm-pad-{side}",
                    (x + offset, y - back_sign * 0.04, 0.6325),
                    (0.055, 0.30, 0.045),
                    materials["graphite"],
                    collection,
                    bevel=0.014,
                )
            )
        arms = join_meshes(
            f"{prefix}.arm-assembly",
            arm_parts,
            materials["graphite"],
            chair_id,
            "arm-assembly",
            "interactive",
        )
        arms["vrataArmTopM"] = 0.655


def build_speakerphone(collection, materials):
    remove_named("component.conference-av.body")
    body = cylinder(
        "component.conference-speakerphone.body",
        (-0.45, 0.05, 0.7575),
        0.15,
        0.035,
        materials["graphite"],
        collection,
        "conference-speakerphone",
        "body",
        "deferred",
        vertices=40,
        bevel=0.006,
    )
    cylinder(
        "component.conference-speakerphone.grille",
        (-0.45, 0.05, 0.778),
        0.112,
        0.006,
        materials["grille"],
        collection,
        "conference-speakerphone",
        "grille",
        "deferred",
        vertices=40,
        bevel=0.002,
    )
    dots = []
    dot_index = 1
    for radius, count in ((0.043, 8), (0.078, 12)):
        for index in range(count):
            angle = math.tau * index / count
            dots.append(
                cylinder(
                    f"__tmp.speakerphone.grille-dot-{dot_index:02d}",
                    (-0.45 + math.cos(angle) * radius, 0.05 + math.sin(angle) * radius, 0.782),
                    0.005,
                    0.002,
                    materials["graphite"],
                    collection,
                    vertices=10,
                )
            )
            dot_index += 1
    join_meshes(
        "component.conference-speakerphone.grille-perforations",
        dots,
        materials["graphite"],
        "conference-speakerphone",
        "grille-perforations",
        "deferred",
    )
    cylinder(
        "component.conference-speakerphone.mute-button",
        (-0.45, 0.05, 0.784),
        0.014,
        0.004,
        materials["mute"],
        collection,
        "conference-speakerphone",
        "mute-button",
        "deferred",
        vertices=24,
        bevel=0.001,
    )
    torus(
        "component.conference-speakerphone.status-ring",
        (-0.45, 0.05, 0.777),
        0.136,
        0.002,
        materials["status"],
        collection,
        "conference-speakerphone",
        "status-ring",
        "deferred",
    )
    body["vrataDeviceType"] = "conference-speakerphone"


def build_credenza(collection, materials):
    carcass_parts = [
        rounded_box("__tmp.credenza.side-south", (-3.12, -0.9825, 0.295), (0.38, 0.035, 0.45), materials["oak"], collection, bevel=0.008),
        rounded_box("__tmp.credenza.side-north", (-3.12, 1.2825, 0.295), (0.38, 0.035, 0.45), materials["oak"], collection, bevel=0.008),
        rounded_box("__tmp.credenza.bottom", (-3.12, 0.15, 0.0825), (0.38, 2.23, 0.025), materials["oak"], collection, bevel=0.006),
        rounded_box("__tmp.credenza.top", (-3.12, 0.15, 0.535), (0.40, 2.30, 0.03), materials["oak"], collection, bevel=0.008),
        rounded_box("__tmp.credenza.back", (-3.3175, 0.15, 0.3075), (0.015, 2.23, 0.425), materials["oak"], collection, bevel=0.004),
    ]
    carcass = join_meshes(
        "reality.av-credenza.carcass",
        carcass_parts,
        materials["oak"],
        "av-credenza",
        "carcass",
        "deferred",
    )
    plinth = rounded_box(
        "reality.av-credenza.floor-plinth",
        (-3.12, 0.15, 0.035),
        (0.30, 2.05, 0.07),
        materials["graphite"],
        collection,
        "av-credenza",
        "floor-plinth",
        "deferred",
        bevel=0.010,
    )

    inner_min = -0.965
    gap = 0.012
    door_width = (2.23 - gap * 5.0) / 4.0
    pull_parts = []
    for index in range(4):
        y_min = inner_min + gap + index * (door_width + gap)
        door_y = y_min + door_width * 0.5
        rounded_box(
            f"reality.av-credenza.door-{index + 1:02d}",
            (-2.9175, door_y, 0.305),
            (0.025, door_width, 0.40),
            materials["oak"],
            collection,
            "av-credenza",
            f"door-{index + 1:02d}",
            "deferred",
            bevel=0.008,
        )
        pull_y = door_y + (door_width * 0.32 if index < 2 else -door_width * 0.32)
        pull_parts.append(
            cylinder(
                f"__tmp.credenza.pull-{index + 1:02d}",
                (-2.870, pull_y, 0.305),
                0.006,
                0.12,
                materials["graphite"],
                collection,
                vertices=12,
            )
        )
        for support_index, z in enumerate((0.265, 0.345), start=1):
            pull_parts.append(
                cylinder_between(
                    f"__tmp.credenza.pull-{index + 1:02d}-support-{support_index:02d}",
                    (-2.905, pull_y, z),
                    (-2.870, pull_y, z),
                    0.004,
                    materials["graphite"],
                    collection,
                    vertices=10,
                )
            )
    join_meshes(
        "reality.av-credenza.pulls",
        pull_parts,
        materials["graphite"],
        "av-credenza",
        "pulls",
        "deferred",
    )
    return carcass, plinth


def build_plant(collection, materials):
    pot = cylinder(
        "reality.route-safe-plant.pot",
        (-3.00, 2.10, 0.17),
        0.17,
        0.34,
        materials["planter"],
        collection,
        "route-safe-plant",
        "pot",
        "passive",
        vertices=32,
        bevel=0.012,
    )
    stem_parts = [
        cylinder_between("__tmp.plant.main-stem", (-3.00, 2.10, 0.34), (-3.00, 2.10, 1.40), 0.018, materials["vegetation"], collection, vertices=12)
    ]
    leaves_data = (
        ((-3.10, 2.10, 0.82), (0.10, 0.06, 0.18), (-3.00, 2.10, 0.68)),
        ((-2.91, 2.08, 0.95), (0.11, 0.07, 0.20), (-3.00, 2.10, 0.80)),
        ((-3.05, 2.00, 1.12), (0.09, 0.10, 0.19), (-3.00, 2.10, 0.96)),
        ((-2.95, 2.19, 1.25), (0.10, 0.09, 0.18), (-3.00, 2.10, 1.08)),
        ((-3.02, 2.10, 1.38), (0.10, 0.08, 0.17), (-3.00, 2.10, 1.22)),
    )
    leaves = []
    for index, (location, scale, branch_start) in enumerate(leaves_data, start=1):
        stem_parts.append(
            cylinder_between(
                f"__tmp.plant.branch-{index:02d}",
                branch_start,
                location,
                0.010,
                materials["vegetation"],
                collection,
                vertices=10,
            )
        )
        leaves.append(
            ico_sphere(
                f"__tmp.plant.leaf-{index:02d}",
                location,
                scale,
                materials["vegetation"],
                collection,
            )
        )
    join_meshes(
        "reality.route-safe-plant.stems",
        stem_parts,
        materials["vegetation"],
        "route-safe-plant",
        "stems",
        "passive",
    )
    join_meshes(
        "reality.route-safe-plant.foliage",
        leaves,
        materials["vegetation"],
        "route-safe-plant",
        "foliage",
        "passive",
    )
    pot["vrataCornerId"] = "north-west"
    pot["vrataMinimumRouteMarginM"] = 0.35


def build_acoustics(collection, materials):
    panels = []
    cleats = []
    for index, y in enumerate((-2.22, -1.96, -1.70), start=1):
        panel_part = f"panel-{index:02d}"
        mounting_parts = []
        panel = rounded_box(
            f"reality.media-wall.acoustic-panel-{index:02d}",
            (-3.3675, y, 1.55),
            (0.055, 0.18, 1.30),
            materials["acoustic"],
            collection,
            "media-wall-acoustics",
            panel_part,
            "passive",
            bevel=0.020,
        )
        for level, z in (("lower", 1.20), ("upper", 1.90)):
            mounting_part = f"{panel_part}-mount-{level}"
            cleat = rounded_box(
                f"reality.media-wall.acoustic-panel-{index:02d}-mount-{level}",
                (-3.4025, y, z),
                (0.015, 0.12, 0.08),
                materials["graphite"],
                collection,
                "media-wall-acoustics",
                mounting_part,
                "passive",
                bevel=0.003,
            )
            cleat["vrataSupportObjectId"] = "room-shell"
            cleat["vrataSupportPartId"] = "walls"
            cleat["vrataSupportedObjectId"] = "media-wall-acoustics"
            cleat["vrataSupportedPartId"] = panel_part
            cleat["vrataSupportConnection"] = "wall-to-panel-face-contact"
            mounting_parts.append(mounting_part)
            cleats.append(cleat)
        panel["vrataSupportObjectId"] = "room-shell"
        panel["vrataSupportPartId"] = "walls"
        panel["vrataMountingPartIds"] = json.dumps(mounting_parts, separators=(",", ":"))
        panels.append(panel)
    return panels, cleats


def build_door(collection, materials):
    panel = rounded_box(
        "opening.main-door.panel",
        (2.25, -2.47, 1.05),
        (0.92, 0.05, 2.10),
        materials["oak"],
        collection,
        "main-door",
        "panel",
        "deferred",
        bevel=0.020,
    )
    face_y = -2.445
    rosette = cylinder_between(
        "opening.main-door.hardware.rosette",
        (1.92, face_y, 1.05),
        (1.92, face_y + 0.025, 1.05),
        0.035,
        materials["graphite"],
        collection,
        "main-door",
        "handle-rosette",
        "deferred",
        vertices=24,
    )
    spindle = cylinder_between(
        "opening.main-door.hardware.spindle",
        (1.92, face_y, 1.05),
        (1.92, face_y + 0.060, 1.05),
        0.009,
        materials["graphite"],
        collection,
        "main-door",
        "handle-spindle",
        "deferred",
        vertices=16,
    )
    lever = cylinder_between(
        "opening.main-door.hardware.lever",
        (1.92, face_y + 0.060, 1.05),
        (1.76, face_y + 0.060, 1.05),
        0.012,
        materials["graphite"],
        collection,
        "main-door",
        "handle-lever",
        "deferred",
        vertices=16,
    )
    return panel, rosette, spindle, lever


def build_whiteboard_tray(collection, materials):
    tray = rounded_box(
        "reality.whiteboard.tray",
        (3.285, 0.00, 0.84),
        (0.08, 0.70, 0.04),
        materials["graphite"],
        collection,
        "whiteboard-accessories",
        "tray",
        "passive",
        bevel=0.010,
    )
    marker_body = cylinder_between(
        "reality.whiteboard.marker-body",
        (3.265, -0.08, 0.869),
        (3.265, 0.07, 0.869),
        0.009,
        materials["marker"],
        collection,
        "whiteboard-marker",
        "body",
        "deferred",
        vertices=20,
    )
    marker_cap = cylinder_between(
        "reality.whiteboard.marker-cap",
        (3.265, 0.07, 0.869),
        (3.265, 0.10, 0.869),
        0.0095,
        materials["graphite"],
        collection,
        "whiteboard-marker",
        "cap",
        "deferred",
        vertices=20,
    )
    return tray, marker_body, marker_cap


def build_window(collection, materials):
    bead_specs = (
        ("bottom", (-0.20, 2.4565, 0.7925), (3.19, 0.025, 0.025)),
        ("top", (-0.20, 2.4565, 2.4075), (3.19, 0.025, 0.025)),
        ("left", (-1.8075, 2.4565, 1.60), (0.025, 0.025, 1.59)),
        ("right", (1.4075, 2.4565, 1.60), (0.025, 0.025, 1.59)),
    )
    beads = []
    for side, location, dimensions in bead_specs:
        beads.append(
            rounded_box(
                f"opening.main-window.glazing-bead-{side}",
                location,
                dimensions,
                materials["graphite"],
                collection,
                "main-window",
                f"glazing-bead-{side}",
                "passive",
                bevel=0.004,
            )
        )
    return beads


def build_pendant(collection, materials):
    fixtures = (
        ("west", -1.10, ("left", -1.35), ("right", -0.85), "component.pendant-fixture.bar-negative-x"),
        ("east", 0.20, ("left", -0.05), ("right", 0.45), "component.pendant-fixture.bar-positive-x"),
    )
    for side, x, cable_left, cable_right, housing_name in fixtures:
        rounded_box(
            f"component.pendant-fixture.canopy-{side}",
            (x, 0.05, 3.0875),
            (0.62, 0.12, 0.025),
            materials["graphite"],
            collection,
            "pendant-fixture",
            f"canopy-{side}",
            "passive",
            bevel=0.012,
        )
        rounded_box(
            f"component.pendant-fixture.diffuser-{side}",
            (x, 0.05, 2.5775),
            (0.72, 0.10, 0.025),
            materials["diffuser"],
            collection,
            "pendant-fixture",
            f"diffuser-{side}",
            "passive",
            bevel=0.009,
        )
        for cable_side, cable_x in (cable_left, cable_right):
            cylinder_between(
                f"component.pendant-fixture.cable-{side}-{cable_side}",
                (cable_x, 0.05, 2.69),
                (cable_x, 0.05, 3.075),
                0.0025,
                materials["graphite"],
                collection,
                "pendant-fixture",
                f"cable-{side}-{cable_side}",
                "passive",
                vertices=12,
            )
        housing = object_required(housing_name)
        tag(housing, "pendant-fixture", f"housing-{side}", "passive")


def build_coastal_panorama(collection):
    for value in list(bpy.data.objects):
        if value.name.startswith("exterior."):
            remove_object(value)

    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=96,
        ring_count=48,
        radius=40.0,
        location=(0.0, 0.0, -3.0),
        rotation=(0.0, 0.0, math.radians(45.0)),
    )
    sphere = bpy.context.object
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    sphere.name = "exterior.coastal-panorama"
    sphere.data.name = "mesh.exterior.coastal-panorama"
    assign_material(sphere, panorama_material())
    move_to_collection(sphere, collection)
    tag(sphere, "exterior-panorama", "sphere", "passive")
    sphere["vrataBakePolicy"] = "exclude-unlit-background"
    sphere["vrataBakeExclusionReason"] = "unlit-panorama"
    sphere["vrataSourceAssetId"] = "asset-panorama-cannon-poly-haven-cc0"
    sphere["vrataPanoramaSha256"] = EXPECTED_PANORAMA_SHA256
    sphere["vrataPanoramaRadiusM"] = 40.0
    sphere["vrataPanoramaYawDegrees"] = 45.0


def tag_accepted_meshes():
    exact = {
        "shell.floor": ("room-shell", "floor", "passive"),
        "shell.ceiling": ("room-shell", "ceiling", "passive"),
        "shell.walls": ("room-shell", "walls", "passive"),
    }
    for name, values in exact.items():
        tag(object_required(name), *values)

    for value in bpy.context.scene.objects:
        if value.type != "MESH" or value.hide_render or "vrataObjectId" in value:
            continue
        if value.name.startswith("opening.main-door.frame."):
            part = value.name.removeprefix("opening.main-door.").replace(".", "-")
            tag(value, "main-door", part, "deferred")
        elif value.name.startswith("opening.main-window.frame."):
            part = value.name.removeprefix("opening.main-window.").replace(".", "-")
            tag(value, "main-window", part, "passive")
        elif value.name.startswith("opening.main-window.reveal."):
            part = value.name.removeprefix("opening.main-window.").replace(".", "-")
            tag(value, "main-window", part, "passive")
        elif value.name == "opening.main-window.sill":
            tag(value, "main-window", "sill", "passive")
        elif value.name.startswith("profile."):
            part = value.name.removeprefix("profile.").replace(".", "-")
            tag(value, "baseboards", part, "passive")


def strip_pre_release_scene_extras():
    scene = bpy.context.scene
    for key in list(scene.keys()):
        if key.startswith("wmmr_"):
            del scene[key]
    scene["vrataSceneId"] = SCENE_ID
    scene["vrataAuthoringRelease"] = RELEASE_VERSION
    scene["vrataSourceSha256"] = EXPECTED_SOURCE_SHA256
    scene["vrataGeometryStatus"] = "review"
    scene["vrataInteractionSemantics"] = "passive,deferred,interactive"


def world_bounds(value):
    corners = [value.matrix_world @ Vector(corner) for corner in value.bound_box]
    return {
        "min_x": min(corner.x for corner in corners),
        "max_x": max(corner.x for corner in corners),
        "min_y": min(corner.y for corner in corners),
        "max_y": max(corner.y for corner in corners),
        "min_z": min(corner.z for corner in corners),
        "max_z": max(corner.z for corner in corners),
    }


def union_bounds(values):
    bounds = [world_bounds(value) for value in values]
    require(bounds, "empty_bounds")
    return {
        "min_x": min(value["min_x"] for value in bounds),
        "max_x": max(value["max_x"] for value in bounds),
        "min_y": min(value["min_y"] for value in bounds),
        "max_y": max(value["max_y"] for value in bounds),
        "min_z": min(value["min_z"] for value in bounds),
        "max_z": max(value["max_z"] for value in bounds),
    }


def bounds_separation(first, second):
    gaps = (
        max(0.0, first["min_x"] - second["max_x"], second["min_x"] - first["max_x"]),
        max(0.0, first["min_y"] - second["max_y"], second["min_y"] - first["max_y"]),
        max(0.0, first["min_z"] - second["max_z"], second["min_z"] - first["max_z"]),
    )
    return math.sqrt(sum(gap * gap for gap in gaps))


def assert_contacts_and_clearances():
    bpy.context.view_layer.update()
    floor = world_bounds(object_required("shell.floor"))
    rug = world_bounds(object_required("reality.area-rug"))
    table = world_bounds(object_required("component.conference-table.top"))
    close(floor["max_z"], 0.0, "floor_top")
    close(rug["min_z"], floor["max_z"], "rug_floor_contact")
    close(rug["max_z"], 0.016, "rug_top")
    close(table["max_z"], 0.74, "table_top_height")
    close(table["max_z"] - table["min_z"], 0.055, "tabletop_thickness")

    for side in ("west", "east"):
        base = world_bounds(object_required(f"component.conference-table.pedestal-{side}-base"))
        column = world_bounds(object_required(f"component.conference-table.pedestal-{side}-column"))
        close(base["min_z"], rug["max_z"], f"pedestal_{side}_rug_contact")
        close(column["min_z"], base["max_z"], f"pedestal_{side}_base_contact")
        close(column["max_z"], table["min_z"], f"pedestal_{side}_table_contact")

    cover = world_bounds(object_required("component.conference-table.cable-cover"))
    support = world_bounds(object_required("component.conference-table.cable-cover-support"))
    close(cover["max_z"], table["max_z"], "cable_cover_flush")
    close(support["max_z"], cover["min_z"], "cable_cover_support_contact")
    require(cover["min_x"] > -1.42 and cover["max_x"] < -0.88, "cable_cover_x_recess")
    require(cover["min_y"] > -0.06 and cover["max_y"] < 0.16, "cable_cover_y_recess")
    close(
        world_bounds(object_required("component.conference-speakerphone.body"))["min_z"],
        table["max_z"],
        "speakerphone_table_contact",
    )

    for chair_id, x, y, _ in CHAIRS:
        seat = object_required(f"component.{chair_id}.seat")
        seat_bounds = world_bounds(seat)
        close(seat.location.x, x, f"chair_center_x:{chair_id}")
        close(seat.location.y, y, f"chair_center_y:{chair_id}")
        close(seat_bounds["max_z"], 0.47, f"chair_seat_top:{chair_id}")
        base = object_required(f"component.{chair_id}.five-star-base")
        close(world_bounds(base)["min_z"], rug["max_z"], f"chair_base_rug_contact:{chair_id}")
        require(base["vrataStarCount"] == 5 and base["vrataCasterCount"] == 5, f"chair_star_contract:{chair_id}")
        arm_max = world_bounds(object_required(f"component.{chair_id}.arm-assembly"))["max_z"]
        require(arm_max <= table["min_z"] - 0.025 + EPSILON, f"chair_arm_table_clearance:{chair_id}")
        mechanism = world_bounds(object_required(f"component.{chair_id}.mechanism"))
        back_supports = world_bounds(object_required(f"component.{chair_id}.back-supports"))
        back = world_bounds(object_required(f"component.{chair_id}.back"))
        require(bounds_separation(back_supports, mechanism) <= 0.035 + EPSILON, f"chair_back_support_mechanism_contact:{chair_id}")
        require(bounds_separation(back, back_supports) <= 0.035 + EPSILON, f"chair_back_support_back_contact:{chair_id}")

    display_frame = world_bounds(object_required("media.debug-main.frame"))
    credenza = world_bounds(object_required("reality.av-credenza.carcass"))
    plinth = world_bounds(object_required("reality.av-credenza.floor-plinth"))
    close(plinth["min_z"], floor["max_z"], "credenza_floor_contact")
    close(credenza["min_z"], plinth["max_z"], "credenza_plinth_contact")
    require(credenza["max_z"] <= display_frame["min_z"] - 0.005 + EPSILON, "credenza_display_clearance")
    require(credenza["max_x"] < rug["min_x"] - 0.05, "credenza_rug_clearance")

    panel = world_bounds(object_required("opening.main-door.panel"))
    rosette = world_bounds(object_required("opening.main-door.hardware.rosette"))
    close(panel["min_z"], floor["max_z"], "door_floor_contact")
    close(rosette["min_y"], panel["max_y"], "rosette_door_contact")

    tray = world_bounds(object_required("reality.whiteboard.tray"))
    marker = world_bounds(object_required("reality.whiteboard.marker-body"))
    close(marker["min_z"], tray["max_z"], "marker_tray_contact")
    marker_material = object_required("reality.whiteboard.marker-body").data.materials[0]
    require(marker_material.get("vrataNonEmissive") is True, "marker_must_be_non_emissive")

    bead_left = world_bounds(object_required("opening.main-window.glazing-bead-left"))
    bead_right = world_bounds(object_required("opening.main-window.glazing-bead-right"))
    bead_bottom = world_bounds(object_required("opening.main-window.glazing-bead-bottom"))
    bead_top = world_bounds(object_required("opening.main-window.glazing-bead-top"))
    close(bead_left["min_x"], world_bounds(object_required("opening.main-window.frame.left"))["max_x"], "window_bead_left_frame_contact")
    close(bead_right["max_x"], world_bounds(object_required("opening.main-window.frame.right"))["min_x"], "window_bead_right_frame_contact")
    close(bead_bottom["min_z"], world_bounds(object_required("opening.main-window.frame.bottom"))["max_z"], "window_bead_bottom_frame_contact")
    close(bead_top["max_z"], world_bounds(object_required("opening.main-window.frame.head"))["min_z"], "window_bead_top_frame_contact")

    ceiling = world_bounds(object_required("shell.ceiling"))
    for side, housing_name in (
        ("west", "component.pendant-fixture.bar-negative-x"),
        ("east", "component.pendant-fixture.bar-positive-x"),
    ):
        canopy = world_bounds(object_required(f"component.pendant-fixture.canopy-{side}"))
        housing = world_bounds(object_required(housing_name))
        diffuser = world_bounds(object_required(f"component.pendant-fixture.diffuser-{side}"))
        close(canopy["max_z"], ceiling["min_z"], f"pendant_canopy_ceiling_contact:{side}")
        close(diffuser["max_z"], housing["min_z"], f"pendant_diffuser_contact:{side}")
        for cable_side in ("left", "right"):
            cable = world_bounds(object_required(f"component.pendant-fixture.cable-{side}-{cable_side}"))
            close(cable["min_z"], housing["max_z"], f"pendant_cable_housing_contact:{side}:{cable_side}")
            close(cable["max_z"], canopy["min_z"], f"pendant_cable_canopy_contact:{side}:{cable_side}")
            close(cable["max_x"] - cable["min_x"], 0.005, f"pendant_cable_diameter:{side}:{cable_side}", tolerance=5.0e-4)

    acoustic_parts = []
    for index in range(1, 4):
        panel_part = f"panel-{index:02d}"
        panel = object_required(f"reality.media-wall.acoustic-panel-{index:02d}")
        panel_bounds = world_bounds(panel)
        require(panel.data.materials[0].name == "material.reality.acoustic", f"acoustic_panel_material:{index}")
        require(panel_bounds["max_y"] < display_frame["min_y"] - 0.05, f"acoustic_display_clearance:{index}")
        close(panel_bounds["min_x"], -3.395, f"acoustic_mounting_face:{index}")
        mounting_parts = json.loads(panel["vrataMountingPartIds"])
        require(
            mounting_parts == [f"{panel_part}-mount-lower", f"{panel_part}-mount-upper"],
            f"acoustic_mount_contract:{index}",
        )
        acoustic_parts.append(panel)
        for level in ("lower", "upper"):
            cleat = object_required(f"reality.media-wall.acoustic-panel-{index:02d}-mount-{level}")
            cleat_bounds = world_bounds(cleat)
            close(cleat_bounds["min_x"], -3.41, f"acoustic_cleat_wall_contact:{index}:{level}")
            close(cleat_bounds["max_x"], panel_bounds["min_x"], f"acoustic_cleat_panel_contact:{index}:{level}")
            require(
                cleat_bounds["min_y"] > panel_bounds["min_y"]
                and cleat_bounds["max_y"] < panel_bounds["max_y"],
                f"acoustic_cleat_y_concealed:{index}:{level}",
            )
            require(
                cleat_bounds["min_z"] > panel_bounds["min_z"]
                and cleat_bounds["max_z"] < panel_bounds["max_z"],
                f"acoustic_cleat_z_concealed:{index}:{level}",
            )
            require(cleat["vrataSupportObjectId"] == "room-shell", f"acoustic_cleat_support_object:{index}:{level}")
            require(cleat["vrataSupportPartId"] == "walls", f"acoustic_cleat_support_part:{index}:{level}")
            require(
                cleat["vrataSupportedObjectId"] == "media-wall-acoustics"
                and cleat["vrataSupportedPartId"] == panel_part,
                f"acoustic_cleat_supported_panel:{index}:{level}",
            )
            acoustic_parts.append(cleat)
    require(len(acoustic_parts) == 9, "acoustic_mesh_count")

    plant_objects = [
        value
        for value in bpy.context.scene.objects
        if value.type == "MESH" and value.get("vrataObjectId") == "route-safe-plant"
    ]
    plant = union_bounds(plant_objects)
    pot = object_required("reality.route-safe-plant.pot")
    close(pot.location.x, -3.00, "plant_center_x")
    close(pot.location.y, 2.10, "plant_center_y")
    close(plant["min_z"], floor["max_z"], "plant_floor_contact")
    require(plant["min_x"] >= -3.21 - EPSILON and plant["max_x"] <= -2.79 + EPSILON, "plant_x_bounds")
    require(plant["min_y"] >= 1.89 - EPSILON and plant["max_y"] <= 2.29 + EPSILON, "plant_y_bounds")
    require(plant["max_z"] <= 1.56 + EPSILON, "plant_height_bound")
    require(plant["max_x"] <= -2.40 - 0.35 + EPSILON, "plant_seat_route_clearance")
    require(plant["min_y"] >= rug["max_y"] + 0.25 - EPSILON, "plant_rug_clearance")

def assert_names_tags_and_cleanup():
    require(OBSOLETE_COLLECTION not in bpy.data.collections, "obsolete_collection_survived")
    obsolete_names = {
        "component.conference-table.leg-negative-x",
        "component.conference-table.leg-positive-x",
        "component.conference-av.body",
        "camera.review.entry",
        "reality.media-wall.acoustic-panels",
        "reality.media-wall.acoustic-cleats",
    }
    require(not obsolete_names.intersection(bpy.data.objects.keys()), "obsolete_nodes_survived")
    require(not any(value.name.startswith(("review.", "light.review.")) for value in bpy.data.objects), "obsolete_art_pass_nodes_survived")
    require(not any(value.name.startswith("__tmp.") for value in bpy.data.objects), "temporary_object_survived")
    require(not any(value.name.startswith("mesh.__tmp.") for value in bpy.data.meshes), "temporary_mesh_survived")
    require(not any(re.search(r"\d+\.\d+", value.name) for value in bpy.data.objects), "float_derived_object_name")
    require(not any(re.search(r"\.\d{3}$", value.name) for value in bpy.data.objects), "automatic_object_suffix")
    require(not any(key.startswith("wmmr_") for key in bpy.context.scene.keys()), "pre_release_scene_extra_survived")

    visible_meshes = sorted(
        (value for value in bpy.context.scene.objects if value.type == "MESH" and not value.hide_render),
        key=lambda value: value.name,
    )
    require(visible_meshes, "no_visible_meshes")
    pairs = []
    statuses = Counter()
    object_statuses = {}
    identifier_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
    for value in visible_meshes:
        for key in ("vrataObjectId", "vrataPartId", "vrataInteractionStatus", "vrataBakePolicy"):
            require(key in value, f"missing_tag:{value.name}:{key}")
        object_id = value["vrataObjectId"]
        part_id = value["vrataPartId"]
        status = value["vrataInteractionStatus"]
        bake_policy = value["vrataBakePolicy"]
        require(identifier_pattern.fullmatch(object_id) is not None, f"unstable_object_id:{value.name}")
        require(identifier_pattern.fullmatch(part_id) is not None, f"unstable_part_id:{value.name}")
        require(status in INTERACTION_STATUSES, f"invalid_tag_status:{value.name}")
        existing_status = object_statuses.setdefault(object_id, status)
        require(existing_status == status, f"mixed_object_status:{object_id}")
        require(
            bake_policy in {"include", "exclude-transparent", "exclude-unlit-background"},
            f"invalid_bake_policy:{value.name}",
        )
        if bake_policy == "exclude-transparent":
            require(value.get("vrataBakeExclusionReason") == "transparent-glass", f"missing_bake_exclusion_reason:{value.name}")
        elif bake_policy == "exclude-unlit-background":
            require(value.get("vrataBakeExclusionReason") == "unlit-panorama", f"missing_panorama_bake_exclusion_reason:{value.name}")
        pairs.append((object_id, part_id))
        statuses[status] += 1
    require(len(pairs) == len(set(pairs)), "duplicate_object_part_tag")
    require(set(statuses) == INTERACTION_STATUSES, "interaction_semantics_incomplete")
    bake_exclusions = {value.name for value in visible_meshes if value["vrataBakePolicy"] != "include"}
    require(bake_exclusions == {"exterior.coastal-panorama"}, "bake_exclusion_contract")

    expected_names = {
        "component.conference-table.top",
        "component.conference-table.cable-cover",
        "component.conference-speakerphone.body",
        "reality.area-rug",
        "reality.av-credenza.carcass",
        "reality.route-safe-plant.pot",
        "opening.main-door.hardware.lever",
        "exterior.coastal-panorama",
    }
    expected_names.update(f"reality.media-wall.acoustic-panel-{index:02d}" for index in range(1, 4))
    expected_names.update(
        f"reality.media-wall.acoustic-panel-{index:02d}-mount-{level}"
        for index in range(1, 4)
        for level in ("lower", "upper")
    )
    expected_names.update(
        f"component.{chair_id}.{part}"
        for chair_id, _, _, _ in CHAIRS
        for part in (
            "seat",
            "back",
            "mechanism",
            "gas-column",
            "five-star-base",
            "back-supports",
            "arm-assembly",
        )
    )
    require(expected_names.issubset(bpy.data.objects.keys()), "reality_object_names_incomplete")
    return visible_meshes, statuses


def create_review_lights(collection):
    specs = (
        ("reality.review.light.window-fill", (0.0, 2.15, 2.30), (-0.45, 0.05, 0.95), 420.0, 2.7, "#DDEBFF"),
        ("reality.review.light.ceiling-soft", (-0.45, 0.05, 2.86), (-0.45, 0.05, 0.55), 310.0, 3.0, "#FFE6C8"),
        ("reality.review.light.display-soft", (-2.70, 0.15, 2.30), (-1.10, 0.15, 1.05), 130.0, 1.4, "#DDE7ED"),
        ("reality.review.light.entry-fill", (2.60, -1.75, 2.45), (0.30, 0.00, 1.00), 160.0, 1.8, "#FFE3C2"),
    )
    for name, location, target, energy, size, tint in specs:
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color(tint)[:3]
        value = bpy.data.objects.new(name, data)
        value.location = location
        value.rotation_mode = "QUATERNION"
        value.rotation_quaternion = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y")
        collection.objects.link(value)


def create_review_cameras(collection):
    cameras = {}
    for view_id, location, target, fov_degrees in REVIEW_VIEWS:
        name = f"camera.reality.{view_id}"
        data = bpy.data.cameras.new(name)
        data.sensor_fit = "VERTICAL"
        data.angle_y = math.radians(fov_degrees)
        value = bpy.data.objects.new(name, data)
        value.location = location
        value.rotation_mode = "QUATERNION"
        value.rotation_quaternion = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y")
        value["vrataReviewViewId"] = view_id
        collection.objects.link(value)
        cameras[view_id] = value
    bpy.context.scene.camera = cameras["entry"]
    return cameras


def configure_review_scene(smoke):
    scene = bpy.context.scene
    samples = 4 if smoke else 24
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_samples = samples
    scene.eevee.taa_render_samples = samples
    scene.eevee.use_raytracing = False
    scene.eevee.shadow_ray_count = 1 if smoke else 2
    scene.eevee.shadow_step_count = 1 if smoke else 4
    scene.eevee.volumetric_samples = 1 if smoke else 4
    scene.render.resolution_x = 640 if smoke else 960
    scene.render.resolution_y = 360 if smoke else 540
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 30
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.view_settings.look = "AgX - Medium Low Contrast"
    scene.view_settings.exposure = 0.25
    scene.view_settings.gamma = 1.0
    scene["vrataReviewProfile"] = "smoke" if smoke else "acceptance"
    scene["vrataReviewResolution"] = f"{scene.render.resolution_x}x{scene.render.resolution_y}"
    scene["vrataReviewSamples"] = samples
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = color("#6E8490")
    background.inputs["Strength"].default_value = 0.18


def render_reviews(review_dir, cameras, selected_views=None):
    scene = bpy.context.scene
    paths = []
    for view_id, _, _, _ in REVIEW_VIEWS:
        if selected_views is not None and view_id not in selected_views:
            continue
        path = review_dir / f"{view_id}.png"
        scene.camera = cameras[view_id]
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        require(path.is_file() and path.stat().st_size > 0, f"review_render_missing:{view_id}")
        paths.append(path)
    scene.camera = cameras["entry"]
    return paths


def main():
    args = arguments()
    output_blend = Path(args.output_blend).expanduser().resolve()
    review_dir = Path(args.review_dir).expanduser().resolve()
    input_blend = SOURCE_BLEND.resolve()
    require(input_blend.is_file(), "accepted_source_missing")
    require(output_blend != input_blend, "immutable_input_overwrite_forbidden")
    require(output_blend.suffix.lower() == ".blend", "output_must_be_blend")
    source_sha = sha256(input_blend)
    require(source_sha == EXPECTED_SOURCE_SHA256, f"accepted_source_sha256_changed:{source_sha}")

    bpy.ops.wm.open_mainfile(filepath=str(input_blend))
    assert_baseline()
    remove_obsolete_art_pass()
    reality_collection = ensure_collection(REALITY_COLLECTION)
    review_collection = ensure_collection(REVIEW_COLLECTION)
    materials = build_materials()

    build_media_surfaces(reality_collection, materials)
    build_rug(reality_collection, materials)
    build_table(reality_collection, materials)
    build_chairs(reality_collection, materials)
    build_speakerphone(reality_collection, materials)
    build_credenza(reality_collection, materials)
    build_plant(reality_collection, materials)
    build_acoustics(reality_collection, materials)
    build_door(reality_collection, materials)
    build_whiteboard_tray(reality_collection, materials)
    build_window(reality_collection, materials)
    build_pendant(reality_collection, materials)
    build_coastal_panorama(reality_collection)
    tag_accepted_meshes()
    strip_pre_release_scene_extras()

    configure_review_scene(args.smoke)
    create_review_lights(review_collection)
    cameras = create_review_cameras(review_collection)
    assert_contacts_and_clearances()
    visible_meshes, statuses = assert_names_tags_and_cleanup()

    output_blend.parent.mkdir(parents=True, exist_ok=True)
    if not args.skip_reviews:
        review_dir.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    sanitize_saved_ui_state()
    bpy.ops.wm.save_as_mainfile(filepath=str(output_blend))
    require(output_blend.is_file() and output_blend.stat().st_size > 0, "output_blend_missing")
    review_paths = [] if args.skip_reviews else render_reviews(review_dir, cameras, set(args.review_view) if args.review_view else None)
    require(sha256(input_blend) == EXPECTED_SOURCE_SHA256, "immutable_input_changed_during_run")

    print(
        "VRATA_REALITY_PASS="
        + json.dumps(
            {
                "blenderVersion": ".".join(str(value) for value in bpy.app.version[:3]),
                "outputBlend": str(output_blend),
                "releaseVersion": RELEASE_VERSION,
                "reviewCount": len(review_paths),
                "reviewProfile": bpy.context.scene["vrataReviewProfile"],
                "reviewResolution": bpy.context.scene["vrataReviewResolution"],
                "reviewSamples": bpy.context.scene["vrataReviewSamples"],
                "reviewViews": [path.stem for path in review_paths],
                "sourceSha256": source_sha,
                "taggedVisibleMeshes": len(visible_meshes),
                "interactionStatuses": dict(sorted(statuses.items())),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
