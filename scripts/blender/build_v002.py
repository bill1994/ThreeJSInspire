"""Build porco-fighter-v002 from the shipped v001 GLB.

The v001 .blend in this repo is NOT a loadable Blender file (it decompresses to a
fabricated header with no DNA1/ENDB blocks), so there is nothing to reshape on
disk. The shipped GLB is genuine, so this script imports it, reshapes it toward
the Savoia S.21 character, and writes the first real .blend source.

Run: blender --background --python build_v002.py
"""
import bpy, json, os, sys, math
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GLB_IN = ROOT + r"\assets\porco-fighter.glb"
BLEND_OUT = ROOT + r"\assets\blend\porco-fighter-v002.blend"
GLB_OUT = ROOT + r"\assets\porco-fighter-v002.glb"

log = []


def note(msg):
    log.append(msg)


# ---------------------------------------------------------------- import + flatten
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_IN)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in bpy.data.objects:
    o.select_set(o.type == "MESH")
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# Drop the imported empties: with parents cleared they are dead weight in the file.
for o in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)

objs = {o.name: o for o in bpy.data.objects if o.type == "MESH"}
note("imported %d meshes, %d tris" % (len(objs), sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs.values())))

# Blender space after the Y-up conversion: +X = right wing, -Y = nose, +Z = up.


def bbox(o):
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return (min(p.x for p in pts), max(p.x for p in pts),
            min(p.y for p in pts), max(p.y for p in pts),
            min(p.z for p in pts), max(p.z for p in pts))


def make_bar(name, p0, p1, thickness, material):
    """A square bar from p0 to p1, matching the airframe's existing tube look."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bpy.ops.mesh.primitive_cube_add(size=1, location=(p0 + p1) * 0.5)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (thickness, thickness, d.length)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    ob.data.materials.append(bpy.data.materials[material])
    return ob


# ---------------------------------------------------------------- 1. parasol wing
# v001 hung the wing at hull mid-height (z 0.02). The S.21's defining read is a
# strut-braced parasol wing standing clear above the hull, so raise the whole
# wing plane and give it the pylon + float struts that hold it up.
WING_Z = 1.28
wing_parts = ["wing_main", "wing_tip_l", "wing_tip_r"]
for n in wing_parts:
    o = objs[n]
    o.location.z += WING_Z - 0.02
note("wing raised to z=%.2f" % WING_Z)

# Slight span reduction (11.72 -> ~10.9 m) toward S.21 proportions, plus a touch
# of dihedral so the tips read above the root in profile.
for n in wing_parts:
    o = objs[n]
    o.location.x *= 0.93
    o.scale.x *= 0.93
for n in ["wing_tip_l", "wing_tip_r"]:
    objs[n].location.z += 0.10

# Taper + thin the wing. A constant-chord slab was the single biggest reason v001
# read as a plank rather than a 1930s racer: chord now falls to 60% at the tip and
# the section is 15% thinner.
objs["wing_main"].scale.z *= 0.85
for n in ["wing_tip_l", "wing_tip_r"]:
    objs[n].scale.z *= 0.85
    objs[n].scale.y *= 0.60
for n in wing_parts:
    o = objs[n]
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# ---------------------------------------------------------------- 2. strut work
# The four v001 struts were fore-aft bars floating between the floats and nothing;
# a parasol wing needs vertical float-to-wing members and transverse hull-to-float
# members. Replace them outright rather than bending bars that were never attached.
for n in ["strut_l_a", "strut_l_f", "strut_r_a", "strut_r_f"]:
    if n in objs:
        bpy.data.objects.remove(objs.pop(n), do_unlink=True)

WING_UNDER = WING_Z - 0.14
FLOAT_TOP = -1.01
for side, sx in (("l", -1.0), ("r", 1.0)):
    for tag, y in (("f", -1.05), ("a", 0.62)):
        make_bar("strut_%s_%s" % (side, tag),
                 (sx * 1.55, y, FLOAT_TOP), (sx * 1.55, y, WING_UNDER),
                 0.085, "metal_prop")
    for tag, y in (("f", -1.65), ("a", 1.10)):
        make_bar("floatstay_%s_%s" % (side, tag),
                 (sx * 0.58, y, -0.52), (sx * 1.55, y, -1.06),
                 0.075, "metal_prop")

# Central pylon: the parasol wing is carried off the hull spine, not only the floats.
make_bar("pylon_f", (0.0, -1.15, 0.80), (0.0, -1.05, WING_UNDER), 0.11, "metal_prop")
make_bar("pylon_a", (0.0, 0.55, 0.80), (0.0, 0.62, WING_UNDER), 0.11, "metal_prop")
note("strut system rebuilt: 4 float-to-wing, 4 hull-to-float, 2 pylon")

# ---------------------------------------------------------------- 3. hull character
# S.21 hull: fuller underside, longer tapering nose deck, tail raised into the fin.
hull = objs["fuselage_body"]
hull.scale.z *= 1.06
hull.scale.y *= 1.02

fin = objs["fin_main"]
fin.location.z += 0.16
fin.scale.y *= 1.12
fin.scale.z *= 1.14
objs["fin_stripe"].location.z += 0.16
objs["fin_stripe"].scale.y *= 1.12
objs["fin_stripe"].scale.z *= 1.14

for n in ["stab_main", "stab_tip_l", "stab_tip_r"]:
    objs[n].location.z += 0.10

for o in [hull, fin, objs["fin_stripe"], objs["stab_main"], objs["stab_tip_l"], objs["stab_tip_r"]]:
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

# ---------------------------------------------------------------- 4. tri budget
# The plan caps v002 at 3-5k tris. The 952-tri lathed parts (hull, canopy, floats)
# carry far more rings than a toon-shaded 30 m silhouette can show.
BUDGET = 4800
total = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
for name in ["fuselage_body", "canopy", "float_l", "float_r"]:
    if total <= BUDGET:
        break
    o = bpy.data.objects[name]
    before = sum(len(p.vertices) - 2 for p in o.data.polygons)
    mod = o.modifiers.new("decimate", "DECIMATE")
    mod.ratio = 0.62
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    after = sum(len(p.vertices) - 2 for p in o.data.polygons)
    total += after - before
    note("decimated %s %d -> %d tris" % (name, before, after))

# ---------------------------------------------------------------- 5. notes + save
notes = bpy.data.texts.new("ASSET-NOTES")
notes.write("""porco-fighter-v002  (Batch E of the sea/cloud design)

SOURCE
  Built by importing assets/porco-fighter.glb (the genuine v001 asset) into Blender
  and reshaping it. assets/blend/porco-fighter-v001.blend is NOT loadable -- it
  decompresses to a fabricated header with no DNA1/ENDB -- so the GLB is the real
  ancestor of this file. v001.blend is kept untouched per the "v001 kept forever"
  ruling.

PROPORTIONS REFERENCE
  Savoia S.21 by FEDERICOFELICI, CC-BY 4.0
  https://sketchfab.com/3d-models/savoia-s21-3418b01468474872939971466704bbc7
  Proportions only (hull fullness, strut-braced parasol wing, pusher-engine nose,
  twin floats). No mesh data from that model is present here; nothing was imported.

AXES  (do not change -- plane.ts depends on this)
  Blender: Z-up, nose -Y.  glTF export converts to Y-up, nose +Z.
  plane.ts then applies rotation.y = pi to align with flight direction -Z.

CHANGES FROM v001
  - wing raised from hull mid-height (z 0.02) to a parasol position (z 1.28),
    span 11.72 -> 10.9 m, 0.10 m dihedral at the tips
  - the four unattached fore-aft bars replaced by a real strut system:
    4 float-to-wing, 4 hull-to-float stays, 2 central pylons
  - hull 6% fuller in Z, 2% longer; fin raised 0.16 and enlarged 12%/14%;
    stabiliser raised 0.10
  - lathed parts decimated to hold the 3-5k tri budget

MATERIALS  (names are load-bearing, plane.ts matches on them)
  livery_white, livery_green, livery_red, dark_trim, glass_canopy, metal_prop
""")

total = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
pts = []
for o in meshes:
    pts.extend([o.matrix_world @ Vector(c) for c in o.bound_box])

bpy.context.scene.unit_settings.system = "METRIC"
bpy.context.scene.unit_settings.scale_length = 1.0
bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)

bpy.ops.export_scene.gltf(
    filepath=GLB_OUT,
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=True,
    export_materials="EXPORT",
    export_cameras=False,
    export_lights=False,
)

result = {
    "meshes": len(meshes),
    "triangles": total,
    "bbox_x": [round(min(p.x for p in pts), 3), round(max(p.x for p in pts), 3)],
    "bbox_y": [round(min(p.y for p in pts), 3), round(max(p.y for p in pts), 3)],
    "bbox_z": [round(min(p.z for p in pts), 3), round(max(p.z for p in pts), 3)],
    "materials": sorted(m.name for m in bpy.data.materials),
    "objects": sorted(o.name for o in meshes),
    "log": log,
}
sys.stdout.write("DSHJSON" + json.dumps(result) + "DSHJSON\n")
