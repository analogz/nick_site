#!/usr/bin/env python3
"""2D effective-index FDTD of a smooth multi-turn SOI route at 1310 nm.

Exports a web-ready complex field texture plus geometry metadata for the
homepage animation. Uses Meep from the photonics-fdtd conda environment.
"""

from __future__ import annotations

import argparse
import json
import math
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image


WAVELENGTH_UM = 1.310
WG_WIDTH_UM = 0.450
N_CORE = 2.85  # TE slab effective index proxy for 220 nm SOI
N_CLAD = 1.444
ROUTE_SEED = 3
RESOLUTION = 22
PML_UM = 1.2
EXPORT_WIDTH = 900

R_MIN_UM = 1.0
EULER_FRACTION = 0.3  # share of the 90° turn spent in clothoid transitions
# The snake fills a lattice as a single Hamiltonian path, so it visits every
# cell exactly once and reads as a dense maze.
GRID_COLS = 10
GRID_ROWS = 9
CELL_PITCH_UM = 3.4  # lattice spacing; must clear two corner offsets per cell
MIX_PASSES = 60  # backbite moves per cell used to randomize the path
LEAD_UM = 2.6
SAMPLE_UM = 0.04  # centerline sampling used for the outline polygon
CYLINDER_PITCH_UM = 0.1  # spacing of the discs that fill in each corner
OUTLINE_TOLERANCE_UM = 0.010  # max chord error of the exported outline stroke


@dataclass
class Route:
    """Sampled centerline plus the pieces used to build Meep geometry."""

    x: np.ndarray
    y: np.ndarray
    cell: tuple[float, float] = (0.0, 0.0)
    straights: list[tuple[tuple[float, float], tuple[float, float]]] = field(default_factory=list)
    bends: list[np.ndarray] = field(default_factory=list)
    info: dict = field(default_factory=dict)


def euler_bend_90(
    r_min: float,
    euler_fraction: float = EULER_FRACTION,
    count: int = 400,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Partial-Euler 90° corner starting at the origin along +x.

    Curvature ramps linearly to 1/r_min, holds through a circular arc, then
    ramps back to zero. Returns local left-turn coordinates plus the offset the
    corner consumes along each leg of the right angle it replaces.
    """
    if not 0.0 < euler_fraction <= 1.0:
        raise ValueError("euler_fraction must lie in (0, 1]")

    turn = 0.5 * math.pi
    ramp = euler_fraction * turn * r_min
    arc = (1.0 - euler_fraction) * turn * r_min
    total = 2.0 * ramp + arc
    s = np.linspace(0.0, total, count)
    kappa = np.clip(np.minimum(s, total - s) / ramp, 0.0, 1.0) / r_min

    ds = np.diff(s)
    theta = np.concatenate([[0.0], np.cumsum(0.5 * (kappa[:-1] + kappa[1:]) * ds)])
    mid = 0.5 * (theta[:-1] + theta[1:])
    x = np.concatenate([[0.0], np.cumsum(np.cos(mid) * ds)])
    y = np.concatenate([[0.0], np.cumsum(np.sin(mid) * ds)])
    return x, y, float(x[-1])


Cell = tuple[int, int]


def _grid_neighbors(cols: int, rows: int) -> dict[Cell, list[Cell]]:
    nbrs: dict[Cell, list[Cell]] = {}
    for c in range(cols):
        for r in range(rows):
            adj = []
            if c > 0:
                adj.append((c - 1, r))
            if c < cols - 1:
                adj.append((c + 1, r))
            if r > 0:
                adj.append((c, r - 1))
            if r < rows - 1:
                adj.append((c, r + 1))
            nbrs[(c, r)] = adj
    return nbrs


def _boustrophedon(cols: int, rows: int) -> list[Cell]:
    """A trivial Hamiltonian path to seed the shuffle: v0=(0,0), v1=(1,0)."""
    path: list[Cell] = []
    for r in range(rows):
        columns = range(cols) if r % 2 == 0 else range(cols - 1, -1, -1)
        path.extend((c, r) for c in columns)
    return path


def _maze_waypoints(rng: np.random.Generator, offset: float) -> list[tuple[float, float]]:
    """Corners of a space-filling maze: one Hamiltonian path over a lattice.

    Starting from a boustrophedon path, the *backbite* move repeatedly reforms
    the free (tail) end: pick a grid-neighbour of the tail, add that edge, and
    drop the edge it duplicates. Every move keeps the path Hamiltonian, so the
    strand still visits each cell once and can never cross itself — it just
    stops looking like tidy rows. The head (input) is pinned to (0,0) heading
    east; we stop once the tail lands on a border cell pointing straight out,
    so both leads can exit cleanly through the PML.
    """
    cols, rows = GRID_COLS, GRID_ROWS
    min_run = 2.0 * offset + 0.5
    if CELL_PITCH_UM < min_run:
        raise ValueError(
            f"corners need {min_run:.2f} µm of straight run but the lattice "
            f"pitch is only {CELL_PITCH_UM:.2f} µm"
        )

    nbrs = _grid_neighbors(cols, rows)
    path = _boustrophedon(cols, rows)
    pos = {cell: i for i, cell in enumerate(path)}
    length = len(path)

    def tail_exit(current: list[Cell]) -> tuple[int, int] | None:
        (cx, cy), (px, py) = current[-1], current[-2]
        d = (cx - px, cy - py)
        outward = (
            (cx == cols - 1 and d == (1, 0))
            or (cy == rows - 1 and d == (0, 1))
            or (cy == 0 and d == (0, -1))
        )
        return d if outward and current[-1] != current[0] else None

    warmup = 15 * length
    exit_dir: tuple[int, int] | None = None
    for step in range(MIX_PASSES * length):
        tail = path[-1]
        adj = nbrs[tail]
        j = pos[adj[int(rng.integers(len(adj)))]]
        # j == 0 would unpin the head; j >= length-2 is a no-op (already joined).
        if 0 < j < length - 2:
            path[j + 1 :] = path[j + 1 :][::-1]
            for idx in range(j + 1, length):
                pos[path[idx]] = idx
        if step >= warmup:
            exit_dir = tail_exit(path)
            if exit_dir is not None:
                break
    if exit_dir is None:
        raise ValueError("no clean maze exit found; try another route seed")

    points = [(c * CELL_PITCH_UM, r * CELL_PITCH_UM) for c, r in path]
    # Straight leads: the input heads west out of (0,0); the output follows
    # whichever wall the tail reached. Simplifying folds each into its run.
    points.insert(0, (points[0][0] - LEAD_UM, points[0][1]))
    points.append(
        (
            points[-1][0] + exit_dir[0] * LEAD_UM,
            points[-1][1] + exit_dir[1] * LEAD_UM,
        )
    )
    return _drop_straight_through(points)


def _drop_straight_through(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Keep only endpoints and true direction changes."""
    kept = [points[0]]
    for previous, current, following in zip(points, points[1:], points[2:]):
        into = (current[0] - previous[0], current[1] - previous[1])
        out_of = (following[0] - current[0], following[1] - current[1])
        turning = abs(into[0] * out_of[1] - into[1] * out_of[0]) > 1e-9
        if turning:
            kept.append(current)
    kept.append(points[-1])
    return kept


def _simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    """Ramer–Douglas–Peucker decimation.

    Uniform decimation has to be tuned for the tightest corner or it facets it;
    this drops only vertices that sit within `tolerance` of the chord they span,
    so long straights collapse to two points while bends keep their curvature.
    """
    if len(points) < 3:
        return list(points)

    pts = np.asarray(points, dtype=float)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        chord = pts[hi] - pts[lo]
        span = math.hypot(chord[0], chord[1])
        rel = pts[lo + 1 : hi] - pts[lo]
        if span < 1e-12:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            dist = np.abs(rel[:, 0] * chord[1] - rel[:, 1] * chord[0]) / span
        worst = int(np.argmax(dist))
        if dist[worst] > tolerance:
            split = lo + 1 + worst
            keep[split] = True
            stack.append((lo, split))
            stack.append((split, hi))
    return [(float(px), float(py)) for px, py in pts[keep]]


def _resample(x: np.ndarray, y: np.ndarray, spacing: float) -> tuple[np.ndarray, np.ndarray]:
    step = np.hypot(np.diff(x), np.diff(y))
    keep = np.concatenate([[True], step > 1e-9])
    x, y = x[keep], y[keep]

    s = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    count = max(2, round(s[-1] / spacing) + 1)
    uniform = np.linspace(0.0, s[-1], count)
    return np.interp(uniform, s, x), np.interp(uniform, s, y)


def build_route(seed: int = ROUTE_SEED) -> Route:
    """Snake-style route with right-angle corners rounded by Euler bends."""
    rng = np.random.default_rng(seed)
    bend_x, bend_y, offset = euler_bend_90(R_MIN_UM)
    points = _maze_waypoints(rng, offset)

    # Every corner eats `offset` from both of its legs; the leads have one each.
    last_corner = len(points) - 2
    for index, (a, b) in enumerate(zip(points, points[1:])):
        corners = sum(1 for end in (index, index + 1) if 1 <= end <= last_corner)
        needed = corners * offset + 0.5
        run = math.hypot(b[0] - a[0], b[1] - a[1])
        if run < needed:
            raise ValueError(
                f"run {index} is {run:.2f} µm but needs {needed:.2f} µm for "
                f"{corners} × {offset:.2f} µm corner offset"
            )

    xs: list[np.ndarray] = []
    ys: list[np.ndarray] = []
    straights: list[tuple[tuple[float, float], tuple[float, float]]] = []
    bends: list[np.ndarray] = []
    cursor = np.asarray(points[0], dtype=float)

    for corner_pt, next_pt in zip(points[1:-1], points[2:]):
        corner = np.asarray(corner_pt, dtype=float)
        following = np.asarray(next_pt, dtype=float)
        incoming = corner - cursor
        incoming /= np.linalg.norm(incoming)
        outgoing = following - corner
        outgoing /= np.linalg.norm(outgoing)

        start = corner - offset * incoming
        xs.append(np.array([cursor[0], start[0]]))
        ys.append(np.array([cursor[1], start[1]]))
        straights.append((tuple(cursor), tuple(start)))

        left = np.array([-incoming[1], incoming[0]])
        cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0]
        if abs(cross) < 0.5:
            raise ValueError(f"waypoint {corner_pt} is not a 90° corner")
        turn_sign = math.copysign(1.0, cross)
        xs.append(start[0] + bend_x * incoming[0] + turn_sign * bend_y * left[0])
        ys.append(start[1] + bend_x * incoming[1] + turn_sign * bend_y * left[1])
        bends.append(np.column_stack(_resample(xs[-1], ys[-1], CYLINDER_PITCH_UM)))
        cursor = np.array([xs[-1][-1], ys[-1][-1]])

    end = np.asarray(points[-1], dtype=float)
    xs.append(np.array([cursor[0], end[0]]))
    ys.append(np.array([cursor[1], end[1]]))
    straights.append((tuple(cursor), tuple(end)))

    x, y = _resample(np.concatenate(xs), np.concatenate(ys), SAMPLE_UM)

    # Leave extra cladding around the route so radiated wavefronts stay visible.
    pad = PML_UM + 1.8
    shift = np.array([pad - x.min(), pad - y.min()])
    x = x + shift[0]
    y = y + shift[1]
    straights = [
        ((a[0] + shift[0], a[1] + shift[1]), (b[0] + shift[0], b[1] + shift[1]))
        for a, b in straights
    ]
    bends = [centers + shift for centers in bends]
    cell = (float(x.max() + pad), float(y.max() + pad))

    # Both leads have to reach through the PML. A waveguide that simply stops
    # inside the cladding is a cleaved facet: it reflects and sprays radiation.
    overhang = pad + 0.3
    for index, outward in ((0, 0), (-1, 1)):
        ends = list(straights[index])
        tip = np.asarray(ends[outward])
        heading = tip - np.asarray(ends[1 - outward])
        ends[outward] = tuple(tip + overhang * heading / np.linalg.norm(heading))
        straights[index] = (ends[0], ends[1])
    x = np.concatenate([[straights[0][0][0]], x, [straights[-1][1][0]]])
    y = np.concatenate([[straights[0][0][1]], y, [straights[-1][1][1]]])

    path_length = float(np.sum(np.hypot(np.diff(x), np.diff(y))))
    info = {
        "minimum_radius_um": R_MIN_UM,
        "euler_fraction": EULER_FRACTION,
        "turn_count": len(points) - 2,
        "grid_cols": GRID_COLS,
        "grid_rows": GRID_ROWS,
        "cell_pitch_um": CELL_PITCH_UM,
        "path_length_um": round(path_length, 2),
    }
    return Route(x=x, y=y, cell=cell, straights=straights, bends=bends, info=info)


def offset_polyline(x: np.ndarray, y: np.ndarray, width: float) -> list[tuple[float, float]]:
    """Build a closed polygon around a centerline with constant half-width."""
    half = 0.5 * width
    dx = np.gradient(x)
    dy = np.gradient(y)
    seg = np.hypot(dx, dy)
    seg = np.maximum(seg, 1e-12)
    nx = -dy / seg
    ny = dx / seg

    left = list(zip(x + half * nx, y + half * ny))
    right = list(zip(x - half * nx, y - half * ny))
    poly = left + right[::-1]
    return poly


def run_fdtd(output_dir: Path, resolution: int = RESOLUTION) -> dict:
    import meep as mp

    route = build_route()
    x, y = route.x, route.y
    poly = offset_polyline(x, y, WG_WIDTH_UM)

    sx, sy = route.cell
    cell = mp.Vector3(sx, sy, 0)

    # Shift to cell-centered coordinates (Meep origin at cell center)
    cx, cy = 0.5 * sx, 0.5 * sy

    # One prism spanning the whole route would be tested against every grid
    # cell; axis-aligned blocks plus overlapping discs in the corners let Meep's
    # geometry tree reject most objects per cell instead.
    core = mp.Medium(index=N_CORE)
    geometry = []
    for (ax, ay), (bx, by) in route.straights:
        run = math.hypot(bx - ax, by - ay)
        if run <= 1e-9:
            continue
        along_x = abs(bx - ax) >= abs(by - ay)
        size = (
            mp.Vector3(run, WG_WIDTH_UM, mp.inf)
            if along_x
            else mp.Vector3(WG_WIDTH_UM, run, mp.inf)
        )
        geometry.append(
            mp.Block(
                center=mp.Vector3(0.5 * (ax + bx) - cx, 0.5 * (ay + by) - cy),
                size=size,
                material=core,
            )
        )
    for centers in route.bends:
        for px, py in centers:
            geometry.append(
                mp.Cylinder(
                    radius=0.5 * WG_WIDTH_UM,
                    height=mp.inf,
                    center=mp.Vector3(px - cx, py - cy),
                    material=core,
                )
            )

    # Launch just past the PML on the input lead, which always runs +x.
    src_x = PML_UM + 0.8 - cx
    src_y = float(route.straights[0][1][1]) - cy
    sources = [
        mp.EigenModeSource(
            src=mp.GaussianSource(frequency=1.0 / WAVELENGTH_UM, fwidth=0.08 / WAVELENGTH_UM),
            center=mp.Vector3(src_x, src_y),
            size=mp.Vector3(0, 2.2 * WG_WIDTH_UM),
            eig_band=1,
            direction=mp.NO_DIRECTION,
            eig_kpoint=mp.Vector3(1, 0),
            eig_parity=mp.NO_PARITY,
            eig_match_freq=True,
        )
    ]

    sim = mp.Simulation(
        cell_size=cell,
        boundary_layers=[mp.PML(PML_UM)],
        geometry=geometry,
        sources=sources,
        resolution=resolution,
        default_material=mp.Medium(index=N_CLAD),
        force_complex_fields=False,
    )

    # DFT of Ez over the non-PML region (2D TE: Ez out of plane)
    monitor_size = mp.Vector3(sx - 2.2 * PML_UM, sy - 2.2 * PML_UM)
    dft = sim.add_dft_fields(
        [mp.Ez],
        1.0 / WAVELENGTH_UM,
        0,
        1,
        center=mp.Vector3(),
        size=monitor_size,
    )

    # Watch the interior end of the output lead, wherever the maze exits. The
    # long route has a slow tail, so 1e-5 is enough for a converged DFT.
    out_ix, out_iy = route.straights[-1][0]
    decay_pt = mp.Vector3(out_ix - cx, out_iy - cy)
    sim.run(
        until_after_sources=mp.stop_when_fields_decayed(30, mp.Ez, decay_pt, 1e-5)
    )

    eps = np.asarray(
        sim.get_array(center=mp.Vector3(), size=monitor_size, component=mp.Dielectric)
    ).T
    field = np.asarray(sim.get_dft_array(dft, mp.Ez, 0)).T

    # Physical extent of exported array
    extent = {
        "xmin_um": -0.5 * monitor_size.x,
        "xmax_um": 0.5 * monitor_size.x,
        "ymin_um": -0.5 * monitor_size.y,
        "ymax_um": 0.5 * monitor_size.y,
    }

    # Normalize complex field
    amp = np.abs(field)
    peak = float(np.percentile(amp, 99.5)) or 1.0
    field = field / peak

    # Downsample for web
    from scipy.ndimage import zoom

    export_height = max(240, round(EXPORT_WIDTH * monitor_size.y / monitor_size.x))
    zoom_y = export_height / field.shape[0]
    zoom_x = EXPORT_WIDTH / field.shape[1]
    field_ds = zoom(field.real, (zoom_y, zoom_x), order=1) + 1j * zoom(
        field.imag, (zoom_y, zoom_x), order=1
    )
    # Soft mask so waveguide edges antialias cleanly in WebGL
    eps_ds = zoom(eps.astype(np.float32), (zoom_y, zoom_x), order=1)
    eps_lo = N_CLAD**2
    eps_hi = N_CORE**2
    mask = np.clip((eps_ds - eps_lo) / max(eps_hi - eps_lo, 1e-6), 0.0, 1.0)

    # Encode RGBA PNG: R=Re, G=Im mapped to [0,1], B=mask, A=normalized |E|
    re = np.clip(0.5 * (field_ds.real + 1.0), 0.0, 1.0)
    im = np.clip(0.5 * (field_ds.imag + 1.0), 0.0, 1.0)
    # No alpha: |E| is just hypot(Re, Im), so the shader derives it and the
    # texture stays a third smaller.
    rgb = np.dstack(
        [
            (re * 255).astype(np.uint8),
            (im * 255).astype(np.uint8),
            (mask * 255).astype(np.uint8),
        ]
    )
    # Flip vertically so image row 0 is ymax (standard image coords → GL can flip)
    rgb = np.flipud(rgb)

    output_dir.mkdir(parents=True, exist_ok=True)
    png_path = output_dir / "soi-euler-bend-field.png"
    Image.fromarray(rgb, mode="RGB").save(png_path, optimize=True)

    # Compact binary backup: float16 interleaved Re/Im
    packed = np.empty(field_ds.size * 2, dtype=np.float16)
    packed[0::2] = field_ds.real.astype(np.float16).ravel()
    packed[1::2] = field_ds.imag.astype(np.float16).ravel()
    bin_path = output_dir / "soi-euler-bend-field.bin"
    bin_path.write_bytes(zlib.compress(packed.tobytes(), level=9))

    # Centerline in monitor coordinates for outline stroke
    cl = {
        "x_um": (x - cx).tolist(),
        "y_um": (y - cy).tolist(),
        "width_um": WG_WIDTH_UM,
    }

    # Also store outline polygon in monitor coords
    outline = [{"x": px - cx, "y": py - cy} for px, py in poly]

    meta = {
        "title": "SOI Snake route",
        "wavelength_nm": 1310,
        "platform": "SOI 220 nm",
        "waveguide_width_nm": int(WG_WIDTH_UM * 1000),
        "route_seed": ROUTE_SEED,
        **route.info,
        "n_core": N_CORE,
        "n_clad": N_CLAD,
        "solver": "Meep 2D FDTD (effective-index)",
        "resolution_px_per_um": resolution,
        "field_png": "soi-euler-bend-field.png",
        "field_bin": "soi-euler-bend-field.bin",
        "export_width": int(field_ds.shape[1]),
        "export_height": int(field_ds.shape[0]),
        "extent_um": extent,
        "centerline": cl,
        "outline": outline,
        "colormap": "RdBu divergent on Re{E exp(-iωt)}",
        "notes": (
            "Complex Ez DFT field from a CW-normalized Gaussian-pulse "
            "eigenmode launch. Animation reconstructs the harmonic field."
        ),
    }
    (output_dir / "soi-euler-bend.json").write_text(json.dumps(meta, indent=2) + "\n")

    # Slim web metadata. The stroke is drawn as straight canvas segments, so the
    # vertex budget has to follow curvature rather than arc length.
    outline_web = [
        {"x": round(px, 3), "y": round(py, 3)}
        for px, py in _simplify(
            [(p["x"], p["y"]) for p in outline], OUTLINE_TOLERANCE_UM
        )
    ]
    if outline_web[0] != outline_web[-1]:
        outline_web = outline_web + [outline_web[0]]
    web = {
        "title": meta["title"],
        "caption": (
            f"1310 nm · SOI 220 nm · {route.info['turn_count']}-turn waveguide maze "
            f"over {route.info['path_length_um']:.0f} µm · Meep FDTD"
        ),
        "wavelength_nm": 1310,
        "platform": "SOI 220 nm",
        "waveguide_width_nm": int(WG_WIDTH_UM * 1000),
        "route_seed": ROUTE_SEED,
        **route.info,
        "n_core": N_CORE,
        "n_clad": N_CLAD,
        "solver": meta["solver"],
        "field_png": "soi-euler-bend-field.png",
        "export_width": meta["export_width"],
        "export_height": meta["export_height"],
        "extent_um": extent,
        "outline": outline_web,
        "phase_speed": 2.4,
        "notes": meta["notes"],
    }
    (output_dir / "soi-euler-bend-web.json").write_text(json.dumps(web) + "\n")

    # Preview figure matching the LinkedIn aesthetic
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    colors = ["#175cc7", "#ffffff", "#d11924"]
    cmap = LinearSegmentedColormap.from_list("web_rdbu", colors, N=256)
    aspect = monitor_size.x / monitor_size.y
    fig, ax = plt.subplots(figsize=(12, 12 / aspect), facecolor="#ffffff")
    ax.set_facecolor("#ffffff")
    phase0 = field_ds.real
    vmax = float(np.percentile(np.abs(phase0), 99))
    ax.imshow(
        np.flipud(phase0),
        cmap=cmap,
        vmin=-vmax,
        vmax=vmax,
        extent=[
            extent["xmin_um"],
            extent["xmax_um"],
            extent["ymin_um"],
            extent["ymax_um"],
        ],
        interpolation="bilinear",
        origin="upper",
    )
    # Waveguide outline
    ox = [p["x"] for p in outline] + [outline[0]["x"]]
    oy = [p["y"] for p in outline] + [outline[0]["y"]]
    ax.plot(ox, oy, color="#0a0a0a", lw=0.7, alpha=0.85)
    # The leads run past the monitor, so clamp the view to the exported field.
    ax.set_xlim(extent["xmin_um"], extent["xmax_um"])
    ax.set_ylim(extent["ymin_um"], extent["ymax_um"])
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(output_dir / "soi-euler-bend-preview.png", dpi=200, bbox_inches="tight", pad_inches=0.05)
    plt.close(fig)

    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data",
    )
    parser.add_argument("--resolution", type=int, default=RESOLUTION)
    args = parser.parse_args()
    meta = run_fdtd(args.output, resolution=args.resolution)
    summary_keys = (
        "wavelength_nm",
        "route_seed",
        "turn_count",
        "minimum_radius_um",
        "export_width",
        "export_height",
        "solver",
    )
    print(json.dumps({k: meta[k] for k in summary_keys}, indent=2))


if __name__ == "__main__":
    main()
