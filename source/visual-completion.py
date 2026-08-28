import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def arguments():
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene-spec", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args(values)


def srgb_channel(value):
    value /= 255.0
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def color(value):
    return tuple(srgb_channel(int(value[index:index + 2], 16)) for index in (1, 3, 5)) + (1.0,)


def adjusted(value, factor):
    return tuple(max(0.0, min(1.0, channel * factor)) for channel in value[:3]) + (1.0,)


def principled(material):
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return nodes, shader


def texture_image(name, base, texture):
    size = 256 if texture == "wood" else 128
    image = bpy.data.images.new(f"texture.{name}", width=size, height=size, alpha=False, float_buffer=False)
    seed = sum((index + 1) * value for index, value in enumerate(name.encode("utf-8")))
    pixels = []
    for y in range(size):
        for x in range(size):
            noise = ((x * 73856093) ^ (y * 19349663) ^ seed) & 255
            noise = noise / 255.0 - 0.5
            if texture == "wood":
                grain = math.sin(y * 0.31 + math.sin(x * 0.055) * 2.2)
                detail = math.sin(y * 1.63 + x * 0.035)
                factor = 0.92 + grain * 0.075 + detail * 0.018 + noise * 0.025
            elif texture == "fabric":
                weave = (0.018 if x % 3 == 0 else 0.0) + (0.018 if y % 3 == 0 else 0.0)
                factor = 0.96 + weave + noise * 0.025
            elif texture == "plaster":
                cloud = math.sin(x * 0.075) * math.sin(y * 0.061)
                factor = 0.985 + cloud * 0.018 + noise * 0.014
            else:
                factor = 0.98 + noise * 0.035
            pixels.extend((*adjusted(base, factor)[:3], 1.0))
    image.pixels.foreach_set(pixels)
    image.update()
    image.pack()
    return image


def procedural_material(material, base_hex, roughness, metallic=0.0, texture="noise"):
    base = color(base_hex)
    nodes, shader = principled(material)
    shader.inputs["Base Color"].default_value = base
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    material.diffuse_color = base
    material["review_base_color"] = list(base)
    material["review_roughness"] = roughness
    material["review_metallic"] = metallic
    texture_node = nodes.new("ShaderNodeTexImage")
    texture_node.image = texture_image(material.name, base, texture)
    texture_node.interpolation = "Linear"
    texture_node.extension = "REPEAT"
    material.node_tree.links.new(texture_node.outputs["Color"], shader.inputs["Base Color"])


def flat_material(
    name,
    base_hex,
    roughness,
    metallic=0.0,
    emission_hex=None,
    emission_strength=0.0,
    alpha=1.0,
    transmission=0.0,
):
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    base = (*color(base_hex)[:3], alpha)
    _, shader = principled(material)
    shader.inputs["Base Color"].default_value = base
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Alpha"].default_value = alpha
    if "Transmission Weight" in shader.inputs:
        shader.inputs["Transmission Weight"].default_value = transmission
    if "IOR" in shader.inputs:
        shader.inputs["IOR"].default_value = 1.45
    material.diffuse_color = base
    material["review_base_color"] = list(base)
    material["review_roughness"] = roughness
    material["review_metallic"] = metallic
    if alpha < 1.0:
        try:
            material.surface_render_method = "BLENDED"
        except (AttributeError, TypeError, ValueError):
            pass
    if emission_hex:
        emission = color(emission_hex)
        shader.inputs["Emission Color"].default_value = emission
        shader.inputs["Emission Strength"].default_value = emission_strength
        material["review_emission_color"] = list(emission)
        material["review_emission_strength"] = emission_strength
    return material


def assign(value, material):
    value.data.materials.clear()
    value.data.materials.append(material)


def rounded_box(name, location, dimensions, material, bevel=0.02, collection=None):
    bpy.ops.mesh.primitive_cube_add(location=location)
    value = bpy.context.object
    value.name = name
    value.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = value.modifiers.new("review-bevel", "BEVEL")
    modifier.width = min(bevel, min(dimensions) * 0.4)
    modifier.segments = 3
    modifier.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = value
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    assign(value, material)
    if collection and value.name not in collection.objects:
        for owner in list(value.users_collection):
            owner.objects.unlink(value)
        collection.objects.link(value)
    return value


def cylinder(name, location, radius, depth, material, collection, vertices=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    value = bpy.context.object
    value.name = name
    assign(value, material)
    for owner in list(value.users_collection):
        owner.objects.unlink(value)
    collection.objects.link(value)
    return value


def sphere(name, location, scale, material, collection):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.0, location=location)
    value = bpy.context.object
    value.name = name
    value.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(value, material)
    for owner in list(value.users_collection):
        owner.objects.unlink(value)
    collection.objects.link(value)
    return value


def upgrade_existing_materials():
    recipes = {
        "material.warm-oak": ("#7B5A40", 0.5, 0.0, "wood"),
        "material.mineral-plaster": ("#DDD9D0", 0.82, 0.0, "plaster"),
        "material.graphite-metal": ("#252B2D", 0.3, 0.78, "noise"),
        "material.sand-fabric": ("#BDA98D", 0.84, 0.0, "fabric"),
        "material.muted-grey-green-fabric": ("#6F8178", 0.86, 0.0, "fabric"),
        "material.ground-mineral": ("#9A9B96", 0.9, 0.0, "noise"),
        "material.exterior-graphite": ("#4D5559", 0.65, 0.18, "noise"),
        "material.exterior-vegetation": ("#466A50", 0.9, 0.0, "noise"),
    }
    for name, values in recipes.items():
        material = bpy.data.materials.get(name)
        if material:
            procedural_material(material, *values)

    floor = bpy.data.objects.get("shell.floor")
    floor_material = bpy.data.materials.get("material.review-floor-oak") or bpy.data.materials.new("material.review-floor-oak")
    procedural_material(floor_material, "#6B5748", 0.64, 0.0, "wood")
    if floor:
        assign(floor, floor_material)


def improve_chairs(collection, frame_material):
    for index in range(1, 9):
        prefix = f"component.chair-{index:02d}"
        seat = bpy.data.objects.get(f"{prefix}.seat")
        back = bpy.data.objects.get(f"{prefix}.back")
        if not seat or not back:
            continue
        for suffix in ("leg-negative-x", "leg-positive-x"):
            original = bpy.data.objects.get(f"{prefix}.{suffix}")
            if original:
                bpy.data.objects.remove(original, do_unlink=True)
        back_delta = back.location.y - seat.location.y
        back.rotation_euler.x = -math.copysign(math.radians(7.0), back_delta)
        for side in (-1, 1):
            for depth_sign in (-1, 1):
                cylinder(
                    f"review.{prefix}.leg.{side}.{depth_sign}",
                    (seat.location.x + side * 0.22, seat.location.y + depth_sign * 0.18, 0.215),
                    0.027,
                    0.43,
                    frame_material,
                    collection,
                    vertices=12,
                )
        rounded_box(
            f"review.{prefix}.underframe",
            (seat.location.x, seat.location.y, 0.405),
            (0.48, 0.42, 0.035),
            frame_material,
            bevel=0.012,
            collection=collection,
        )
        for side in (-1, 1):
            arm_x = seat.location.x + side * 0.275
            cylinder(
                f"review.{prefix}.arm-support.{side}",
                (arm_x, seat.location.y, 0.58),
                0.018,
                0.2,
                frame_material,
                collection,
                vertices=12,
            )
            rounded_box(
                f"review.{prefix}.arm-pad.{side}",
                (arm_x, seat.location.y, 0.685),
                (0.055, 0.32, 0.045),
                frame_material,
                bevel=0.014,
                collection=collection,
            )


def add_room_details(collection):
    graphite = bpy.data.materials["material.graphite-metal"]
    oak = bpy.data.materials["material.warm-oak"]
    plaster = bpy.data.materials["material.mineral-plaster"]
    vegetation = bpy.data.materials["material.exterior-vegetation"]
    rug = flat_material("material.review-rug", "#727A74", 0.94)
    warm_emission = flat_material("material.review-warm-emission", "#F1D3A2", 0.42, emission_hex="#FFD49A", emission_strength=2.2)
    glass = flat_material("material.review-window-glass", "#B8D5DD", 0.95, alpha=0.035)
    display = flat_material("material.review-display", "#12262E", 0.28, emission_hex="#183C49", emission_strength=0.22)
    whiteboard = flat_material("material.review-whiteboard", "#E7E2D8", 0.38)
    planter = flat_material("material.review-planter", "#5B4636", 0.72)
    acoustic = flat_material("material.review-acoustic", "#879088", 0.9)

    rounded_box("review.rug", (-0.45, 0.05, 0.008), (4.65, 2.0, 0.016), rug, bevel=0.03, collection=collection)
    rounded_box("review.table.cable-trough", (-0.45, 0.05, 0.755), (0.92, 0.16, 0.025), graphite, bevel=0.012, collection=collection)
    rounded_box("review.window.glass", (-0.2, 2.475, 1.6), (3.12, 0.012, 1.62), glass, bevel=0.003, collection=collection)

    rounded_box("media.debug-main.frame", (-3.365, 0.15, 1.55), (0.05, 3.38, 1.98), graphite, bevel=0.035, collection=collection)
    rounded_box("media.debug-main.backing", (-3.33, 0.15, 1.55), (0.025, 3.16, 1.76), display, bevel=0.018, collection=collection)
    rounded_box("review.media-console", (-3.12, 0.15, 0.34), (0.42, 2.35, 0.55), oak, bevel=0.035, collection=collection)
    rounded_box("review.media-console.shadow-gap", (-2.9, 0.15, 0.35), (0.025, 2.1, 0.38), graphite, bevel=0.01, collection=collection)

    rounded_box("media.whiteboard-wall.frame", (3.365, 0.5, 1.5), (0.05, 2.56, 1.41), graphite, bevel=0.025, collection=collection)
    rounded_box("media.whiteboard-wall.backing", (3.33, 0.5, 1.5), (0.025, 2.36, 1.21), whiteboard, bevel=0.012, collection=collection)
    rounded_box("review.whiteboard.tray", (3.29, 0.5, 0.85), (0.08, 0.72, 0.045), graphite, bevel=0.012, collection=collection)
    rounded_box("review.whiteboard.marker", (3.24, 0.5, 0.89), (0.035, 0.28, 0.028), warm_emission, bevel=0.008, collection=collection)

    for x in (-1.1, 0.2):
        rounded_box(f"review.pendant.diffuser.{x}", (x, 0.05, 2.575), (0.72, 0.1, 0.025), warm_emission, bevel=0.01, collection=collection)
        for cable_x in (x - 0.25, x + 0.25):
            cylinder(f"review.pendant.cable.{cable_x}", (cable_x, 0.05, 2.86), 0.006, 0.52, graphite, collection, vertices=10)

    rounded_box("review.av.inlay", (-0.45, 0.05, 0.875), (0.26, 0.15, 0.01), warm_emission, bevel=0.004, collection=collection)
    rounded_box("review.door.panel", (2.25, -2.49, 1.06), (0.92, 0.05, 2.08), oak, bevel=0.025, collection=collection)
    cylinder("review.door.handle", (1.92, -2.445, 1.05), 0.028, 0.18, graphite, collection, vertices=16)

    cylinder("review.plant.pot", (2.78, 1.93, 0.28), 0.24, 0.48, planter, collection, vertices=24)
    cylinder("review.plant.stem", (2.78, 1.93, 0.72), 0.035, 0.7, vegetation, collection, vertices=12)
    for index, values in enumerate((
        ((2.61, 1.93, 0.85), (0.12, 0.28, 0.16)),
        ((2.91, 1.93, 0.98), (0.13, 0.3, 0.18)),
        ((2.72, 1.82, 1.18), (0.14, 0.25, 0.19)),
        ((2.84, 2.03, 1.33), (0.12, 0.24, 0.17)),
    )):
        sphere(f"review.plant.leaf.{index}", values[0], values[1], vegetation, collection)

    for index, y in enumerate((-1.62, -1.32, -1.02)):
        rounded_box(f"review.acoustic-panel.{index}", (-2.92, y, 1.55), (0.08, 0.22, 1.35), acoustic, bevel=0.025, collection=collection)

    frame = graphite
    improve_chairs(collection, frame)


def improve_lighting():
    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = color("#6E8490")
    background.inputs["Strength"].default_value = 0.18

    daylight = bpy.data.lights.get("light.window-daylight")
    ceiling = bpy.data.lights.get("light.ceiling-fill")
    pendant = bpy.data.lights.get("light.table-pendant")
    if daylight:
        daylight.energy = 1.15
        daylight.color = color("#DCEBFF")[:3]
        daylight.angle = math.radians(22)
    if ceiling:
        ceiling.energy = 58
        ceiling.color = color("#FFE3C2")[:3]
        ceiling.spot_size = math.radians(105)
        ceiling.spot_blend = 0.78
    if pendant:
        pendant.energy = 82
        pendant.color = color("#FFD09A")[:3]
        pendant.spot_size = math.radians(95)
        pendant.spot_blend = 0.82

    collection = bpy.data.collections.get("WMMR_REVIEW_ART_PASS")
    for name, location, target, energy, size, tint in (
        ("light.review.window-fill", (0.0, 2.15, 2.3), (-0.45, 0.0, 0.9), 420, 2.7, "#DDEBFF"),
        ("light.review.ceiling-soft", (-0.45, 0.0, 2.82), (-0.45, 0.0, 0.55), 310, 3.2, "#FFE6C8"),
        ("light.review.display-soft", (-2.75, 0.15, 2.3), (-1.2, 0.15, 1.0), 130, 1.5, "#DDE7ED"),
    ):
        light_data = bpy.data.lights.new(name, type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light_data.color = color(tint)[:3]
        light_object = bpy.data.objects.new(name, light_data)
        light_object.location = location
        light_object.rotation_mode = "QUATERNION"
        light_object.rotation_quaternion = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y")
        collection.objects.link(light_object)


def camera_target(camera, location, target, fov_degrees):
    camera.location = location
    direction = Vector(target) - Vector(location)
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = direction.to_track_quat("-Z", "Y")
    camera.data.sensor_fit = "VERTICAL"
    camera.data.angle_y = math.radians(fov_degrees)


def render_views(scene_spec, output_dir):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    if hasattr(scene, "eevee"):
        if hasattr(scene.eevee, "taa_render_samples"):
            scene.eevee.taa_render_samples = 24
        if hasattr(scene.eevee, "taa_samples"):
            scene.eevee.taa_samples = 24
    scene.render.resolution_x = 960
    scene.render.resolution_y = 540
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.render.image_settings.compression = 30
    scene.view_settings.look = "AgX - Medium Low Contrast"
    scene.view_settings.exposure = 0.25
    scene.view_settings.gamma = 1.0
    camera = bpy.data.objects.get("camera.review.entry")
    scene.camera = camera
    for review in scene_spec["reviewViews"]:
        position = review["position"]
        target = review["target"]
        camera_target(
            camera,
            (position["x"], position["z"], position["y"]),
            (target["x"], target["z"], target["y"]),
            review["fovDegrees"],
        )
        scene.render.filepath = str(output_dir / f"{review['id']}.png")
        bpy.ops.render.render(write_still=True)


def export_glb(output_dir):
    camera = bpy.data.objects.get("camera.review.entry")
    if camera:
        camera.hide_render = True
        camera.hide_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(output_dir / "scene.glb"),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        use_visible=True,
    )


def main():
    args = arguments()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    scene_spec = json.loads(Path(args.scene_spec).read_text(encoding="utf-8"))
    collection = bpy.data.collections.get("WMMR_REVIEW_ART_PASS") or bpy.data.collections.new("WMMR_REVIEW_ART_PASS")
    if collection.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(collection)
    upgrade_existing_materials()
    add_room_details(collection)
    improve_lighting()
    bpy.ops.wm.save_as_mainfile(filepath=str(output_dir / "review-art-pass.blend"))
    render_views(scene_spec, output_dir)
    export_glb(output_dir)


main()
