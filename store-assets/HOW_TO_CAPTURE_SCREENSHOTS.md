# How to Capture Chrome Web Store Screenshots

Screenshots must be exactly **1280×800px** (or 640×400px).

## Method: Chrome DevTools Device Emulation

For each of the 5 pages below:

1. Open the extension options page:  
   `chrome-extension://bmihlnhdjhbphfeobnmapjdphbfipgce/options.html`

2. Press **F12** to open DevTools

3. Click the **device emulation icon** (looks like a phone/tablet) in the top-left of DevTools  
   OR press **Ctrl+Shift+M** (Cmd+Shift+M on Mac)

4. Set dimensions to **1280 × 800**, scale **100%**

5. Navigate to the page

6. In DevTools, click the **⋮** menu (three dots) → **Capture screenshot**

7. Save as the filename shown below

## Pages to Screenshot

| # | Page | Sidebar Item | Filename |
|---|------|-------------|----------|
| 1 | Dashboard | Dashboard | `screenshot-1-dashboard.png` |
| 2 | Categorization | Categorization | `screenshot-2-categorization.png` |
| 3 | Rules | Rules | `screenshot-3-rules.png` |
| 4 | History | History | `screenshot-4-history.png` |
| 5 | Popup | Click extension icon | `screenshot-5-popup.png` |

Save all files into this `store-assets/` folder.

## For the Popup (screenshot #5)

The popup is a fixed-size overlay, not a full page. Use macOS Screenshot:
- Press **Shift+Cmd+4** then drag to select just the popup area
- Or use macOS **Screenshot app** > "Capture Selected Portion"

Then resize to 1280×800 using Preview: Tools → Adjust Size
