# Airbender site

The marketing page for Airbender, published with GitHub Pages at
<https://mturilin.github.io/airbender/>.

A static page: `index.html`, `styles.css`, `main.js`, `favicon.svg`, the
hero screenshot in `img/` and the three font files in `fonts/`. There is no build step and nothing is loaded
from another site.

## Publishing

`.github/workflows/site.yml` publishes this folder whenever a commit on
main changes something in it. Every commit in this repository is pushed
automatically, so a commit that touches `site/` is live a minute or two
later. It needs Pages switched on for the repository, with "GitHub Actions"
as the source.

## Look at it

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000 --directory site
```

## Change it

- The text is all in `index.html`. The hero is a real screenshot:
  `img/hero.webp`, with `img/hero.png` for browsers without WebP. To change
  it, replace both (`magick shot.png -strip -define webp:lossless=true
  img/hero.webp`) and update `width` and `height` on the `<img>`. The
  smaller pictures further down are drawn in HTML; the wording on its buttons and steps follows the product's
  spec (`specs/PRD.md`) and should stay true to it. When the workflow or a
  button's label changes, change it here in the same piece of work.
- The workflow demo's steps and wording are in `main.js` (`STEPS`, `PATHS`);
  they mirror `shared/standard-workflow.ts`.
- Colours, type sizes and the headline style are at the top of `styles.css`.
- The repository address and the install command appear in several places:
  search for `mturilin/airbender`.
- All paths in the page are relative, because the site is served from
  `/airbender/`, not from the root of its address.

## Fonts

Archivo, Instrument Serif and JetBrains Mono, each under the SIL Open Font
License, downloaded from Google Fonts (Latin subset).
