import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

import bpy
import numpy as np


SCENE_ID = "warm-modern-meeting-room-candidate-01"
RELEASE_VERSION = "0.3.2"
EXPECTED_SOURCE_SHA256 = "fbddeac0c0fc8e65f3beb736917574f9515116fdb4ef42e4a9cdaa7d10f12b16"
EXPECTED_BLENDER_VERSION = (4, 5, 12)
EXPECTED_BLENDER_BUILD_HASH = "84afd5f785f7"
EXPECTED_BLENDER_BINARY_SHA256 = "33ac108ebce3c271f5357e5c664d0488717263bcf2145c80300edd0b12c31880"
SCRIPT_DIR = Path(__file__).resolve().parent
SOURCE_DIR = SCRIPT_DIR.parents[1]
LIGHTMAP_UV = "VRATA_LIGHTMAP_UV"
LIGHTMAP_NODE = "VRATA_LIGHTMAP_BAKE"
LIGHTMAP_UV_NODE = f"{LIGHTMAP_NODE}_UV"
REQUIRED_TAGS = ("vrataObjectId", "vrataPartId", "vrataInteractionStatus", "vrataBakePolicy")
INTERACTION_STATUSES = {"passive", "deferred", "interactive"}
LIGHTMAP_INTENSITIES = {
    "material.warm-oak": 6.0,
    "material.review-floor-oak": 5.0,
    "material.review-display": 5.0,
    "material.reality.display": 5.0,
}


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--lightmap", required=True)
    parser.add_argument("--bake", action="store_true")
    parser.add_argument("--size", type=int, default=2048)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--scale", type=float, default=0.25)
    parser.add_argument("--device", choices=("CUDA",), default="CUDA")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decoded_build_hash():
    value = bpy.app.build_hash
    return value.decode("ascii") if isinstance(value, bytes) else str(value)


def is_within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def assert_safe_paths(output, lightmap_path, bake):
    current_blend = Path(bpy.data.filepath).resolve() if bpy.data.filepath else None
    require(current_blend is not None, "saved_0_3_2_blend_required")
    require(output.suffix.lower() == ".glb", "output_must_be_glb")
    require(lightmap_path.suffix.lower() == ".png", "lightmap_must_be_png")
    require(output != lightmap_path, "output_lightmap_path_collision")
    require(output != current_blend and lightmap_path != current_blend, "current_blend_overwrite_forbidden")
    require(
        not is_within(output, SOURCE_DIR) or is_within(output, SCRIPT_DIR),
        f"historical_source_overwrite_forbidden:output:{output.name}",
    )
    require(output != SOURCE_DIR / "accepted-scene.blend", "accepted_scene_overwrite_forbidden")
    if bake:
        require(
            not is_within(lightmap_path, SOURCE_DIR) or is_within(lightmap_path, SCRIPT_DIR),
            f"historical_source_overwrite_forbidden:lightmap:{lightmap_path.name}",
        )
        require(lightmap_path != SOURCE_DIR / "accepted-lightmap.png", "accepted_lightmap_overwrite_forbidden")


def assert_toolchain(bake):
    require(tuple(bpy.app.version[:3]) == EXPECTED_BLENDER_VERSION, "blender_version_mismatch")
    require(decoded_build_hash() == EXPECTED_BLENDER_BUILD_HASH, "blender_build_hash_mismatch")
    if not bake:
        return []
    binary = Path(bpy.app.binary_path).resolve()
    require(binary.is_file(), "blender_binary_missing")
    require(sha256(binary) == EXPECTED_BLENDER_BINARY_SHA256, "blender_binary_sha256_mismatch")
    cycles_addon = bpy.context.preferences.addons.get("cycles")
    require(cycles_addon is not None, "cycles_addon_missing")
    preferences = cycles_addon.preferences
    try:
        preferences.compute_device_type = "CUDA"
        preferences.get_devices()
    except Exception as error:
        raise RuntimeError(f"cuda_configuration_failed:{error}") from error
    cuda_devices = [device for device in preferences.devices if device.type == "CUDA"]
    require(cuda_devices, "usable_cuda_device_missing")
    for device in preferences.devices:
        device.use = device.type == "CUDA"
    require(any(device.use for device in cuda_devices), "usable_cuda_device_missing")
    bpy.context.scene.cycles.device = "GPU"
    return sorted(device.name for device in cuda_devices if device.use)


def visible_meshes():
    return sorted(
        (
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "MESH" and not obj.hide_render
        ),
        key=lambda obj: obj.name,
    )


def principled_node(material):
    if not material.use_nodes or material.node_tree is None:
        return None
    return next(
        (node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"),
        None,
    )


def material_is_transparent(material):
    if material is None:
        return False
    if material.diffuse_color[3] < 0.999:
        return True
    shader = principled_node(material)
    if shader is None:
        return False
    alpha = shader.inputs.get("Alpha")
    transmission = shader.inputs.get("Transmission Weight") or shader.inputs.get("Transmission")
    return bool(
        (alpha is not None and float(alpha.default_value) < 0.999)
        or (transmission is not None and float(transmission.default_value) > 1.0e-6)
    )


def material_is_emissive(material):
    shader = principled_node(material)
    if shader is None:
        return False
    emission_color = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
    emission_strength = shader.inputs.get("Emission Strength")
    if emission_color is None:
        return False
    strength = float(emission_strength.default_value) if emission_strength is not None else 1.0
    return strength > 1.0e-6 and max(float(value) for value in emission_color.default_value[:3]) > 1.0e-6


def validate_scene_and_objects():
    scene = bpy.context.scene
    require(scene.get("vrataSceneId") == SCENE_ID, "scene_id_mismatch")
    require(scene.get("vrataAuthoringRelease") == RELEASE_VERSION, "authoring_release_mismatch")
    require(scene.get("vrataSourceSha256") == EXPECTED_SOURCE_SHA256, "source_sha256_metadata_mismatch")
    require(scene.get("vrataGeometryStatus") == "review", "geometry_status_mismatch")
    objects = visible_meshes()
    require(objects, "no_visible_meshes")
    identifier_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
    pairs = []
    mesh_statuses = Counter()
    object_statuses = {}
    baked_objects = []
    excluded_objects = []
    for obj in objects:
        for key in REQUIRED_TAGS:
            require(key in obj, f"missing_tag:{obj.name}:{key}")
        object_id = obj["vrataObjectId"]
        part_id = obj["vrataPartId"]
        status = obj["vrataInteractionStatus"]
        policy = obj["vrataBakePolicy"]
        require(isinstance(object_id, str), f"invalid_object_id_type:{obj.name}")
        require(isinstance(part_id, str), f"invalid_part_id_type:{obj.name}")
        require(isinstance(status, str), f"invalid_interaction_status_type:{obj.name}")
        require(identifier_pattern.fullmatch(object_id) is not None, f"unstable_object_id:{obj.name}")
        require(identifier_pattern.fullmatch(part_id) is not None, f"unstable_part_id:{obj.name}")
        require(status in INTERACTION_STATUSES, f"invalid_interaction_status:{obj.name}")
        pairs.append((object_id, part_id))
        mesh_statuses[status] += 1
        if object_id in object_statuses:
            require(object_statuses[object_id] == status, f"inconsistent_object_status:{object_id}")
        else:
            object_statuses[object_id] = status
        transparent = any(material_is_transparent(material) for material in obj.data.materials)
        if policy == "include":
            require(not transparent, f"transparent_mesh_must_be_excluded:{obj.name}")
            baked_objects.append(obj)
        elif policy == "exclude-transparent":
            require(obj.get("vrataBakeExclusionReason") == "transparent-glass", f"invalid_bake_exclusion_reason:{obj.name}")
            require(transparent, f"opaque_mesh_excluded_from_bake:{obj.name}")
            excluded_objects.append(obj)
        elif policy == "exclude-unlit-background":
            require(obj.get("vrataBakeExclusionReason") == "unlit-sky", f"invalid_sky_bake_exclusion_reason:{obj.name}")
            require(not transparent, f"transparent_sky_background:{obj.name}")
            require(obj.data.materials, f"sky_background_material_missing:{obj.name}")
            require(all(material_is_emissive(material) for material in obj.data.materials), f"sky_background_not_emissive:{obj.name}")
            excluded_objects.append(obj)
        else:
            raise RuntimeError(f"invalid_bake_policy:{obj.name}:{policy}")
    require(len(pairs) == len(set(pairs)), "duplicate_object_part_tag")
    require(set(mesh_statuses) == INTERACTION_STATUSES, "interaction_semantics_incomplete")
    require(excluded_objects, "bake_exclusions_missing")
    baked_materials = {
        material
        for obj in baked_objects
        for material in obj.data.materials
        if material is not None
    }
    excluded_materials = {
        material
        for obj in excluded_objects
        for material in obj.data.materials
        if material is not None
    }
    require(not baked_materials.intersection(excluded_materials), "baked_material_shared_with_transparent_exclusion")
    return objects, baked_objects, excluded_objects, mesh_statuses, object_statuses


def unwrap_lightmap(objects):
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        uv_layers = obj.data.uv_layers
        existing_lightmap = uv_layers.get(LIGHTMAP_UV)
        if existing_lightmap is not None:
            uv_layers.remove(existing_lightmap)
        if not uv_layers:
            uv_layers.new(name="UVMap")
        while len(uv_layers) > 1:
            uv_layers.remove(uv_layers[-1])
        lightmap_layer = uv_layers.new(name=LIGHTMAP_UV)
        uv_layers.active = lightmap_layer
        require(uv_layers.find(LIGHTMAP_UV) == 1, f"lightmap_not_uv1:{obj.name}")
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


def restore_original_emissive(material):
    if material.get("vrataLightMap") is not True:
        return
    shader = principled_node(material)
    if shader is None:
        return
    emission_color = shader.inputs.get("Emission Color")
    emission_strength = shader.inputs.get("Emission Strength")
    original_color = material.get("vrataOriginalEmissive", [0.0, 0.0, 0.0])
    original_intensity = float(material.get("vrataOriginalEmissiveIntensity", 1.0))
    if emission_color is not None:
        emission_color.default_value = (*original_color[:3], 1.0)
    if emission_strength is not None:
        emission_strength.default_value = original_intensity


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
        restore_original_emissive(material)
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


def bake_irradiance(scene, objects, image, samples):
    scene.render.engine = "CYCLES"
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
        original_color = list(emission_color.default_value[:3]) if emission_color else [0.0, 0.0, 0.0]
        original_intensity = float(emission_strength.default_value) if emission_strength else 1.0
        texture = material.node_tree.nodes.get(LIGHTMAP_NODE)
        if emission_color and texture:
            material.node_tree.links.new(texture.outputs["Color"], emission_color)
        if emission_strength:
            emission_strength.default_value = 1.0
        material["vrataRenderProfile"] = "baked-pbr-v1"
        material["vrataLightMap"] = True
        material["vrataLightMapIntensity"] = LIGHTMAP_INTENSITIES.get(material.name, default_intensity)
        material["vrataOriginalEmissive"] = original_color
        material["vrataOriginalEmissiveIntensity"] = original_intensity
    image.pack()


def mark_unbaked_materials(objects):
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
        policies = {
            obj["vrataBakePolicy"]
            for obj in objects
            if any(candidate == material for candidate in obj.data.materials)
        }
        require(len(policies) == 1, f"mixed_unbaked_material_policy:{material.name}")
        material["vrataRenderProfile"] = "baked-pbr-v1"
        material["vrataLightMap"] = False
        material["vrataBakePolicy"] = policies.pop()
    return materials


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


def glb_document(path):
    with path.open("rb") as stream:
        header = stream.read(12)
        require(len(header) == 12, "glb_header_missing")
        magic, version, total_length = struct.unpack("<4sII", header)
        require(magic == b"glTF" and version == 2, "invalid_glb_header")
        require(total_length == path.stat().st_size, "glb_length_mismatch")
        chunk_header = stream.read(8)
        require(len(chunk_header) == 8, "glb_json_chunk_missing")
        chunk_length, chunk_type = struct.unpack("<II", chunk_header)
        require(chunk_type == 0x4E4F534A, "glb_first_chunk_not_json")
        return json.loads(stream.read(chunk_length).decode("utf-8").rstrip(" \t\r\n\x00"))


def json_value(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "to_list"):
        return [json_value(item) for item in value.to_list()]
    if hasattr(value, "to_dict"):
        return {key: json_value(item) for key, item in sorted(value.to_dict().items())}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    raise RuntimeError(f"unsupported_extra_type:{type(value).__name__}")


def vrata_extras(value):
    return {
        key: json_value(value[key])
        for key in sorted(value.keys())
        if key.startswith("vrata")
    }


def validate_glb(
    path,
    expected_object_extras,
    expected_scene_extras,
    expected_material_count,
    expected_baked_material_count,
):
    require(path.is_file() and path.stat().st_size > 0, "glb_output_missing")
    document = glb_document(path)
    require(not document.get("cameras"), "camera_exported")
    require(not document.get("animations"), "animation_exported")
    require("KHR_lights_punctual" not in document.get("extensionsUsed", []), "light_extension_exported")
    nodes = document.get("nodes", [])
    mesh_nodes = [node for node in nodes if "mesh" in node]
    require(len(mesh_nodes) == len(expected_object_extras), "exported_mesh_node_count_mismatch")
    require({node.get("name") for node in mesh_nodes} == set(expected_object_extras), "exported_mesh_names_mismatch")
    for node in mesh_nodes:
        extras = node.get("extras", {})
        for key in REQUIRED_TAGS:
            require(key in extras, f"exported_mesh_tag_missing:{node.get('name', '<unnamed>')}:{key}")
        for key, expected in expected_object_extras[node["name"]].items():
            require(extras.get(key) == expected, f"exported_mesh_extra_mismatch:{node['name']}:{key}")
        if extras["vrataBakePolicy"] == "include":
            mesh = document.get("meshes", [])[node["mesh"]]
            for primitive in mesh.get("primitives", []):
                require("TEXCOORD_1" in primitive.get("attributes", {}), f"lightmap_uv1_missing:{node['name']}")
        require("camera" not in node, f"camera_node_exported:{node.get('name', '<unnamed>')}")
        require(
            "KHR_lights_punctual" not in node.get("extensions", {}),
            f"light_node_exported:{node.get('name', '<unnamed>')}",
        )
    baked_material_count = 0
    exported_materials = document.get("materials", [])
    require(len(exported_materials) == expected_material_count, "exported_material_count_mismatch")
    for material in exported_materials:
        extras = material.get("extras", {})
        require(extras.get("vrataRenderProfile") == "baked-pbr-v1", "material_render_profile_missing")
        if extras.get("vrataLightMap") is True:
            baked_material_count += 1
            require("vrataLightMapIntensity" in extras, "lightmap_intensity_missing")
            require("vrataOriginalEmissive" in extras, "original_emissive_missing")
            require("vrataOriginalEmissiveIntensity" in extras, "original_emissive_intensity_missing")
            require(material.get("emissiveTexture", {}).get("texCoord") == 1, "lightmap_texcoord_mismatch")
        else:
            require(extras.get("vrataLightMap") is False, "unclassified_material_lightmap_policy")
            require(
                extras.get("vrataBakePolicy") in {"exclude-transparent", "exclude-unlit-background"},
                "unbaked_material_policy_mismatch",
            )
    require(baked_material_count == expected_baked_material_count, "baked_material_count_mismatch")
    scene_index = document.get("scene", 0)
    scenes = document.get("scenes", [])
    require(0 <= scene_index < len(scenes), "active_scene_missing")
    exported_scene_extras = scenes[scene_index].get("extras", {})
    require(not any(key.startswith("wmmr_") for key in exported_scene_extras), "stripped_scene_extra_exported")
    for key, expected in expected_scene_extras.items():
        require(exported_scene_extras.get(key) == expected, f"scene_extra_mismatch:{key}")
    return document


def main():
    args = arguments()
    output = Path(args.output).expanduser().resolve()
    lightmap_path = Path(args.lightmap).expanduser().resolve()
    assert_safe_paths(output, lightmap_path, args.bake)
    cuda_devices = assert_toolchain(args.bake)
    export_objects, baked_objects, excluded_objects, mesh_statuses, object_statuses = validate_scene_and_objects()
    expected_object_extras = {obj.name: vrata_extras(obj) for obj in export_objects}
    tagged_materials = sorted(
        {
            material
            for obj in export_objects
            for material in obj.data.materials
            if material is not None
        },
        key=lambda material: material.name,
    )
    require(args.size > 0 and args.samples > 0 and args.scale > 0.0, "invalid_bake_settings")
    unwrap_lightmap(baked_objects)
    if args.bake:
        existing_image = bpy.data.images.get("vrata.lightmap.atlas")
        if existing_image is not None:
            bpy.data.images.remove(existing_image)
        image = bpy.data.images.new(
            "vrata.lightmap.atlas",
            width=args.size,
            height=args.size,
            alpha=False,
            float_buffer=True,
        )
    else:
        require(lightmap_path.is_file(), f"versioned_lightmap_missing:{lightmap_path.name}")
        image = bpy.data.images.load(str(lightmap_path), check_existing=False)
    image.colorspace_settings.name = "sRGB"
    require(tuple(image.size) == (args.size, args.size), "lightmap_size_mismatch")
    materials = prepare_materials(baked_objects, image)
    if args.bake:
        bake_irradiance(bpy.context.scene, baked_objects, image, args.samples)
        stats = scale_image(image, args.scale)
        lightmap_path.parent.mkdir(parents=True, exist_ok=True)
        image.filepath_raw = str(lightmap_path)
        image.file_format = "PNG"
        image.save()
    else:
        stats = {"linearMaxBeforeScale": None, "linearMeanBeforeScale": None}
    wire_lightmaps(materials, image, 1.0 / args.scale)
    excluded_materials = mark_unbaked_materials(excluded_objects)
    scene = bpy.context.scene
    scene["vrataRenderProfile"] = "baked-pbr-v1"
    scene["vrataLightMapTextureSlot"] = "emissiveTexture"
    scene["vrataLightMapTexCoord"] = 1
    expected_scene_extras = vrata_extras(scene)
    output.parent.mkdir(parents=True, exist_ok=True)
    export_glb(output, export_objects)
    validate_glb(
        output,
        expected_object_extras,
        expected_scene_extras,
        len(tagged_materials),
        len(materials),
    )
    bake_exclusions = [
        {
            "name": obj.name,
            "reason": obj["vrataBakeExclusionReason"],
            "vrataObjectId": obj["vrataObjectId"],
            "vrataPartId": obj["vrataPartId"],
        }
        for obj in excluded_objects
    ]
    print(
        json.dumps(
            {
                "baked": args.bake,
                "bakedMaterialCount": len(materials),
                "bakedMeshCount": len(baked_objects),
                "bakeExclusionCount": len(bake_exclusions),
                "bakeExclusions": bake_exclusions,
                "blenderBuildHash": decoded_build_hash(),
                "blenderVersion": ".".join(str(value) for value in bpy.app.version[:3]),
                "cudaDevices": cuda_devices,
                "device": args.device,
                "excludedMaterialCount": len(excluded_materials),
                "glbSha256": sha256(output),
                "interactionMeshStatuses": dict(sorted(mesh_statuses.items())),
                "interactionObjectStatuses": dict(sorted(Counter(object_statuses.values()).items())),
                "lightmap": str(lightmap_path),
                "output": str(output),
                "releaseVersion": RELEASE_VERSION,
                "samples": args.samples,
                "scale": args.scale,
                "size": args.size,
                "taggedMaterialCount": len(tagged_materials),
                "taggedMeshCount": len(export_objects),
                "taggedObjectCount": len(object_statuses),
                **stats,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
