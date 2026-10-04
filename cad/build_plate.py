#!/usr/bin/env python3
"""Generator of record for the back plate and the PIR bracket.

The original mounting_plate STLs were exported from OpenSCAD, but that source was
never kept and OpenSCAD is not installed on this machine, so this script builds the
meshes directly. It emits, next to itself:

    mounting_plate_v6.stl   the back plate
    pir_bracket.stl         the L-bracket that points the PIR down at the shelves
    vision_cradle.stl       the frame the Vision AI enclosure drops into
    magnet_bar.stl          two 12 x 3 mm magnets; print twice, one per plate end
    foot.stl                stands the plate on the toolbox lid; print twice
    mounting_plate.scad     the same plate as readable OpenSCAD, for future edits
    mounting_plate_v6.svg   a dimensioned top view

Run it with any Python 3; it has no dependencies.

Geometry is built face by face rather than by CSG. Every part here is a slab pierced
by holes normal to its faces, so each face triangulates as a rectangle-with-holes and
each hole contributes a cylinder wall. Every slab is checked for closure and volume
before anything is written - see verify().

The bracket is two slabs that overlap at the corner rather than one welded solid.
Both shells are closed, and slicers union overlapping shells; welding them would mean
matching triangulations across six faces for no gain in the print.

Coordinates: X runs along the length of the plate, Y up its height, Z out of its front
face. The origin is the bottom-left corner seen from the front. Y = 0 is the bottom
edge, the one the LED strip and the PIR look down from.
"""

import math
import os

# --- parameters -----------------------------------------------------------------

PLATE_W = 228.6          # 9 inches, unchanged from v4
PLATE_H = 76.2           # 3 inches, unchanged from v4
PLATE_T = 3.0

D_M2 = 2.2               # clearance for an M2 screw; the whole grid uses this
D_PI = 3.2               # Pi Zero standoffs, unchanged from v4
D_EXP = 3.4              # expansion board, see below

# Raspberry Pi Zero 2, mounted portrait at the left end. Unchanged from v4.
PI_X = (8.0, 31.0)       # 23 mm apart
PI_Y = (9.1, 67.1)       # 58 mm apart

# XIAO Expansion Board Base, the board carrying the OLED.
#
# v5 guessed this footprint by hand and got it wrong twice over: the pattern was
# measured as 2 x 1.5 inches when the board is metric, and the holes were drilled at
# M2 clearance when the board's own holes are 3.0 mm. The screws would not go
# through and the pattern did not line up. v6 uses the board's published figures:
# a 58 x 42.5 mm outline with four 3.0 mm holes on a 50 x 35 mm rectangle, which
# leaves 4.0 mm to the short edges and 3.75 mm to the long ones.
#
# The plate's holes are 3.4 rather than 3.0, because a 3.0 hole in the board and a
# 3.0 hole in the plate leave an M3 screw no room for the two to disagree; 3.4 takes
# up the print's own tolerance and the slack in the pattern.
EXP_W = 58.0             # board outline, drawn on the SVG so the fit can be checked
EXP_H = 42.5
EXP_DX = 50.0            # hole centres
EXP_DY = 35.0
EXP_X0 = 56.0            # sets the gap to the Pi that the USB-C plug lives in
EXP_Y0 = PLATE_H / 2 - EXP_DY / 2

# The component grid. v4 ran 15 columns from x=44; the left 8 are gone in v5 to
# clear the area the expansion board now occupies.
GRID_X = [124.0 + 10.0 * i for i in range(7)]
GRID_Y = [5.0 + 10.0 * i for i in range(7)]

# The bottom two rows carry on past the grid to the right edge, as a rail. The PIR
# bracket bolts to exactly these two rows, so extending them is what lets it sit at
# the right-hand end instead of only where v5's grid happened to stop. The last
# column leaves 3.5 mm of material to the edge, which is the same web the bottom row
# already has beneath it.
RAIL_X = [194.0 + 10.0 * i for i in range(4)]
RAIL_Y = GRID_Y[:2]

# PIR bracket. A C seen from the side, open at the bottom: the upright bolts to the
# plate's grid, the shelf runs forward off its top, and the hood hangs from the
# shelf's front edge. The board screws under the shelf facing down, inside the
# channel, so the hood blocks the room in front and the sensor sees down at the
# drawers rather than at whoever walks past.
#
# Nothing hangs below the plate's bottom edge. v1 put the shelf at the bottom with the
# board beneath it, so the sensor stuck out below the plate, and any hood on that
# would have sat in front of the top drawer, in its way.
#
# The Grove PIR is a 20 x 40 mm board with three 2.2 mm holes, all of them centred on
# the board's edge inside a small round ear. Two sit on the long edges, 10 mm from
# the connector end; the third is on the centreline of the sensor end. Read from
# Seeed's own Eagle board file for v1.2 - see docs/SOURCES.md. v1 of this bracket
# guessed two holes 5 mm in from each end and gave them slots, and neither lined up.
#
# Offsets are from the board's centre, x along its long axis towards the sensor.
PIR_L = 40.0             # Grove 20 x 40 board, long axis across the plate
PIR_W = 20.0
PIR_HOLES = [(-10.0, -10.0), (-10.0, 10.0), (20.0, 0.0)]

BR_W = 50.0              # across the plate: the board is 40, plus a margin each side
BR_H = 22.0              # up the plate, and the hood's height with it. As tall as
                         # fits under the cradle at y 23: the taller the channel, the
                         # further the hood reaches past the lens, and the narrower the
                         # sensor's view forward
BR_D = 32.0              # out from the plate, outside to outside
BR_T = 3.0
BR_BOLT_X = (5.0, 45.0)       # 40 mm apart, a multiple of the plate grid pitch. Out at
                              # the ends because the bolt heads sit inside the channel,
                              # and at 15 they met the screws in the board's ears
BR_BOLT_Y = (5.0, 15.0)       # the two lowest grid rows
BR_HEAD_CLEAR = 2.5      # half an M2 head plus a margin, between the board's outer
                         # screws and the hood, which is what sets where the board sits

# Vision AI enclosure cradle. The enclosure itself is not ours: it is the Thingiverse
# holder recorded under Printed parts in docs/SOURCES.md, licensed CC BY-SA. None of
# its geometry appears here - the cradle only surrounds it - so nothing of that licence
# carries across. The three figures below were measured off its STLs by slicing the
# assembled base and cap, not taken from the listing.
ENC_W = 31.20            # the axis the hinge pivots about; horizontal when mounted
ENC_H = 49.03            # the axis the camera head swings along; vertical
ENC_D = 15.50            # back face to the front-most body point, plus 0.2 of play.
                         # The flat faces are 14.95 apart, but the front edge chamfer
                         # runs out 0.35 further; a lip set to 15.0 fouls it all round.
ENC_FIT = 0.50           # slip fit, split across both walls

CR_WALL = 3.0
CR_FLOOR = 3.0
CR_LIP = 2.0             # how far the side lips reach in over the enclosure
CR_LIP_T = 2.0
CR_PILOT = 1.7           # M2 self-tapping from behind, so no head sits under the box
CR_BOLT_DX = 20.0        # both a multiple of the plate's 10 mm grid pitch
CR_BOLT_DY = 20.0
CR_PILOT_Y0 = 12.0       # not centred on the floor: set so that with the cradle's foot
                         # at plate y=23, clear of the bracket below, its pilots still
                         # land on grid rows 35 and 55

# Magnet bars. Two of them, one at each end of the plate, each carrying a magnet
# near the top corner and another near the bottom - so four of the six 12 x 3 mm
# discs land near the plate's four corners, which is what stops it pivoting.
#
# Built like the cradle rather than as four separate pucks: one part, printed twice,
# symmetric about its own centreline so the left and the right are the same STL. The
# full plate height is deliberate - it stiffens a 3 mm plate along the axis it is
# weakest in, for the cost of plastic that was going to be there anyway.
#
# z = 0 is the face that meets the toolbox; z = MB_T the face that meets the plate.
MAG_D = 12.0             # the discs in hand
MAG_T = 3.0
MB_POCKET_D = MAG_D + 0.4        # across, for print tolerance and a film of glue
MB_POCKET_DEPTH = MAG_T - 0.2    # shallower than the magnet on purpose: the magnet
                                 # touches the steel and the plastic does not. An air
                                 # gap costs pull far faster than wall thickness does
MB_WALL = 2.0                    # around a pocket
MB_FLOOR = 2.0                   # behind it
MB_T = MB_POCKET_DEPTH + MB_FLOOR        # 4.8 off the back of the plate
MB_W = 20.0                      # across the plate; the pocket needs 16.4 of it
MB_H = PLATE_H                   # the full height of the plate
MB_MAG_INSET = 10.0              # magnet centre from each end of the bar
MB_PILOT = 1.7           # M2 self-tapping, the same size the cradle pilots use
MB_PILOT_DEPTH = 4.0     # blind, stopping 0.8 short of breaking out on the magnet
                         # face - a screw tip against the steel would hold the magnet
                         # off it, which is the one thing this part exists to avoid

# Where the bars land. The bolts sit on grid rows 25 and 45 in both cases; only the
# columns differ, and neither is a free choice. 184 is the rightmost full grid column
# (the rail past it carries rows 5 and 15 only, which is too short a base for a 76 mm
# bar). 44 is the leftmost column with room for a screw head: the Pi ends at 34.5 and
# the expansion board starts at 52, and nothing else fits between them.
MB_X = (44.0, 184.0)
MB_BOLT_Y = (25.0, 45.0)

# The left bar's column is the only part of that pattern the plate did not already
# have. The right bar bolts to grid holes that were there in v5.
BAR_X = [MB_X[0]]
BAR_Y = list(MB_BOLT_Y)

# Feet, for standing the plate on top of the toolbox instead of hanging it on the
# side. One part, printed twice. The plate drops into a slot and leans back a few
# degrees, so gravity holds it against the tall triangle behind and the front lip
# only has to stop the bottom edge sliding forward. That is why the slot can be a
# loose fit: nothing depends on friction.
#
# The tilt is kept slight on purpose. It tips the PIR and the camera back by the same
# angle, and a few degrees leaves both still looking down at the drawers.
#
# The front of the foot is short because the PIR looks straight down from just in
# front of the plate. The plate has to stand at the lid's front edge for the sensor
# to see past the lid to the drawers, and every millimetre of toe pushes it back.
#
# Local coordinates for printing: x along the plate, y from the front of the foot to
# the back, z up. Print as it sits; no face overhangs by more than the tilt.
FOOT_L = 30.0            # along the plate
FOOT_TILT = 8.0          # degrees back from vertical
FOOT_PAD = 3.0           # floor under the plate's bottom edge
FOOT_TOE = 6.0           # lip thickness in front of the plate
FOOT_LIP_H = 6.0         # how far the lip rises up the plate's front face
FOOT_SLOT = 3.4          # across the slot, square to the plate; the plate is 3.0
FOOT_HEEL = 35.0         # from the back of the slot to the back of the foot
FOOT_BRACE_H = 22.0      # how far the triangle rises up the plate's back face

# Where the feet go, as plate x ranges. Chosen clear of both magnet-bar columns
# (34-54 and 174-194, on the back) so the bars and the feet can be tried together,
# of the PIR bracket (119-169), and of the expansion board's screw heads at 56 and 106.
FOOT_X = ((62.0, 92.0), (196.0, 226.0))

SEG = 48                 # segments per hole
# Where the two parts sit on the plate. They stack in one column: bracket along the
# bottom edge, cradle above it.
# The bracket can slide anywhere along the rail: its bolts are 40 mm apart on rows 5
# and 15, so any BRACKET_X that is a multiple of 10 off this one works. 169 is the
# rightmost that keeps the whole 50 mm bracket on the plate.
BRACKET_X = 119.0        # bolts land on columns 124 and 164
BRACKET_Y = 0.0          # bolts on rows 5 and 15
CRADLE_X = 125.15        # pilots land on columns 134 and 154
CRADLE_Y = 23.0          # pilots on rows 35 and 55


# --- small vector helpers -------------------------------------------------------

def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(u, v):
    return (u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0])


def dot(u, v):
    return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]


def orient(tris, want):
    """Flip each triangle so its normal agrees with want(triangle centroid).

    Cheaper to reason about than tracking winding through every lift and mirror:
    each facet is checked against the direction it is supposed to face and turned
    round if it disagrees.
    """
    out = []
    for t in tris:
        n = cross(sub(t[1], t[0]), sub(t[2], t[0]))
        c = tuple(sum(p[i] for p in t) / 3.0 for i in range(3))
        out.append(t if dot(n, want(c)) > 0 else (t[0], t[2], t[1]))
    return out


# --- meshing --------------------------------------------------------------------

def circle(cx, cy, r, n=SEG):
    """A ring of n points, counter-clockwise."""
    return [(cx + r * math.cos(2 * math.pi * i / n),
             cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def hole_round(cu, cv, d):
    """A hole: centre, half-extent in each axis, and its boundary ring."""
    return (cu, cv, d / 2, d / 2, circle(cu, cv, d / 2))


def ring_area(ring):
    """Shoelace area of a closed ring, so volume checks match the mesh exactly."""
    a = 0.0
    for i in range(len(ring)):
        p, q = ring[i], ring[(i + 1) % len(ring)]
        a += p[0] * q[1] - q[0] * p[1]
    return abs(a) / 2.0


def annulus(outer, inner, c):
    """Triangulate between two rings that are both star-shaped about c.

    Walks the rings together in angle order, taking a triangle from whichever has
    the nearer next vertex. Yields exactly len(outer) + len(inner) triangles.
    """
    a0 = math.atan2(outer[0][1] - c[1], outer[0][0] - c[0])

    def key(p):
        return (math.atan2(p[1] - c[1], p[0] - c[0]) - a0) % (2 * math.pi)

    ki = [key(p) for p in inner]
    s = min(range(len(inner)), key=lambda j: ki[j])
    inner, ki = inner[s:] + inner[:s], ki[s:] + ki[:s]
    ko = [key(p) for p in outer]

    no, ni = len(outer), len(inner)
    io = ii = 0
    tris = []
    while io < no or ii < ni:
        nxt_o = ko[io + 1] if io + 1 < no else 2 * math.pi
        nxt_i = ki[ii + 1] if ii + 1 < ni else 2 * math.pi
        if io < no and nxt_o <= nxt_i:
            tris.append((outer[io], outer[(io + 1) % no], inner[ii % ni]))
            io += 1
        else:
            tris.append((outer[io % no], inner[(ii + 1) % ni], inner[ii % ni]))
            ii += 1
    return tris


COLLAR = 1.5             # ring of solid left around a hole before the cell wall


def _split(lo, hi, items):
    """Cut [lo, hi] into segments holding at most one hole each.

    items are (coordinate, half-extent along this axis). Each hole claims a collar
    around its own extent, and the cuts fall in the gaps between those claims. Using
    the gaps rather than the midpoints between centres matters as soon as holes
    differ in size: a wide pocket beside a small screw hole has its midpoint inside
    the pocket, and the cut would slice straight through it.

    The collar also keeps a hole from sitting at the centre of a cell far larger than
    itself, where a cell corner can end up all but collinear with two adjacent points
    of the hole and the sliver between them has no reliable normal.

    Returns (start, end, coordinate or None) per segment.
    """
    reach = {}
    for c, h in items:
        reach[c] = max(reach.get(c, 0.0), h)
    cs = sorted(reach)
    spans = [(c - reach[c] - COLLAR, c + reach[c] + COLLAR) for c in cs]
    for (_, b0), (a1, _) in zip(spans, spans[1:]):
        assert b0 < a1, f"holes at {b0:.2f} and {a1:.2f} are too close to separate"
    edges = [lo] + [(b0 + a1) / 2 for (_, b0), (a1, _) in zip(spans, spans[1:])] + [hi]
    segs = []
    for (e0, e1), (a, b) in zip(zip(edges, edges[1:]), spans):
        assert e0 <= a and b <= e1,             f"a hole needs {a:.2f}..{b:.2f} but its band is only {e0:.2f}..{e1:.2f}"
        if a > e0 + 1e-9:
            segs.append((e0, a, None))
        segs.append((a, b, (a + b) / 2))
        if e1 > b + 1e-9:
            segs.append((b, e1, None))
    return segs


def face(u0, v0, u1, v1, holes):
    """Triangulate a rectangle pierced by holes, counter-clockwise in (u, v).

    The rectangle is cut into vertical bands by hole u, then each band into cells
    by the hole v values *present in that band alone*. One global grid of cuts would
    clip a hole whenever an unrelated hole elsewhere happened to sit close to it in
    the other axis, which is exactly what the component grid and the expansion board
    do to each other on this plate.

    Bands with different cell heights would leave T-junctions down the seam between
    them, so each cell carries its neighbours' cut lines as extra vertices along its
    left and right edges. That is what keeps the surface closed.
    """
    usegs = _split(u0, u1, [(h[0], h[2]) for h in holes]) if holes \
        else [(u0, u1, None)]

    bands = []
    for bu0, bu1, cu in usegs:
        inband = [h for h in holes if bu0 <= h[0] < bu1]
        vsegs = _split(v0, v1, [(h[1], h[3]) for h in inband]) if inband \
            else [(v0, v1, None)]
        bands.append((bu0, bu1, inband, vsegs))

    def cuts(i):
        return [s[0] for s in bands[i][3][1:]] if 0 <= i < len(bands) else []

    tris = []
    for i, (bu0, bu1, inband, vsegs) in enumerate(bands):
        left, right = cuts(i - 1) if i else [], cuts(i + 1)
        for bv0, bv1, cv in vsegs:
            ring = [(bu0, bv0), (bu1, bv0)]
            ring += [(bu1, v) for v in right if bv0 < v < bv1]
            ring += [(bu1, bv1), (bu0, bv1)]
            ring += [(bu0, v) for v in reversed(left) if bv0 < v < bv1]

            cell = [h for h in inband if bv0 <= h[1] < bv1]
            if not cell:
                cu = sum(p[0] for p in ring) / len(ring)
                cvc = sum(p[1] for p in ring) / len(ring)
                tris += [(ring[j], ring[(j + 1) % len(ring)], (cu, cvc))
                         for j in range(len(ring))]
                continue
            assert len(cell) == 1, f"cell at {bu0},{bv0} holds {len(cell)} holes"
            tris += annulus(ring, cell[0][4], (cell[0][0], cell[0][1]))
    return tris


LIFTS = {
    'z': lambda u, v, n: (u, v, n),
    'y': lambda u, v, n: (u, n, v),
    'x': lambda u, v, n: (n, u, v),
}
AXIS_I = {'x': 0, 'y': 1, 'z': 2}
# Whether (u, v) -> world is right-handed about the slab's own axis. Only 'y' is
# not, because x cross z points along -y. Faces take their winding from this rather
# than from each triangle's own normal, which a sliver cannot be trusted to give.
HANDED = {'z': 1, 'x': 1, 'y': -1}


def slab(axis, back, thick, u0, u1, v0, v1, holes):
    """A flat slab pierced by holes running through it along axis.

    back is where the slab's near face sits on that axis; holes are (u, v, r) in
    the slab's two in-plane axes. Returns world triangles wound outward.
    """
    lift, ai, hand = LIFTS[axis], AXIS_I[axis], HANDED[axis]
    front = back + thick
    flat = face(u0, v0, u1, v1, holes)

    def lay(n, outward):
        lifted = [tuple(lift(p[0], p[1], n) for p in t) for t in flat]
        return lifted if hand == outward else [t[::-1] for t in lifted]

    tris = lay(front, 1) + lay(back, -1)

    # Every edge the flat triangulation uses once is a rim of the material: the
    # outside of the slab, or the inside of a hole. Both want the same wall, and
    # both have the material on their left, so the outward side is the right-hand
    # perpendicular either way. Walling from the edge list rather than from the
    # hole list is what keeps the slab's own perimeter from being left open.
    for p, q in _rim(flat):
        du, dv = q[0] - p[0], q[1] - p[1]
        outward = lift(dv, -du, 0.0)
        pf, pb = lift(*p, front), lift(*p, back)
        qf, qb = lift(*q, front), lift(*q, back)
        tris += orient([(pf, qb, pb), (pf, qf, qb)], lambda _c, w=outward: w)
    return tris


def _rim(flat):
    """The directed edges of a triangulation that no opposite edge answers."""
    seen = set()
    for t in flat:
        for i in range(3):
            seen.add((t[i], t[(i + 1) % 3]))
    return [e for e in seen if (e[1], e[0]) not in seen]


# --- checks ---------------------------------------------------------------------

def verify(tris, expected_volume, name):
    """Refuse to write a mesh that is not closed or is inside out."""
    edges = {}
    vol = 0.0
    for a, b, c in tris:
        vol += (a[0] * (b[1] * c[2] - c[1] * b[2])
                - a[1] * (b[0] * c[2] - c[0] * b[2])
                + a[2] * (b[0] * c[1] - c[0] * b[1])) / 6.0
        for p, q in ((a, b), (b, c), (c, a)):
            edges[(p, q)] = edges.get((p, q), 0) + 1
    bad = sum(1 for (p, q), n in edges.items()
              if n != 1 or edges.get((q, p), 0) != 1)
    assert bad == 0, f"{name}: {bad} unpaired edges, surface is not closed"
    err = abs(vol - expected_volume) / expected_volume
    assert err < 0.002, f"{name}: volume {vol:.1f} mm3, expected {expected_volume:.1f}"
    print(f"  {name:<16} {len(tris):>6} triangles, closed, {vol / 1000:6.2f} cm3, "
          f"{err * 100:.3f}% off analytic")
    return vol


def write_stl(path, solids):
    """Write every shell into ONE solid block.

    A part built from several closed surfaces must still arrive as a single named
    solid. Plenty of viewers - Windows 3D Viewer among them - read only the first
    `solid` of a multi-solid ASCII STL and silently draw a fraction of the part,
    which is how a two-piece L bracket came back looking like a flat plate. Slicers
    union interpenetrating surfaces inside one solid perfectly well.
    """
    name = os.path.splitext(os.path.basename(path))[0]
    out = [f"solid {name}"]
    for _, tris in solids:
        for a, b, c in tris:
            n = cross(sub(b, a), sub(c, a))
            m = math.sqrt(dot(n, n)) or 1.0
            out.append(f"  facet normal {n[0] / m:.6f} {n[1] / m:.6f} {n[2] / m:.6f}")
            out.append("    outer loop")
            for p in (a, b, c):
                out.append(f"      vertex {p[0]:.4f} {p[1]:.4f} {p[2]:.4f}")
            out.append("    endloop")
            out.append("  endfacet")
    out.append(f"endsolid {name}")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


# --- parts ----------------------------------------------------------------------

def plate_holes():
    holes = [hole_round(x, y, D_PI) for x in PI_X for y in PI_Y]
    holes += [hole_round(EXP_X0 + dx, EXP_Y0 + dy, D_EXP)
              for dx in (0, EXP_DX) for dy in (0, EXP_DY)]
    holes += [hole_round(x, y, D_M2) for x in GRID_X for y in GRID_Y]
    holes += [hole_round(x, y, D_M2) for x in RAIL_X for y in RAIL_Y]
    holes += [hole_round(x, y, D_M2) for x in BAR_X for y in BAR_Y]
    return holes


def build_plate():
    holes = plate_holes()
    tris = slab('z', 0.0, PLATE_T, 0, PLATE_W, 0, PLATE_H, holes)
    area = PLATE_W * PLATE_H - sum(ring_area(h[4]) for h in holes)
    verify(tris, area * PLATE_T, "plate")
    return tris, holes


def build_bracket():
    """A C, open at the bottom: upright, shelf across the top, hood down the front.

    Three slabs overlapping at the corners rather than one welded solid; each shell is
    closed and they arrive in a single solid block, which slicers union. Print it
    standing on one end, so the profile is flat on the bed and nothing overhangs.
    """
    bolts = [hole_round(x, y, D_M2) for x in BR_BOLT_X for y in BR_BOLT_Y]

    # Board centred across the shelf, its long axis across the plate and the connector
    # end to the left, so the cable leaves towards the expansion board. Out from the
    # plate it sits as far forward as the screw heads on its outer ears allow, which
    # keeps the sensor as close to the hood as it can be.
    cx = BR_W / 2
    cz = BR_D - BR_T - BR_HEAD_CLEAR - PIR_W / 2
    pir = [hole_round(cx + dx, cz + dz, D_M2) for dx, dz in PIR_HOLES]

    upright = slab('z', 0.0, BR_T, 0, BR_W, 0, BR_H, bolts)
    v = (BR_W * BR_H - sum(ring_area(h[4]) for h in bolts)) * BR_T
    verify(upright, v, "bracket upright")

    shelf = slab('y', BR_H - BR_T, BR_T, 0, BR_W, 0, BR_D, pir)
    v = (BR_W * BR_D - sum(ring_area(h[4]) for h in pir)) * BR_T
    verify(shelf, v, "bracket shelf")

    hood = slab('z', BR_D - BR_T, BR_T, 0, BR_W, 0, BR_H, [])
    verify(hood, BR_W * BR_H * BR_T, "bracket hood")

    print(f"  bracket {BR_W:.0f} x {BR_H:.0f} x {BR_D:.0f} mm, "
          f"PIR holes at shelf x {cx - 10:.0f} and {cx + 20:.0f}, "
          f"board centre {cz:.1f} out, channel {BR_D - 2 * BR_T:.0f} wide")
    return [("pir_bracket_upright", upright), ("pir_bracket_shelf", shelf),
            ("pir_bracket_hood", hood)]


def build_cradle():
    """A frame the Vision AI enclosure drops into, bolted to the plate's grid.

    Mounted with the hinge end down, so the camera head swings out and looks at the
    drawers. That fixes the orientation: the hinge pivots about the enclosure's 31.2 mm
    axis, so that axis has to be horizontal for the head to tilt up and down at all.

    Open at the top, because the enclosure has no step anywhere on it to grip - it is a
    plain rounded box - so it has to go in from somewhere. It drops down past the side
    lips, and the bottom wall takes its weight. The lips run the full height rather
    than reaching over the top, since the load that matters is the head hanging forward
    and trying to lever the box off the plate, and the sides resist that everywhere.
    The bottom carries no lip: that is the end the hinge knuckle sticks out of.

    Screws go in from behind the back plate and self-tap into the floor, which is why
    the floor has 1.7 mm pilots rather than clearance holes. Nothing then stands proud
    inside the pocket for the enclosure to rock on. Use M2 x 5; M2 x 6 reaches through.
    """
    pw, ph = ENC_W + ENC_FIT, ENC_H + ENC_FIT      # pocket
    w = pw + 2 * CR_WALL                           # outer, open at the top
    h = ph + CR_WALL
    top = CR_FLOOR + ENC_D                         # where the lips catch

    cx = w / 2
    pilots = [hole_round(cx + sx * CR_BOLT_DX / 2, CR_PILOT_Y0 + k * CR_BOLT_DY,
                         CR_PILOT)
              for sx in (-1, 1) for k in (0, 1)]

    shells = [
        ("cradle_floor", slab('z', 0.0, CR_FLOOR, 0, w, 0, h, pilots),
         (w * h - sum(ring_area(x[4]) for x in pilots)) * CR_FLOOR),
        ("cradle_wall_left", slab('z', CR_FLOOR, ENC_D, 0, CR_WALL, 0, h, []),
         CR_WALL * h * ENC_D),
        ("cradle_wall_right", slab('z', CR_FLOOR, ENC_D, w - CR_WALL, w, 0, h, []),
         CR_WALL * h * ENC_D),
        ("cradle_wall_bottom", slab('z', CR_FLOOR, ENC_D, 0, w, 0, CR_WALL, []),
         w * CR_WALL * ENC_D),
        ("cradle_lip_left", slab('z', top, CR_LIP_T, 0, CR_WALL + CR_LIP, 0, h, []),
         (CR_WALL + CR_LIP) * h * CR_LIP_T),
        ("cradle_lip_right",
         slab('z', top, CR_LIP_T, w - CR_WALL - CR_LIP, w, 0, h, []),
         (CR_WALL + CR_LIP) * h * CR_LIP_T),
    ]
    out = []
    for name, tris, vol in shells:
        verify(tris, vol, name.replace("cradle_", "cradle "))
        out.append((name, tris))
    print(f"  cradle outer {w:.1f} x {h:.1f} x {top + CR_LIP_T:.1f} mm, "
          f"pocket {pw:.1f} x {ph:.1f}, pilots {CR_BOLT_DX:.0f} x {CR_BOLT_DY:.0f} apart")
    return out


def build_bar():
    """One end bar: two magnets, two bolts, printed twice.

    Three stacked slabs rather than one solid, because both features are blind and
    slab() only cuts holes that run right through: the pockets open on the toolbox
    face, the pilots on the plate face, and neither reaches the other side. The
    layers abut on the two z planes where a feature starts or stops, which is how
    the cradle is built as well.

    Local coordinates are the plate's own: v runs up the plate, so MB_BOLT_Y can be
    read straight off the grid rows the bolts land on.
    """
    u = MB_W / 2
    pockets = [hole_round(u, v, MB_POCKET_D)
               for v in (MB_MAG_INSET, MB_H - MB_MAG_INSET)]
    pilots = [hole_round(u, v, MB_PILOT) for v in MB_BOLT_Y]
    pilot_z = MB_T - MB_PILOT_DEPTH

    out = []
    for name, z0, z1, holes in [
        ("bar_face", 0.0, pilot_z, pockets),
        ("bar_mid", pilot_z, MB_POCKET_DEPTH, pockets + pilots),
        ("bar_back", MB_POCKET_DEPTH, MB_T, pilots),
    ]:
        tris = slab('z', z0, z1 - z0, 0, MB_W, 0, MB_H, holes)
        area = MB_W * MB_H - sum(ring_area(h[4]) for h in holes)
        verify(tris, area * (z1 - z0), name.replace("bar_", "bar "))
        out.append((name, tris))

    print(f"  bar {MB_W:.0f} x {MB_H:.1f} x {MB_T:.1f} mm, print 2: magnets at "
          f"y {MB_MAG_INSET:.0f} and {MB_H - MB_MAG_INSET:.1f}, bolts on columns "
          f"{MB_X[0]:.0f} and {MB_X[1]:.0f}, rows {MB_BOLT_Y[0]:.0f} "
          f"and {MB_BOLT_Y[1]:.0f}")
    return out


def prism(profile, x0, x1):
    """A convex (y, z) polygon extruded along x from x0 to x1.

    slab() only makes rectangles, and the foot's pieces are a triangle and two
    leaning quads. Convex is enough if the foot is built from pieces the way the
    cradle is, with the slot being the gap left between them.
    """
    cy = sum(p[0] for p in profile) / len(profile)
    cz = sum(p[1] for p in profile) / len(profile)
    cx = (x0 + x1) / 2
    n = len(profile)
    tris = []
    for x in (x0, x1):
        tris += [((x, *profile[0]), (x, *profile[i]), (x, *profile[i + 1]))
                 for i in range(1, n - 1)]
    for i in range(n):
        (ay, az), (by, bz) = profile[i], profile[(i + 1) % n]
        a0, a1, b0, b1 = (x0, ay, az), (x1, ay, az), (x0, by, bz), (x1, by, bz)
        tris += [(a0, b0, b1), (a0, b1, a1)]
    return orient(tris, lambda c: (c[0] - cx, c[1] - cy, c[2] - cz))


def build_foot():
    """A pad, a front lip and a back triangle, with the slot as the gap between.

    The slot's floor is flat rather than square to the plate, so the plate's bottom
    edge meets it on its back corner. At 8 degrees across a 3 mm plate that is a
    0.4 mm step, and the lean closes it the moment the plate settles back.
    """
    t = math.tan(math.radians(FOOT_TILT))
    slot = FOOT_SLOT / math.cos(math.radians(FOOT_TILT))    # measured along y
    back = FOOT_TOE + slot                                  # back of the slot, at the floor
    depth = back + FOOT_HEEL
    top_lip = FOOT_PAD + FOOT_LIP_H
    top_brace = FOOT_PAD + FOOT_BRACE_H

    pieces = [
        ("foot_pad", [(0, 0), (depth, 0), (depth, FOOT_PAD), (0, FOOT_PAD)]),
        ("foot_lip", [(0, FOOT_PAD), (FOOT_TOE, FOOT_PAD),
                      (FOOT_TOE + FOOT_LIP_H * t, top_lip), (0, top_lip)]),
        ("foot_brace", [(back, FOOT_PAD), (depth, FOOT_PAD),
                        (back + FOOT_BRACE_H * t, top_brace)]),
    ]
    out = []
    for name, profile in pieces:
        tris = prism(profile, 0.0, FOOT_L)
        verify(tris, ring_area(profile) * FOOT_L, name.replace("foot_", "foot "))
        out.append((name, tris))

    print(f"  foot {FOOT_L:.0f} x {depth:.1f} x {top_brace:.1f} mm, print 2: "
          f"{FOOT_TILT:.0f} deg lean, {FOOT_SLOT} slot, feet at plate x "
          f"{FOOT_X[0][0]:.0f}-{FOOT_X[0][1]:.0f} and {FOOT_X[1][0]:.0f}-{FOOT_X[1][1]:.0f}")
    return out


def write_scad(path):
    with open(path, "w") as f:
        f.write(f"""// SmartToolbox back plate, v6.
// Regenerate the STL from here once OpenSCAD is installed, or run build_plate.py,
// which is what actually produced the shipped mesh. Keep the two in step.
// Y = 0 is the bottom edge: the one the LED strip and the PIR look down from.

plate_w = {PLATE_W}; plate_h = {PLATE_H}; plate_t = {PLATE_T};
d_m2 = {D_M2};          // M2 clearance, the whole component grid
d_pi = {D_PI};          // Pi Zero standoffs
d_exp = {D_EXP};         // the board's own holes are 3.0; this adds print slack

pi_x = [{PI_X[0]}, {PI_X[1]}];
pi_y = [{PI_Y[0]}, {PI_Y[1]}];

exp_x0 = {EXP_X0}; exp_y0 = {EXP_Y0:.2f};   // XIAO Expansion Board Base
exp_dx = {EXP_DX}; exp_dy = {EXP_DY};       // hole centres, in a {EXP_W} x {EXP_H} board

grid_x = [for (i = [0:6]) {GRID_X[0]} + 10 * i];   // v4's left 8 columns removed
grid_y = [for (i = [0:6]) {GRID_Y[0]} + 10 * i];
rail_x = [for (i = [0:{len(RAIL_X) - 1}]) {RAIL_X[0]} + 10 * i];   // bottom two rows only
rail_y = [{RAIL_Y[0]}, {RAIL_Y[1]}];
bar_x = [{BAR_X[0]}];   // the left magnet bar; the right one reuses column {MB_X[1]:.0f}
bar_y = [{BAR_Y[0]}, {BAR_Y[1]}];

module holes() {{
    for (x = pi_x, y = pi_y) translate([x, y]) circle(d = d_pi, $fn = {SEG});
    for (dx = [0, exp_dx], dy = [0, exp_dy])
        translate([exp_x0 + dx, exp_y0 + dy]) circle(d = d_exp, $fn = {SEG});
    for (x = grid_x, y = grid_y) translate([x, y]) circle(d = d_m2, $fn = {SEG});
    for (x = rail_x, y = rail_y) translate([x, y]) circle(d = d_m2, $fn = {SEG});
    for (x = bar_x, y = bar_y) translate([x, y]) circle(d = d_m2, $fn = {SEG});
}}

linear_extrude(plate_t) difference() {{
    square([plate_w, plate_h]);
    holes();
}}
""")


def write_svg(path, holes):
    m = 18
    body = []
    for cx, cy, r, _hv, _ring in holes:
        if EXP_X0 - 1 <= cx <= EXP_X0 + EXP_DX + 1:
            cls = "exp"          # tested first: wider than the Pi's holes now
        elif r > 1.5:
            cls = "pi"
        else:
            cls = "m2"
        body.append(f'<circle cx="{cx:.2f}" cy="{PLATE_H - cy:.2f}" r="{r:.2f}" '
                    f'class="{cls}"/>')
    with open(path, "w") as f:
        f.write(f'''<svg xmlns="http://www.w3.org/2000/svg" \
viewBox="{-m} {-m} {PLATE_W + 2 * m} {PLATE_H + 2 * m}" width="1100">
<style>
 .plate{{fill:#8d8d8d;stroke:#3a3a3a;stroke-width:.6}}
 .m2{{fill:#fff;stroke:#3a3a3a;stroke-width:.3}}
 .pi{{fill:#fff;stroke:#1d6f42;stroke-width:.7}}
 .exp{{fill:#fff;stroke:#b3261e;stroke-width:.8}}
 .out{{fill:none;stroke-width:.5;stroke-dasharray:2 1.5}}
 text{{font:4px system-ui,sans-serif;fill:#222}}
 .k{{font:3.3px system-ui,sans-serif}}
</style>
<rect width="{PLATE_W}" height="{PLATE_H}" class="plate"/>
<rect x="4.5" y="{PLATE_H - 70.6}" width="30" height="65" class="out" stroke="#1d6f42"/>
<rect x="{EXP_X0 - (EXP_W - EXP_DX) / 2}" y="{PLATE_H - EXP_Y0 - EXP_DY - (EXP_H - EXP_DY) / 2}" \
width="{EXP_W}" height="{EXP_H}" class="out" stroke="#b3261e"/>
<rect x="{MB_X[0] - MB_W / 2}" y="0" width="{MB_W}" height="{PLATE_H}" class="out" stroke="#6d28d9"/>
<rect x="{MB_X[1] - MB_W / 2}" y="0" width="{MB_W}" height="{PLATE_H}" class="out" stroke="#6d28d9"/>
<rect x="{BRACKET_X}" y="{PLATE_H - BR_H}" width="{BR_W}" height="{BR_H}" \
class="out" stroke="#1a56db"/>
{chr(10).join(body)}
<text x="{PLATE_W / 2}" y="-7" text-anchor="middle">back plate v6 \
- {PLATE_W} x {PLATE_H} x {PLATE_T} mm - bottom edge at the foot of this drawing</text>
<text x="0" y="{PLATE_H + 8}" class="k" fill="#1d6f42">Pi Zero, 3.2 mm, unchanged</text>
<text x="{EXP_X0 - 2}" y="{PLATE_H + 8}" class="k" fill="#b3261e">expansion base, \
{EXP_DX:.0f} x {EXP_DY:.0f} holes at {D_EXP}, board {EXP_W} x {EXP_H}</text>
<text x="{BRACKET_X}" y="{PLATE_H + 8}" class="k" fill="#1a56db">PIR bracket, \
slides along the grid</text>
<text x="{MB_X[0] - MB_W / 2}" y="{PLATE_H + 13}" class="k" fill="#6d28d9">magnet bars, on the back face</text>
<text x="{PLATE_W}" y="{PLATE_H + 13}" text-anchor="end" class="k">\
grid 7 columns to {GRID_X[-1]:.0f}; bottom two rows on to {RAIL_X[-1]:.0f}</text>
</svg>
''')


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    print("building:")
    plate, holes = build_plate()
    bracket = build_bracket()
    cradle = build_cradle()
    bar = build_bar()
    foot = build_foot()
    write_stl(os.path.join(here, "mounting_plate_v6.stl"),
              [("back_plate_v6", plate)])
    write_stl(os.path.join(here, "pir_bracket.stl"), bracket)
    write_stl(os.path.join(here, "vision_cradle.stl"), cradle)
    write_stl(os.path.join(here, "magnet_bar.stl"), bar)
    write_stl(os.path.join(here, "foot.stl"), foot)
    write_scad(os.path.join(here, "mounting_plate.scad"))
    write_svg(os.path.join(here, "mounting_plate_v6.svg"), holes)
    print(f"  plate carries {len(holes)} holes: "
          f"{len(GRID_X) * len(GRID_Y)} grid, {len(RAIL_X) * len(RAIL_Y)} rail, "
          f"{len(BAR_X) * len(BAR_Y)} left bar, 4 Pi, 4 expansion")
    print("wrote mounting_plate_v6.stl, pir_bracket.stl, vision_cradle.stl, "
          "magnet_bar.stl, foot.stl, mounting_plate.scad, mounting_plate_v6.svg")
