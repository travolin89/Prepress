# Prepress for iPad

A standalone prepress viewer and editor that runs entirely on your iPad, with no PC and no server. Your PDFs never leave the device. Once installed, it works offline.

## Install (everything from the iPad, about 10 minutes, once)
1. In the Files app, tap `prepress-ipad.zip` to unzip it.
2. In Safari, sign in at github.com (a free account is fine). Create a new **public** repository, for example `prepress`.
3. In the repository, tap **Add file → Upload files**, choose **all** the files inside the unzipped folder, then tap **Commit changes**.
4. Go to **Settings → Pages**, set Source to *Deploy from a branch*, choose `main` and `/ (root)`, then **Save**. After a minute your app is at `https://YOUR-NAME.github.io/prepress/`.
5. Open that address in Safari, then tap **Share → Add to Home Screen**.
6. Launch it once from the Home Screen while online and open a PDF. That stores the engines (about 27 MB) on the iPad. From then on it runs offline.

The website only delivers the app's code. Files you open are processed on the iPad and are never uploaded.

## Using it
- **Open**: pick a PDF from Files, iCloud Drive, or a USB drive.
- **Moving around**: pinch to zoom, drag to pan, double-tap to fit. Trackpads and mice also work.
- **Separations**: true plates from Ghostscript, with overprint handled like a RIP. Switch each ink on or off in the Inspector. The first use loads the separation engine.
- **Densitometer**: turn it on and drag a finger to read ink % and total area coverage (TAC). An Apple Pencil hover or a trackpad pointer reads without touching.
- **Page boxes**: edit the Crop, Bleed, Trim and Art boxes in mm, or set the bleed to N mm around the trim.
- **Save**: the original file's bytes are kept exactly, and edits are added after them. Before you save, you see every change compared with the file you opened. Then choose **Save to Files**.
- `test-sample.pdf` is a small PDF/X test file with a PANTONE spot, a varnish plate and private app data.

## The test that matters
Export real jobs from ArtPro+. Open them here, change a box, save, then open the result in ArtPro+ again to confirm everything is intact.

## Updating later
Upload the changed files to the same repository. Before uploading, raise the version in `sw.js` (`prepress-v1` → `prepress-v2`) so the iPad picks up the new version.

## Notes
- Engines: MuPDF and Ghostscript, compiled to WebAssembly. Both are AGPL, which is fine for personal use.
- Very large sheets are previewed at a lower resolution automatically, to stay within the iPad's image size limit.
