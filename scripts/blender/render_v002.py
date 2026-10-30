import bpy, math, sys
from mathutils import Vector

ROOT = r"G:\DSHProject\ThreeJSInspire"
bpy.ops.wm.open_mainfile(filepath=ROOT + r"\assets\blend\porco-fighter-v002.blend")

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = 640
scene.render.resolution_y = 420
scene.render.film_transparent = False

# Neutral studio backdrop so silhouette and strut read are judgeable.
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.09, 0.10, 0.14, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0

sun_data = bpy.data.lights.new("sun", "SUN")
sun_data.energy = 4.0
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(58), 0, math.radians(38))

fill_data = bpy.data.lights.new("fill", "AREA")
fill_data.energy = 900
fill_data.size = 12
fill = bpy.data.objects.new("fill", fill_data)
scene.collection.objects.link(fill)
fill.location = (-9, 9, 7)
fill.rotation_euler = (math.radians(55), 0, math.radians(-130))

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 62
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

target = Vector((0, 0, 0.3))
views = {
    "side": Vector((0.0, -20.0, 1.4)),
    "three_quarter": Vector((13.5, -14.5, 6.2)),
    "front": Vector((0.0, -20.0, 6.0)),
}
for name, pos in views.items():
    cam.location = pos
    direction = target - pos
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = r"G:\DSHProject\.tools\porco-v002-%s.png" % name
    bpy.ops.render.render(write_still=True)
    sys.stdout.write("wrote %s\n" % scene.render.filepath)
