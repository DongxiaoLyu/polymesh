# PolyMesh — VEM Preprocessor

An interactive, browser-based preprocessor for **Virtual Element Method (VEM)** analysis.
Draw a 2D domain, generate a conforming polygonal mesh, apply boundary conditions,
and export a ready-to-run input file. No installation, no server — everything runs
locally in your browser.

## Features

- **Domain input** — click-to-point, freehand sketching, or import a hand-drawn image
  (filled shapes and stroke outlines are detected automatically)
- **Meshing** — square, equilateral-triangle, and hexagonal tilings; interior cells are
  kept intact while boundary cells are clipped to the domain; nodes are color-coded by
  provenance
- **Boundary conditions** — point loads, distributed loads (on any mesh edge),
  fixed and hinge supports; groups can be named, colored, and edited
- **Inspection** — scroll to zoom in/out (centered on the cursor, up to 32×);
  zoom-out is clamped at 1× so the view never shows beyond the drawing area,
  and the background lattice always fills the view; **Reset View** restores it
- **Export** — a single TXT file containing nodes, elements, loads, and supports

## Quick start

Open the live site:

```
https://DongxiaoLyu.github.io/polymesh/
```

Or run it locally: clone the repository and open `index.html` in any modern browser —
no build step required.

### Workflow

1. **Draw the domain** — place a closed polygon with clicks, sketch it freehand,
   or click **Import** in the Draw Mode panel to load an image.
2. **Tune the mesh** — choose the grid type (square / triangular / hexagonal)
   and adjust the cell size.
3. **Set boundary conditions** — click **Set BCs** (the mesh becomes locked), then
   use the panel:
   - *Point Load / Support* — click nodes or drag a box to select several, press
     Enter, then name the group and enter the load vector (or pick Fixed / Hinge).
   - *Distributed Load* — click or box-select mesh edges, then name the group and
     enter the vector (per unit length, FEM convention: **+X right, +Y up**).
4. **Export** — click **Export TXT** to download `mesh.txt`.

## Output format

- **Coordinates**, uniformly scaled and centered into a
  **100 × 100** box, aspect ratio preserved
- **Elements are counter-clockwise** (positive Jacobian)
- Sections: `# NODES`, `# ELEMENTS`, `# POINT LOADS`, `# DISTRIBUTED LOADS`,
  `# SUPPORTS`; all node/edge ids are 1-based
- Loads/supports use a group-block layout: a header line with the name (+ type) and
  member count, one line per member, then the vector line (loads only)

## License

[MIT](LICENSE)
