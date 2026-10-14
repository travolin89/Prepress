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
- **Layers**: the file's PDF layers, the same ones ArtPro+ and Acrobat show.
  - 👁 shows or hides a layer on screen and in the separations. This is a view setting only and is never saved.
  - 🔒 locks a layer so its objects can't be selected or edited.
  - You can also rename layers and add new ones.
- **Edit**: works with the selection.
  - **Selecting**: in **Select** mode, tap an object, or drag across empty space to select everything inside. Tapping a grouped object selects the whole group. Turn on "Taps add to selection" to build a selection one tap at a time.
  - **Moving**: drag the selection, nudge it, or move it by an exact distance in mm.
  - **Group, ungroup, lock, delete.** Locked objects can't be selected; use **Unlock all** to release them.
  - **Move to layer**: choose a layer, or "(no layer)".
  - **Ink**: change paths and text to a process ink, an existing spot or a new spot, at any tint.
  - **Text**: select a text object to edit it. Text added in this app keeps all its settings. For text from the original file, the current wording is filled in, and updating it replaces the text in the same position and angle using the font you pick (the file's own fonts are usually subsets, so they can't take new letters).
  - **Barcodes**: select a barcode to change its data, magnification, bar height, BWR, ink or tint. Its lower-left corner stays put.
  - **Page boxes**, plus a one-tap bleed setting.
- **Text**: add text using a built-in font (Helvetica, Times or Courier families) or your own TTF/OTF font. **Import font** stores it on this iPad. Set the size, line spacing, alignment, ink, tint and position, or place it by tapping the page. Fonts are embedded with only the characters used.
- **Preflight**: checks for missing fonts, low-resolution and RGB images, RGB colour, hairlines and zero-width lines, small text, bleed, trim box, PDF/X marking and output intent, and total ink coverage. The limits are adjustable. Tap a result to jump to it on the page. Content checks include hidden layers.
- **Barcode**: EAN-13, UPC-A, EAN-8, GS1-128, Code 128, ITF-14, GS1 DataMatrix, DataMatrix, GS1 QR and QR.
  - **Sizing**: set it by **magnification %**. 100% is the standard size (EAN/UPC: 0.33 mm module and 22.85 mm bars), and EAN/UPC are limited to GS1's 80–200%. **Bar height %** truncates the bars.
  - **Other settings**: BWR in mm, ink and tint. The panel shows the resulting module size and bar height as you type.
  - The digits are drawn as outlines, so no fonts are needed.
- **Info**: PDF/X version, output intent, private application data, layers and page boxes.

### How groups and locks are stored
Groups and locks are stored as invisible tags around each object (PDF marked content). They don't change how anything prints, other programs simply ignore them, and the stacking order of your artwork never changes.

### Saving
The original file's bytes are kept exactly, and edits are added after them. Before you save, you see every change compared with the file you opened. Then choose **Save to Files**.

### Editing limits (for now)
- Objects inside placed artwork (form XObjects) move and delete as one unit.
- Images and placed artwork can be moved or deleted, but not recoloured.
- Paths that also act as clipping paths are locked, because editing them would change other artwork.
- Groups and locks made in ArtPro+ itself aren't read. This app's own groups and locks work everywhere in this app.
- A text block uses one font, size and ink throughout.
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
