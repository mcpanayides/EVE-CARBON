# Background wallpapers

Drop image files (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`) into this
folder and they appear automatically as presets under **Settings → Background**.

These ship with the app (bundle them in your build). Users can also add their own
at runtime via **Settings → Background → Add image…**, which copies the chosen
file into `userData/backgrounds/`.

Recommended: 1920×1080 or larger, landscape. The image is shown `cover`-fit
behind the whole UI with an adjustable dim overlay for readability.

This folder is intentionally empty by default. The default preset set is no
longer bundled here — it's fetched live from CCP's own resfile CDN and cached
under `userData/resfile-cache/` on first use instead of being duplicated in the
app bundle. See `src/resfile.js` (the CDN resolution client) and
`src/resfile_backgrounds.js` (the curated preset list + disk cache). Anything
you drop in this folder still ships as a bundled preset alongside those, same
as before.
