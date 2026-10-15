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
- **Moving around**: pinch to zoom in any mode, and double-tap to fit in Pan mode. When you stop moving, the visible area is redrawn at your iPad's full screen resolution, so it stays sharp at any zoom. In Separations mode it's rendered at double resolution and smoothed. An Apple Pencil hover or a trackpad pointer reads ink values without touching.
- **Separations**: true plates from Ghostscript, with overprint handled like a RIP.
- **Undo**: steps back through your edits since the last save.

### Inspector tabs
- **Inks**: switch plates on and off. **Measure coverage** gives the ink % and solid-equivalent cm² per plate inside the trim.
- **Layers** (also the **Layers** button on the toolbar): the file's PDF layers, the same ones ArtPro+ and Acrobat show.
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
- **Text**: under **Shape**, choose **Straight**, **Along the selected path** (select a line, curve or shape first; the text follows it from its first point), or **Around a circle** (set the centre by tapping, plus radius, centre angle, and over the top or under the bottom, as on round labels). Path text has start offset, baseline shift, letter spacing and flip side, and stays on its path when edited.
  Add text using a built-in font (Helvetica, Times or Courier families) or your own TTF/OTF font. **Import font** stores it on this iPad. Set the size, line spacing, alignment, ink, tint and position, or place it by tapping the page. Fonts are embedded with only the characters used.
- **Links**: every image and scan in the file.
  - For each one: thumbnail, pixel size, colour (CMYK, RGB, Grey, ICC, spot or DeviceN), compression, and every placement with its page, size in mm and effective ppi. Low ppi is highlighted.
  - **Show** jumps to the image.
  - **Relink…** replaces it with a file from Files, iCloud or a drive (JPEG, TIFF, PNG or PSD) in every placement. Choose **Fit proportionally** or **Fill the frame**. CMYK stays CMYK, a JPEG stays a JPEG, and new data is compressed when you save.
  - **Remove** deletes it everywhere.
- **Trap**: automatic trapping, following ArtPro+'s rules.
  - Where two colours meet and misregistration could show paper (each has ink the other lacks, by more than the **step limit**), the lighter colour, by neutral density, spreads into the darker one by the **trap width**. Anything with solid black uses the **black width**.
  - Per ink you can choose **Normal**, **Opaque** (metallics and foils: other inks spread under them) or **Ignore** (varnish, white, cutter lines). These are pre-set from the ink names.
  - Images are left alone unless **Trap images** is on.
  - Traps are overprinting vector objects, one per ink, on a **Traps** layer. Hide the layer to compare, run trapping again to replace them, or use **Remove traps**.
  - It works from true separations, rendered in tiles at a resolution where the trap width is a whole number of pixels (0.1 mm becomes 3 px at 762 dpi). Trap edges are accurate to one pixel at that resolution.
- **Screens**: ruling (lpi), angle and dot shape (Round, Ellipse, EllipseC, Square, Diamond, Line, Cross) for every ink, with "Others" as the default.
  - **Apply to document** stores them as standard PDF screening.
  - **Dot preview**: tap the button, then tap the page where you want to look. A window shows the real halftone dots for that 6 × 6 mm area at 2400 dpi. Solids have no dots, so tap a tint or vignette.
  - Many RIPs and platesetters apply their own screening and ignore the screening in the PDF, so confirm with your repro house which settings win.
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
- Trapping has no pullbacks, keep-aways or centre traps yet, and traps against gradients and images are kept simple.
- In the dot preview, each spot ink is rendered with its own screen as the only screen, which works around a limitation of the built-in renderer. The file itself stores the proper per-ink screening.

## The test that matters
Export real jobs from ArtPro+. Open them here, change a box, save, then open the result in ArtPro+ again to confirm everything is intact.

## Updating to a new version
1. Unzip the new version in Files.
2. In your GitHub repository, tap **Add file → Upload files** and select **all** files from the new folder. Files with the same name are replaced, and new ones are added.
3. Tap **Commit changes** and wait about two minutes for GitHub Pages to publish.
4. Open the app while online. From version 4 on, a new version is picked up on the next launch: the app reloads itself, or offers to if a file is open.

**Checking your version:** the version number is shown at the right end of the toolbar (for example **v4**) and at the top of the Info tab.

### If the app still shows an old version
Versions 1–3 kept the old copy too stubbornly. If you don't see **v4** after opening the app twice while online:
1. In Safari, open `https://YOUR-NAME.github.io/prepress/index.html`. In the repository on github.com, open `index.html` and check that it contains "Magnification". If it doesn't, the upload didn't finish, so upload again.
2. Delete the app from the Home Screen (press and hold the icon → **Remove App → Delete**).
3. Go to iPad **Settings → Apps → Safari → Advanced → Website Data**, search for **github.io**, and swipe to delete it.
4. Open the site in Safari again and use **Share → Add to Home Screen**. Fonts you imported earlier need importing once more.

This is only needed once. Version 4 updates itself.

## Notes
- Engines: MuPDF and Ghostscript, compiled to WebAssembly. Both are AGPL, which is fine for personal use.
- Very large sheets are previewed at a lower resolution automatically, to stay within the iPad's image size limit.
