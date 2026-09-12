#!/usr/bin/env electron
// Downscale + re-encode the planet hero art in assets/planets/.
//
// Gemini hands back ~2752x1536 JPEGs (often named .jfif) at ~2.8 MB each. The
// hero they land in is 680x240 CSS px with object-fit:cover, so even a 2x
// display never reads more than ~1360px of width -- and assets/ ships TWICE
// (build.extraResources copies it to resources/, build.files puts it in the
// asar), so every raw megabyte costs two in the installer.
//
// There is no ImageMagick/sharp/ffmpeg on a stock Windows box here (and
// `convert` on PATH is the NTFS converter, not ImageMagick), so this uses the
// image encoder already vendored in Electron's own runtime -- no new dependency.
//
// Run it with `npm run planets:build`. Re-running is safe: anything already at
// or under the target width is re-encoded but not upscaled.
const { app, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

const DIR     = path.join(__dirname, '..', 'assets', 'planets');
const WIDTH   = 1600;   // ~2.35x the 680px hero: covers 2x DPI with room to spare
const QUALITY = 86;
const SRC_RE  = /\.(jfif|jpe?g|png)$/i;

app.whenReady().then(() => {
  let before = 0, after = 0, failed = 0;

  const files = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter(f => SRC_RE.test(f)).sort()
    : [];

  if (!files.length) {
    console.log(`No source images in ${DIR}`);
    return app.exit(0);
  }

  for (const f of files) {
    const src = path.join(DIR, f);
    const img = nativeImage.createFromPath(src);
    const s   = img.getSize();

    // createFromPath returns an empty image rather than throwing on a format it
    // cannot decode, so an empty size is the only failure signal there is.
    if (!s.width) { console.log(`${f.padEnd(16)} DECODE FAILED (unsupported format?)`); failed++; continue; }

    const out  = s.width > WIDTH ? img.resize({ width: WIDTH, quality: 'best' }) : img;
    const buf  = out.toJPEG(QUALITY);
    const dst  = path.join(DIR, f.replace(SRC_RE, '.jpg'));
    const orig = fs.statSync(src).size;

    fs.writeFileSync(dst, buf);
    if (path.resolve(dst) !== path.resolve(src)) fs.unlinkSync(src);

    before += orig; after += buf.length;
    const o = out.getSize();
    console.log(`${f.padEnd(16)} ${`${s.width}x${s.height} -> ${o.width}x${o.height}`.padEnd(26)}` +
                `${(orig / 1024).toFixed(0)}KB -> ${(buf.length / 1024).toFixed(0)}KB`);
  }

  console.log('-'.repeat(64));
  console.log(`total ${(before / 1048576).toFixed(2)}MB -> ${(after / 1048576).toFixed(2)}MB` +
              (failed ? `  (${failed} failed)` : ''));
  app.exit(failed ? 1 : 0);
});
