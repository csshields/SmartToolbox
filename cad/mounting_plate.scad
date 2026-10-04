// SmartToolbox back plate, v6.
// Regenerate the STL from here once OpenSCAD is installed, or run build_plate.py,
// which is what actually produced the shipped mesh. Keep the two in step.
// Y = 0 is the bottom edge: the one the LED strip and the PIR look down from.

plate_w = 228.6; plate_h = 76.2; plate_t = 3.0;
d_m2 = 2.2;          // M2 clearance, the whole component grid
d_pi = 3.2;          // Pi Zero standoffs
d_exp = 3.4;         // the board's own holes are 3.0; this adds print slack

pi_x = [8.0, 31.0];
pi_y = [9.1, 67.1];

exp_x0 = 56.0; exp_y0 = 20.60;   // XIAO Expansion Board Base
exp_dx = 50.0; exp_dy = 35.0;       // hole centres, in a 58.0 x 42.5 board

grid_x = [for (i = [0:6]) 124.0 + 10 * i];   // v4's left 8 columns removed
grid_y = [for (i = [0:6]) 5.0 + 10 * i];
rail_x = [for (i = [0:3]) 194.0 + 10 * i];   // bottom two rows only
rail_y = [5.0, 15.0];
bar_x = [44.0];   // the left magnet bar; the right one reuses column 184
bar_y = [25.0, 45.0];

module holes() {
    for (x = pi_x, y = pi_y) translate([x, y]) circle(d = d_pi, $fn = 48);
    for (dx = [0, exp_dx], dy = [0, exp_dy])
        translate([exp_x0 + dx, exp_y0 + dy]) circle(d = d_exp, $fn = 48);
    for (x = grid_x, y = grid_y) translate([x, y]) circle(d = d_m2, $fn = 48);
    for (x = rail_x, y = rail_y) translate([x, y]) circle(d = d_m2, $fn = 48);
    for (x = bar_x, y = bar_y) translate([x, y]) circle(d = d_m2, $fn = 48);
}

linear_extrude(plate_t) difference() {
    square([plate_w, plate_h]);
    holes();
}
