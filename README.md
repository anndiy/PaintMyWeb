<div align="center">
  <img src="icons/icon128.png" alt="PaintMyWeb icon" width="112" height="112">

  <h1>PaintMyWeb</h1>

  <p><strong>Paint webpage elements and text with your own colors.</strong></p>

  <p>A personal Chrome extension for recoloring individual elements on the websites you browse.</p>
</div>

---

PaintMyWeb lets you pick a color, choose what to paint, preview a target directly on a webpage, and click to apply the change. Use it for personal tweaks to the sites you visit, not for building or distributing website themes.

It is deliberately **not a theme maker**. There are no shared themes, user accounts, servers, analytics, or theme marketplace. Paints are stored locally in your browser and can persist across refreshes when you grant access to the relevant site.

## Contents

- [Features](#features)
- [Install in Chrome](#install-in-chrome)
- [How to use it](#how-to-use-it)
- [How it works](#how-it-works)
- [Persistence and permissions](#persistence-and-permissions)
- [Privacy](#privacy)
- [Targeting behavior and limitations](#targeting-behavior-and-limitations)
- [Project structure](#project-structure)
- [Development and testing](#development-and-testing)
- [License](#license)
- [Project credit](#project-credit)

## v2.1.1

This bug-fix release recreates the floating palette if a single-page app replaces the DOM around it (for example, when navigating between GitHub pages). It also reports a missing content-script response instead of silently closing the launcher.

## v2.1

- Reduced UI copy and tightened the palette.
- Replaced the brightness track with a white-to-color-to-black shade selector.
- Updated typography, drag handle, and Element fill-bucket icon.

## Features

- **Floating palette:** a compact panel injected over the current webpage. It stays visible during target selection and can be dragged out of the way.
- **Interactive color wheel:** pick a hue and saturation, adjust brightness, or enter a HEX value directly.
- **Element paint:** apply the selected color to an element's `background-color`.
- **Text paint:** apply the selected color to an element's `color`.
- **Continuous painting mode (v2):** choose Element or Text once, start picking once, and click as many targets as you need. The mode and color remain active between clicks; no need to reselect the mode or repeatedly press Pick.
- **Live target preview:** a high-contrast outline and a mode label show which element is under the pointer before you apply the paint.
- **Safer selection:** explicitly enter selection mode, click the intended target, or press `Escape` to cancel. Selection clicks are intercepted so links and buttons do not accidentally activate.
- **Persistent paints:** opt into site access so saved colors can be restored after refresh and on later visits to the same page URL.
- **Page-specific rules:** saved paints are scoped to the page origin, path, and query string. URL fragments are ignored.
- **Undo and clear:** undo recent paints or remove all PaintMyWeb overrides saved for the current page.
- **ID-first targeting:** prefer a unique element ID; otherwise use a structural selector based on tag names and `:nth-of-type()`, not page classes.
- **Isolated UI styling:** the palette runs inside a Shadow DOM to reduce conflicts with the host website's CSS.
- **No build step:** plain HTML, CSS, and JavaScript. No framework, package manager, external libraries, or network service.

## Install in Chrome

PaintMyWeb v2.1.1 is supplied as an unpacked Chrome extension using Manifest V3. It is not currently a Chrome Web Store release.

1. Download and extract `PaintMyWeb.zip`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted `PaintMyWeb` folder, the folder containing `manifest.json`.
6. Pin PaintMyWeb from the Extensions menu for convenient access.
7. Open a regular `http://` or `https://` webpage and click the PaintMyWeb toolbar icon.
8. Keep **Remember paints** enabled if you want persistence. When prompted, grant access to that website.
9. Click **Open paint palette**, choose a color and a mode, then click **Paint**.

### Quick install checklist

- [ ] Extract the ZIP first.
- [ ] Select the folder containing `manifest.json`, not the ZIP file itself.
- [ ] Use a regular webpage, not a Chrome internal page such as `chrome://extensions`.
- [ ] Grant site access only when you want saved paints to restore automatically.

## How to use it

1. Open a webpage where you want to make a personal color adjustment.
2. Click the PaintMyWeb extension icon and open the floating palette.
3. Pick a color using the wheel, white-to-black shade control, or HEX field.
4. Choose **Element** to change target backgrounds or **Text** to change text colors. Choose the mode once for the batch.
5. Click **Paint** once. Move the pointer over the page; the outline previews the target.
6. Click a target to paint it. **PaintMyWeb stays in selection mode**, so you can keep clicking as many targets as needed using the same mode and color.
7. To switch from backgrounds to text or vice versa, choose the other mode in the floating palette. To finish the batch, click **Done** or press `Escape`.
8. Use **Undo** to reverse a recent paint, or **Clear** to remove PaintMyWeb paints for the current page.

Disable **Remember paints** when you only want to experiment in the current page session without opting into persistent site access.

## How it works

### Floating palette

The palette is inserted into the webpage by a content script. Its UI is mounted in a Shadow DOM so that most host-page styles do not bleed into the palette and the palette's styles do not leak out into the page. The panel can be moved so it does not cover the content being edited.

### Target preview and painting

During selection, the content script tracks pointer movement and identifies the element under the pointer. A separate overlay draws the target outline and displays an `ELEMENT PAINT` or `TEXT PAINT` label. When the user commits a selection, PaintMyWeb applies either `background-color` or `color` with elevated CSS priority.

Before the first PaintMyWeb override for a given element/property in the current page session, the extension records the previous inline value and priority so the change can be undone or cleared.

### Finding an element again

PaintMyWeb tries a unique ID first. If the target has no usable unique ID, it creates a structural selector using ancestor tag names and `:nth-of-type()` positions. It intentionally avoids class-based selectors because classes are commonly shared across many elements and can change as sites evolve.

### Saving and restoring paints

Paint records are saved with `chrome.storage.local`, not in the website's own `localStorage`. A saved record includes information such as:

- the page key (`origin + pathname + search`),
- the element selector and tag name,
- the CSS property and color value,
- a rule identifier and creation timestamp.

When persistent saving is enabled, PaintMyWeb requests optional access to the relevant HTTP or HTTPS site and registers a content script for restoration. On a later matching page load, the extension looks up records for that exact page key and reapplies the saved overrides.

Saved paints are local to this extension installation. They are not sent to PaintMyWeb or OwnSue servers.

## Persistence and permissions

PaintMyWeb requests these extension permissions:

| Permission | Purpose |
|---|---|
| `activeTab` | Access the tab where the user invokes PaintMyWeb. |
| `scripting` | Inject the content script and register a restorer after site access is granted. |
| `storage` | Store saved paint rules locally. |

HTTP and HTTPS host access is **optional** and requested for an individual site when the user enables persistent saving. If access is declined, temporary painting can still be used in the current tab, but the extension cannot automatically restore saved paints on future loads of that site.

Chrome-restricted pages, including many `chrome://` pages, cannot be modified by extensions. Host permission applies to a site's host while the stored paint rules themselves are scoped to a particular page URL.

## Privacy

PaintMyWeb is designed as a local, personal-use tool:

- No account or sign-in.
- No backend or cloud synchronization.
- No analytics or telemetry.
- No third-party network requests.
- No remote code.
- Saved paint rules remain in Chrome extension storage on the user's device.

Removing the extension also removes its extension storage and saved paint records.

## Targeting behavior and limitations

A unique element ID is the preferred target. Without one, PaintMyWeb falls back to a structural selector based on tags and `:nth-of-type()` positions. Before restoring a rule, it checks that the selector resolves to a single element and that the target tag still matches. If it cannot identify one unambiguous target, it skips the rule rather than knowingly selecting the first ambiguous result.

Selectors cannot guarantee permanent identity. Websites can change their DOM, personalize content, or replace elements between visits. A structural selector may also resolve to another same-tag element if a site's structure changes in a compatible way, so inspect saved results on pages that change frequently.

Other limitations:

- Complex frames, canvas-rendered interfaces, closed Shadow DOM, and browser-protected surfaces may not be targetable like ordinary document elements.
- A site's scripts may replace elements or rewrite inline styles. PaintMyWeb retries after some DOM replacements, but cannot promise compatibility with every website.
- Single-page applications can replace parts of their DOM during navigation. PaintMyWeb now detects when its floating palette host is detached and rebuilds the UI; saved rule targeting can still be affected when the website changes its markup.
- Host access is not requested for every website upfront; it is requested per site when persistence is enabled.
- This project has not been published or certified through the Chrome Web Store review process.

## Project structure

```text
PaintMyWeb/
├── manifest.json       # Manifest V3 metadata, APIs and optional permissions
├── background.js       # Service worker and persistence registration
├── popup.html          # Toolbar launcher
├── popup.css           # Launcher styling
├── popup.js            # Current-site detection and permission flow
├── content.js          # Floating palette, targeting, painting and restoration
├── icons/
│   ├── icon16.png      # Toolbar / small UI icon
│   ├── icon32.png      # Standard small icon
│   ├── icon48.png      # Extension management icon
│   └── icon128.png     # Large icon, also displayed at the top of this README
├── README.md
└── LICENSE
```

### App icon

The repository includes four PNG sizes of the PaintMyWeb icon. The large icon is shown at the top of this README; all image references use relative paths so they render on GitHub when the full project folder is uploaded.

## Development and testing

No compilation or package installation is required.

1. Edit the source files.
2. Open `chrome://extensions`.
3. Press **Reload** on PaintMyWeb.
4. Refresh the test page if its content script needs to be reloaded.

### Suggested manual test checklist

- [ ] Load unpacked from the folder that contains `manifest.json`.
- [ ] Launch on a regular HTTPS page and on an HTTP page.
- [ ] Paint a background color on multiple elements in one continuous selection session.
- [ ] Paint text on multiple elements in one continuous selection session.
- [ ] Switch modes mid-session and confirm the next click uses the newly selected mode.
- [ ] Confirm the outline follows the target while the pointer moves.
- [ ] Press `Escape` and confirm target selection cancels.
- [ ] Confirm selecting a link or button does not navigate or activate it.
- [ ] Undo multiple paints on the same element and on different elements.
- [ ] Clear a page and confirm PaintMyWeb's inline overrides are removed.
- [ ] Grant site access, paint an element, refresh, and confirm the color returns.
- [ ] Navigate between paths on a single-page app (for example, GitHub) and confirm the palette can be opened again.
- [ ] Test an element without an ID and inspect its selector after refresh.
- [ ] Try a restricted URL such as `chrome://extensions` and confirm it cannot be painted.

## License

PaintMyWeb is licensed under the MIT License. See [`LICENSE`](LICENSE).

## Project credit

**PaintMyWeb is part of the OwnSue web playground.**

Created under the OwnSue identity: [ownsue.lol](https://ownsue.lol).
