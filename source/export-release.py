import argparse
import json
from pathlib import Path
import sys

import bpy
import numpy as np


LIGHTMAP_UV = "VRATA_LIGHTMAP_UV"
LIGHTMAP_NODE = "VRATA_LIGHTMAP_BAKE"
LIGHTMAP_UV_NODE = f"{LIGHTMAP_NODE}_UV"
LIGHTMAP_INTENSITIES = {
    "material.warm-oak": 6.0,
    "material.review-floor-oak": 5.0,
    "material.review-display": 5.0,
}


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--lightmap",
        default=str(Path(__file__).with_name("accepted-lightmap.png")),
    )
    parser.add_argument("--bake", action="store_true")
    parser.add_argument("--size", type=int, default=2048)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--scale", type=float, default=0.25)
    parser.add_argument("--device", choices=("CPU", "CUDA"), default="CPU")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def visible_meshes():
    return sorted(
        (
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "MESH" and not obj.hide_render
        ),
        key=lambda obj: obj.name,
    )


def unwrap_lightmap(objects):
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        layer = obj.data.uv_layers.get(LIGHTMAP_UV)
        if layer is not None:
            obj.data.uv_layers.remove(layer)
        obj.data.uv_layers.new(name=LIGHTMAP_UV)
        obj.data.uv_layers.active = obj.data.uv_layers[LIGHTMAP_UV]
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=1.15192,
        margin_method="SCALED",
        rotate_method="AXIS_ALIGNED_Y",
        island_margin=0.006,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=True,
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def principled_node(material):
    if not material.use_nodes or material.node_tree is None:
        return None
    return next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )


def prepare_materials(objects, image):
    materials = sorted(
        {
            material
            for obj in objects
            for material in obj.data.materials
            if material is not None
        },
        key=lambda material: material.name,
    )
    for material in materials:
        material.use_nodes = True
        nodes = material.node_tree.nodes
        for node_name in (LIGHTMAP_NODE, LIGHTMAP_UV_NODE):
            old = nodes.get(node_name)
            if old is not None:
                nodes.remove(old)
        texture = nodes.new("ShaderNodeTexImage")
        texture.name = LIGHTMAP_NODE
        texture.label = "Vrata baked irradiance"
        texture.image = image
        texture.interpolation = "Linear"
        texture.extension = "EXTEND"
        uv = nodes.new("ShaderNodeUVMap")
        uv.name = LIGHTMAP_UV_NODE
        uv.uv_map = LIGHTMAP_UV
        material.node_tree.links.new(uv.outputs["UV"], texture.inputs["Vector"])
        for node in nodes:
            node.select = False
        texture.select = True
        nodes.active = texture
    return materials


def bake_irradiance(scene, objects, image, samples, device):
    scene.render.engine = "CYCLES"
    if device == "CUDA":
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = "CUDA"
        preferences.get_devices()
        for cycle_device in preferences.devices:
            cycle_device.use = cycle_device.type == "CUDA"
        scene.cycles.device = "GPU"
    scene.cycles.samples = samples
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 1
    scene.cycles.transmission_bounces = 1
    scene.cycles.use_denoising = True
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_color = False
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(
        type="DIFFUSE",
        pass_filter={"DIRECT", "INDIRECT"},
        margin=8,
        use_clear=True,
    )
    image.update()


def scale_image(image, factor):
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    rgba = pixels.reshape((-1, 4))
    rgb = rgba[:, :3]
    maximum = float(np.max(rgb))
    mean = float(np.mean(np.maximum(rgb, 0.0)))
    np.clip(rgb * factor, 0.0, 1.0, out=rgb)
    rgba[:, 3] = 1.0
    image.pixels.foreach_set(pixels)
    image.update()
    return {"linearMaxBeforeScale": maximum, "linearMeanBeforeScale": mean}


def wire_lightmaps(materials, image, default_intensity):
    for material in materials:
        shader = principled_node(material)
        if shader is None:
            continue
        emission_color = shader.inputs.get("Emission Color")
        emission_strength = shader.inputs.get("Emission Strength")
        original_color = (
            list(emission_color.default_value[:3])
            if emission_color
            else [0.0, 0.0, 0.0]
        )
        original_intensity = (
            float(emission_strength.default_value) if emission_strength else 1.0
        )
        texture = material.node_tree.nodes.get(LIGHTMAP_NODE)
        if emission_color and texture:
            material.node_tree.links.new(texture.outputs["Color"], emission_color)
        if emission_strength:
            emission_strength.default_value = 1.0
        material["vrataLightMap"] = True
        material["vrataLightMapIntensity"] = LIGHTMAP_INTENSITIES.get(
            material.name,
            default_intensity,
        )
        material["vrataOriginalEmissive"] = original_color
        material["vrataOriginalEmissiveIntensity"] = original_intensity
    image.pack()


def tune_unbaked_materials(export_objects):
    glass = next(
        (
            material
            for obj in export_objects
            for material in obj.data.materials
            if material is not None and material.name == "material.review-window-glass"
        ),
        None,
    )
    if glass is None:
        return
    shader = principled_node(glass)
    if shader:
        shader.inputs["Roughness"].default_value = 0.45
        shader.inputs["Alpha"].default_value = 0.18
    glass.diffuse_color[3] = 0.18
    if hasattr(glass, "surface_render_method"):
        glass.surface_render_method = "DITHERED"


def export_glb(path, objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_extras=True,
        export_animations=False,
    )


def main():
    args = arguments()
    output = Path(args.output).resolve()
    lightmap_path = Path(args.lightmap).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    lightmap_path.parent.mkdir(parents=True, exist_ok=True)
    export_objects = visible_meshes()
    baked_objects = [
        obj for obj in export_objects if obj.name != "review.window.glass"
    ]
    if not baked_objects or not export_objects:
        raise RuntimeError("no_visible_meshes")
    unwrap_lightmap(baked_objects)
    if args.bake:
        image = bpy.data.images.new(
            "vrata.lightmap.atlas",
            width=args.size,
            height=args.size,
            alpha=False,
            float_buffer=True,
        )
    else:
        if not lightmap_path.is_file():
            raise RuntimeError(f"accepted_lightmap_missing:{lightmap_path.name}")
        image = bpy.data.images.load(str(lightmap_path))
    image.colorspace_settings.name = "sRGB"
    materials = prepare_materials(baked_objects, image)
    if args.bake:
        bake_irradiance(bpy.context.scene, baked_objects, image, args.samples, args.device)
        stats = scale_image(image, args.scale)
        image.filepath_raw = str(lightmap_path)
        image.file_format = "PNG"
        image.save()
    else:
        stats = {"linearMaxBeforeScale": None, "linearMeanBeforeScale": None}
    wire_lightmaps(materials, image, 1.0 / args.scale)
    tune_unbaked_materials(export_objects)
    export_glb(output, export_objects)
    print(
        json.dumps(
            {
                "output": str(output),
                "lightmap": str(lightmap_path),
                "baked": args.bake,
                "size": args.size,
                "samples": args.samples,
                "scale": args.scale,
                "device": args.device,
                "objectCount": len(export_objects),
                "bakedObjectCount": len(baked_objects),
                "materialCount": len(materials),
                **stats,
            },
            sort_keys=True,
        )
    )


main()
