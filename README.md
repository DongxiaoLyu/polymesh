# VEM Studio Online — VEM Preprocessor & Solver

The **web companion of the VEM Studio desktop application** — an interactive,
browser-based workbench for **Virtual Element Method (VEM)** analysis. Draw a 2D
domain, generate a conforming polygonal mesh, pick a problem (heat conduction or
plane-stress elasticity), set exactly the boundary conditions that problem
needs, solve it in the browser, inspect heatmaps and deformed plots, and export
a ready-to-run mesh file. No installation, no server — everything runs locally
in your browser.

## Features

- **Domain input** — click-to-point, freehand sketching, or import a hand-drawn image
  (filled shapes and stroke outlines are detected automatically)
- **Meshing** — square, equilateral-triangle, and hexagonal tilings; interior cells are
  kept intact while boundary cells are clipped to the domain; nodes are color-coded by
  provenance
- **One environment for every boundary condition** — pick the problem first, then the
  Model panel offers exactly the BC kinds that problem accepts:
  - *Elasticity*: point loads, uniform pressure on boundary edges (p > 0 pushes INTO
    the domain), fixed/hinge supports;
  - *Poisson*: scalar Dirichlet temperature / Neumann heat-flux groups on boundary edges;
  - groups can be named, colored, and edited; the boundary-condition controllers are shared
- **Inspection** — scroll to zoom in/out (centered on the cursor, up to 32×);
  zoom-out is clamped at 1× so the view never shows beyond the drawing area,
  and the background lattice always fills the view; **Reset View** restores it
- **Export** — a single TXT file containing nodes, elements and whatever BCs the
  current model has defined (Poisson scalar BCs get their own file sections)
- **Solver** — a top-bar workflow stepper (Draw & Mesh → Model & BC → Solve & Post)
  drives the stages; the solve stage only carries the parameters, Solve button and
  post-processing:
  - **2D Elasticity** (plane stress, VEM) — the default problem. BCs come from the
    Model stage (≥ 2 distinct support nodes required to remove rigid-body modes).
    By default the displacement / strain / von Mises heatmaps are drawn on the
    **undeformed** mesh (colour-only, nothing can blow up). A **Show deformation**
    switch turns on the classic deformed plot — the heatmap follows the displaced
    mesh while a light undeformed reference wireframe stays at the original
    position — and unlocks the logarithmic **Deformation × slider** (10⁰…10⁵,
    default ×10) whose blue track fill follows the knob.
  - **2D Poisson Equation** (heat conduction, VEM) — implemented. In the Model
    stage set scalar BCs on the domain **boundary edges** only (Dirichlet
    temperature / Neumann heat flux); unassigned edges default to **zero-flux
    Neumann (insulated)**.
  - **2D Dynamics** — planned (coming soon).

## Quick start

Open the live site:

```
https://DongxiaoLyu.github.io/polymesh/
```

(The URL keeps the repository's original `polymesh` name; the app itself is
**VEM Studio Online**.)

Or run it locally: clone the repository and open `index.html` in any modern browser —
no build step required.

### Workflow (three stages)

Follow the **O—O—O** stepper in the top bar; the active dot expands into a
labelled pill. Click a dot to jump between stages (the solver stage additionally
validates that the model is complete before entering).

1. **Draw & Mesh** — geometry and mesh only (no boundary conditions here):
   place a closed polygon with clicks, sketch it freehand, or click **Import** in
   the Draw Mode panel to load an image; tune grid type (square / triangular /
   hexagonal) and cell size.
2. **Model & BC** — the mesh is locked. Pick the **Problem** (2D Elasticity,
   2D Poisson Equation), and the panel shows the BC kinds that problem accepts:
   - *Elasticity* — **Point Load / Support**: click nodes or drag a box to select
     several, press Enter, then name the group and enter the load vector (or pick
     Fixed / Hinge). **Pressure**: click or box-select boundary edges (interior
     edges are not selectable), then name the group and enter one scalar pressure
     value — positive p pushes INTO the domain, negative pulls outward.
   - *Poisson* — **Temperature (Dirichlet) / Heat Flux (Neumann)**: boundary edges
     only; enter a name and a scalar value.
   - Switching problems clears the BCs (they are problem-specific).
3. **Solve & Post** — tune the parameters (E, ν — or k, f), pick the display
   field, press **Solve**; heatmaps, legends and the deformed plot appear here.
   The problem is locked while solving — return to the Model stage to change it.

Export is available in the first two stages: from the mesh stage it contains
nodes + elements only; from the model stage it also carries the boundary
conditions defined for the active problem.

## Output format

- **Coordinates**, uniformly scaled and centered into a
  **100 × 100** box, aspect ratio preserved
- **Elements are counter-clockwise** (positive Jacobian)
- Sections: `# NODES`, `# ELEMENTS`, `# POINT LOADS`, `# SURFACE PRESSURES`,
  `# SUPPORTS`, plus scalar sections for Poisson models such as
  `# TEMPERATURE (DIRICHLET)` / `# HEAT FLUX (NEUMANN)`; all node/edge ids are 1-based
- Loads/supports use a group-block layout: a header line with the name (+ type) and
  member count, one line per member, then the vector line (loads only)

## License

[MIT](LICENSE)
