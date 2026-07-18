# W4JB Field Day Section Map

An interactive, browser-based replay of the W4JB (Fayette County ARC) ARRL
Field Day 2026 log, shaded by ARRL/RAC section. Static site — no server, no
build step. Open `index.html` in a browser, or deploy the folder as-is to any
static host (GitHub Pages, Cloudflare Pages, Netlify).

## What's here

| Path | Role |
|---|---|
| `index.html` | The map application |
| `about.html` | Methodology, data sources, and known limitations |
| `style.css`, `app.js` | Front-end (vanilla JS + D3 v7) |
| `vendor/d3.v7.min.js` | Vendored D3 (works offline) |
| `data/contacts.json` | Pre-processed QSO records: timestamp, call, band, mode, section |
| `data/arrl_sections.geojson` | ARRL/RAC section boundary polygons |
| `data/section_names.json` | Section abbreviation → full name |

## Running locally

Just open `index.html`. If your browser blocks `fetch()` of the local JSON
files (some do for `file://`), serve the folder over HTTP instead:

```
python -m http.server 8000
# then open http://localhost:8000
```

## Data

`data/contacts.json` contains only the fields the map needs — contact
timestamp, worked callsign, band, mode, and ARRL section. See `about.html`
for how the section boundary file was built and its documented
simplifications.

Boundary data: US Census Bureau (public domain) and Natural Earth (public
domain). Built with D3 v7.
