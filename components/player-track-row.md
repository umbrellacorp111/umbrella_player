# Player Track Row

List item for a single track (molecule: number/cover + meta + actions). Render via the [Framework Adapter Protocol](../frameworks/adapter-protocol.md). Source of truth for values: `SOVAKOD/styles.css` + `app2.js` (`trackRow()`); kit tokens are the cross-framework reference.

---

## Anatomy

```
[# | cover 40px | title / artist+album · duration | fav | play | more ▾ ]
 grid: 42px minmax(180px,1fr) minmax(130px,.65fr) 64px 100px 40px (desktop)
 mobile: 42px minmax(0,1fr) auto 36px (album/btns hidden)
```

`[number|eq] [cover] [title / small meta] [duration] [track-fav] [track-action] [track-more → track-menu]`

## Variants

| Variant | Extra atoms | Notes |
|---------|-------------|-------|
| `library` | fav + play + more(pl/dl/del) | default |
| `favorites` | play + remove | `data-source="favorites"` |
| `search` | play + add-to-library | results queue |
| `yt` | play + download-offline | `data-del` present |
| `scLib` | play + delete-file | destructive, confirm first |
| `playing` | number → animated `eq-bars`, accent title | `.playing` + accent `::before` rail |

## Sizes

| Part | Value | Token |
|------|-------|-------|
| row min-height | 62px desktop / 56px mobile | `sizing.control.lg–xl` |
| cover | 40px desktop / 36px mobile, r8, `aspectRatio.square` | `sizing.avatar.lg`, player `--r-sm` |
| number | 12px tabular | `font-variant-numeric: tabular-nums` |
| meta title 13px / small 11.5px | body/secondary scale | `typography` |
| icon buttons | 32–36px hit area (≥ `control.xs` 24px) | `sizing.control.xs` min |

## States (8)

| # | State | Treatment | Token |
|---|-------|-----------|-------|
| 1 | Default | transparent, `text-1`/`text-3` | base |
| 2 | Hover | `rgba(255,255,255,.035)` wash + reveal play/fav | `states.hover.overlay` |
| 3 | Focus | visible ring on the focused control (`:focus-visible` 2px) | `states.focus.ring` |
| 4 | Active | accent rail + eq bars + accent title | `states.selected.bg` |
| 5 | Disabled | N/A — rows are never disabled (no dead rows) | — |
| 6 | Loading | skeleton row, `aria-busy="true"` on list | `states.loading` |
| 7 | Error | failed/resolve-error row: danger icon + retry label (not color alone) | `states.error` |
| 8 | Playing/selected | `.playing`: eq, accent, `aria-current="true"` on row | `states.selected` |

## Token mapping

Kit: `sizing.control.*`, `sizing.icon.sm/md`, `states.*`, `typography`, `shadows`. Player (authoritative): `--text-1 #f2f3f7`, `--text-3 #848899` (5.68:1 measured), `--dyn-accent`, `--r-sm`, `--ease`. Truncation: `min-width:0` + ellipsis on meta (required — CJK/long titles).

## Accessibility

- Row click plays (`row.onclick`) → row MUST be keyboard-operable: `tabindex="0"` + Enter/Space handler, or inner play button as the single tab stop. **Delta (open): current rows are pointer-only.**
- Actions are real `<button>`s with `aria-label` (verified in code).
- `track-more` menu: Esc closes, focus returns to trigger; `role="menu"`/`menuitem` recommended.
- Playing state exposed: `aria-current="true"` + text label, never color alone.
- List container `role="list"`, rows `role="listitem"`; async swaps announced via existing `aria-live` toast region.
- Touch targets ≥24px (WCAG 2.5.8); text contrast AA measured (see `design-review` run).

## Notes

- `content-visibility: auto` on rows (perf round 2) — verify no focus-scroll breakage.
- Debounced filter re-renders full list: keep DOM order stable for SR users.
