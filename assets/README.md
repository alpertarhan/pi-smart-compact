# Runtime assets

These files ship with the npm package. Branding belongs in
[`docs/assets/`](../docs/identity.md#visual-assets), not here.

| Asset | Runtime purpose |
| --- | --- |
| `DejaVuSansMono.ttf` | Deterministic text rendering for optional visual archives. |
| `DejaVu-LICENSE.txt` | Required redistribution license for the bundled font. |
| [`skills/context-management/SKILL.md`](./skills/context-management/SKILL.md) | The `continuity-context` guide, read on request through the agent tool loader; not injected into every prompt. |

## Visual archive font

`DejaVuSansMono.ttf` is the unmodified DejaVu Sans Mono 2.37 font from
`dejavu-fonts-ttf@2.37.3` (`ttf/DejaVuSansMono.ttf`). Upstream:
https://dejavu-fonts.github.io/

SHA-256:

```text
b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582
```

Redistributed with [`DejaVu-LICENSE.txt`](./DejaVu-LICENSE.txt). No system fonts, font downloads, or SVG
external resources are needed at runtime. Only this font is shipped, not the
entire upstream font package.
