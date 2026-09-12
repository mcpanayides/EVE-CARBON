# Planet hero art

High-resolution planet art for the PI colony detail panel
(`openPIDetail` in [src/func/planetary-interaction.js](../../src/func/planetary-interaction.js)).

## Filenames

One file per EVE planet type, named for the type key exactly as ESI reports it
(lowercased). These nine keys are the complete set — they mirror
`PI_PLANET_TYPE_IDS`:

```
temperate.jpg   oceanic.jpg   ice.jpg
gas.jpg         lava.jpg      barren.jpg
storm.jpg       plasma.jpg    shattered.jpg
```

`.jpg` is preferred, but `.jpeg`, `.webp`, `.png` and `.avif` are all accepted —
the loader probes those extensions in that order and takes the first hit.

A type with no file here is not an error: the panel falls back to CCP's type
icon (`images.evetech.net/types/{id}/icon?size=1024`) for that planet alone. So
art can be added or replaced one planet at a time.

## Source images and `npm run planets:build`

Drop the full-resolution originals in here under the names above and run:

```
npm run planets:build
```

That downscales anything wider than 1600px and re-encodes it to JPEG q86,
replacing the source file. It also normalises the `.jfif` extension browsers
save Gemini output under. Re-running is safe — nothing is ever upscaled.

Keep your own copies of the originals somewhere outside this folder. The script
replaces them in place, and **anything left in here ships**.

Why it matters: the raw generated set was 2752×1536 and 21.6 MB, but the hero is
680×240 CSS px with `object-fit: cover`, so even a 2× display never reads more
than ~1360px of width. After the pass the same nine images are 1.5 MB.

There is no ImageMagick, sharp or ffmpeg on a stock Windows box here — and
`convert` on PATH is Windows' own NTFS converter, not ImageMagick — so the
script uses the image encoder already inside Electron's runtime. No new
dependency, but it must run under Electron, not plain node.

## Framing

`object-fit: cover` on a 680×240 box crops a source of this aspect ratio to its
**vertical middle ~63%**; the top and bottom thirds are never seen. Keep the
planet limb and any detail worth showing in that middle band.

The panel's name and system labels sit bottom-left over a
`rgba(0,0,0,0.78) → transparent` scrim, so a darker lower-left keeps them legible.

## Why this folder

`assets/` is the app's one asset folder — it already holds the icons, the ping
sounds and the wallpaper backgrounds. It is listed in `build.extraResources`, so
a packaged build copies it to `resources/assets/`, **outside the asar**. The
renderer therefore cannot reach these files with a path relative to
`src/index.html`. Main resolves the directory instead (`process.resourcesPath`
when packaged, `__dirname` otherwise — the same two-location resolve the bundled
backgrounds use) and hands the renderer `file://` URLs over the `planet-art`
IPC.

Do **not** use `data/`: it is gitignored, so anything there ships from a local
build and is missing from every CI release. Run `git check-ignore -v <file>`
before adding any new shipped asset — the ignore patterns here are unanchored
and catch more than they look like they will. (Both checked for this folder: not
ignored, and included by the build.)
