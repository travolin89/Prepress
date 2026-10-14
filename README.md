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
- **Modes** (toolbar):
  - **Pan**: drag to move around.
  - **Select**: tap an object to select it, drag to move it, and tap the same spot again to pick the object underneath.
  - **Measure**: drag to read ink percentages.
- **Moving around**: pinch to zoom in any mode, and double-tap to fit in Pan mode. An Apple Pencil hover or a trackpad pointer reads ink values without touching.
- **Separations**: true plates from Ghostscript, with overprint handled like a RIP.
- **Undo**: steps back through your edits since the last save.

### Inspector tabs
- **Inks**: switch plates on and off. **Measure coverage** gives the ink % and solid-equivalent cm² per plate inside the trim.
- **Edit**:
  - For the selected object, nudge it, move it by an exact distance in mm, change its ink (process, an existing spot, or a new spot) and tint, or delete it.
  - Page boxes, plus a one-tap bleed setting.
- **Preflight**: checks for missing fonts, low-resolution and RGB images, RGB colour, hairlines and zero-width lines, small text, bleed, trim box, PDF/X marking and output intent, and total ink coverage. The limits are adjustable. Tap a result to jump to it on the page.
- **Barcode**: EAN-13, UPC-A, EAN-8, GS1-128, Code 128, ITF-14, GS1 DataMatrix, DataMatrix, GS1 QR and QR.
  - Set the module size, bar height, bar width reduction (BWR), ink and tint.
  - Place it by typing a position or by tapping the page.
  - Barcodes are vector artwork with the digits drawn as outlines, so no fonts are needed. Once placed, a barcode can be selected, moved or deleted like any other object.
- **Info**: PDF/X version, output intent, private application data, layers and page boxes.

### Saving
The original file's bytes are kept exactly, and edits are added after them. Before you save, you see every change compared with the file you opened. Then choose **Save to Files**.

### Editing limits (for now)
- Objects inside placed artwork (form XObjects) move and delete as one unit.
- Images and placed artwork can be moved or deleted, but not recoloured.
- Paths that also act as clipping paths are locked, because editing them would change other artwork.
- Preflight doesn't yet check white overprint.

## The test that matters
Export real jobs from ArtPro+. Open them here, change a box, save, then open the result in ArtPro+ again to confirm everything is intact.

## Updating to a new version
1. Unzip the new version in Files.
2. In your GitHub repository, tap **Add file → Upload files** and select **all** files from the new folder. Files with the same name are replaced, and new ones are added.
3. Tap **Commit changes** and wait about a minute.
4. Open the app while online, close it completely, then open it again. The second launch runs the new version.

Each release raises the cache version in `sw.js`, which is what tells the iPad to fetch the new files.

## Notes
- Engines: MuPDF and Ghostscript, compiled to WebAssembly. Both are AGPL, which is fine for personal use.
- Very large sheets are previewed at a lower resolution automatically, to stay within the iPad's image size limit.
