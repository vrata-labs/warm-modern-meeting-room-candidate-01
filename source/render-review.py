import argparse
from pathlib import Path
import sys

import bpy


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


output_dir = Path(arguments().output_dir)
output_dir.mkdir(parents=True, exist_ok=True)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = False
scene.view_settings.look = "AgX - Medium Low Contrast"
scene.view_settings.exposure = 0.25

if hasattr(scene, "eevee"):
    if hasattr(scene.eevee, "taa_render_samples"):
        scene.eevee.taa_render_samples = 24
    if hasattr(scene.eevee, "taa_samples"):
        scene.eevee.taa_samples = 24

for view_id in ("entry", "participant", "presenter", "diagonal-overview"):
    scene.camera = bpy.data.objects[f"camera.review.{view_id}"]
    scene.render.filepath = str(output_dir / f"{view_id}.png")
    bpy.ops.render.render(write_still=True)
