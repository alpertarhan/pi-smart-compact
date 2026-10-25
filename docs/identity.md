# Smart Compact identity

[Overview](../README.md) · [Documentation](./README.md) · [Contributing](https://github.com/alpertarhan/pi-smart-compact/blob/main/CONTRIBUTING.md)

**Smart Compact** is the product, the UI name and the name used in documentation.
The visual identity makes the work tangible: a crowded session becomes a small
working folio, while a visible thread leads back to recorded evidence.

## Name and technical identifiers

| Surface | Use |
| --- | --- |
| Product, prose and UI | **Smart Compact** |
| npm package and repository | `pi-smart-compact` |
| Command and tool family | `/smart-compact` and `smart_*` |
| Configuration namespace | `smartCompact` |
| Existing paths, refs and compatibility keys | Preserve exactly; no migration |

Earlier documentation used **Pi Continuity**. That was a documentation brand,
not a different package. The current identity reunifies the name; historical
changelog entries keep the names used at their publication date. The legacy
`semanticCompact` configuration alias and internal continuity terminology are
not renamed. “Continuity” remains a useful description of behavior, not a
second product name.

## The bound folio

<p>
  <img src="./assets/emblem.png" alt="Smart Compact emblem: a folded blue folio with a white S-shaped page and a gold bookmark." width="132" height="132" />
</p>

The emblem is a **bound folio**: a stack reduced to an addressable working
object, not a disappearing history. Its folded page makes an angular **S**;
a gold bookmark preserves a place to return to. The dark fore-edge gives it
the same physical construction as the workbench illustration.

Use the emblem alone where space is limited. Use the wordmark when the project
needs to introduce itself. Neither requires a font at display time.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.png" />
    <img src="./assets/logo.png" alt="Smart Compact wordmark with the bound-folio emblem." width="600" height="120" />
  </picture>
</p>

## The illustrated workbench

The header is an original vector illustration, not a stock icon arrangement or
a screenshot. Its objects explain the workflow:

- **Loose session pages:** tool output, source evidence and conversation history.
- **Binding press and checked folio:** compacting the working set, with review
  before apply—not a claim that every detail survives.
- **Gold return thread and drawers:** retrievable recorded evidence and recovery.
- **Separate green card box:** optional project memory, distinct from archives.

The drawing deliberately does not show files being undone or a transcript being
uploaded to a remote brain. Those would misrepresent the product. The banner's
text alternative describes the same scene for readers who cannot see it.

## Visual system

| Role | Value | Use |
| --- | --- | --- |
| Ink | `#17314B` | Wordmark, foreground and structural edges |
| Binding blue | `#315CCB` | Folio, press and the main point of emphasis |
| Steel | `#9BADCA` | Page rules, secondary geometry and depth |
| Paper | `#F7F9FC` | Reading surface and high-contrast negative space |
| Bookmark gold | `#DCA653` | Return thread and saved place |
| Memory green | `#367D77` | The separate project-memory object |

Lettering uses outlined Avenir Next Regular and Demi Bold. Font files are not
redistributed and exports make no system-font or network requests. Body copy
uses the reader's Markdown renderer; there is no custom documentation theme to
install. Prefer sentence case, plain verbs, meaningful diagrams and generous
spacing over decorative badges or unsupported performance claims.

## Visual assets

| File | Role | Size |
| --- | --- | --- |
| [`banner.svg`](./assets/banner.svg) | Editable master: illustration, emblem and outlined wordmark | 1600 × 720 |
| [`banner.png`](./assets/banner.png) | README/header export; baked-in light surface | 1600 × 720 |
| [`emblem.svg`](./assets/emblem.svg), [`emblem.png`](./assets/emblem.png) | Transparent standalone emblem | 176 × 176 |
| [`logo.svg`](./assets/logo.svg), [`logo.png`](./assets/logo.png) | Transparent horizontal wordmark for light surfaces | 720 × 144 |
| [`logo-dark.svg`](./assets/logo-dark.svg), [`logo-dark.png`](./assets/logo-dark.png) | Light-lettering wordmark for dark surfaces | 720 × 144 |
| [`pi-smart-compact.svg`](./assets/pi-smart-compact.svg), [`pi-smart-compact.png`](./assets/pi-smart-compact.png) | Package catalog tile; baked-in light surface | 512 × 512 |

These assets are original project artwork under the repository's
[MIT license](../LICENSE). Give the wordmark a light surface; do not put its
ink lettering directly on a dark background—use `logo-dark` there instead. The opaque banner and package tile
work in both light and dark Markdown renderers. Keep the emblem's aspect ratio
and clear space; do not crop away the bookmark.

## Regenerate the exports

Edit **`docs/assets/banner.svg`**, then run from a development checkout:

```bash
bun run brand
bun test test/docs-brand.test.ts
```

`scripts/render-brand.ts` extracts the master’s two named flat groups,
`smart-compact-mark` and `smart-compact-wordmark`, and creates the standalone
SVGs plus all PNGs with the pinned development renderer. Do not edit those
exports independently. Keep the groups flat and uniquely named; the generator
fails rather than silently exporting an incomplete mark.

The master contains outlined lettering. Change it in a vector editor and
outline replacement text before exporting; no font installation is needed to
render committed artwork. Update the README dimensions and `package.json#pi.image`
cache suffix when changing the public header or package tile. The regression
checks cover image dimensions, self-contained SVGs, names and local doc links.

## Historical and runtime assets

Preserve dated evidence and release history rather than rewriting old claims.
Runtime assets under [`assets/`](../assets/README.md) serve a different purpose:
the optional visual archive font and the on-demand agent guide. Do not replace
that font or rename the guide as part of a visual refresh.
