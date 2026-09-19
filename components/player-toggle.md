# Player Toggle (Switch)

Settings on/off control (atom). ARIA pattern: `accessibility/aria-patterns.md` → Switch. Render via the [Framework Adapter Protocol](../frameworks/adapter-protocol.md).

---

## Anatomy

```
[label text + description]  [ track 44×25 │ thumb 19px ○ ]
<button class="toggle[.on]" role="switch" aria-checked aria-label>
```

Real `<button>` (keeps native keyboard); visual thumb is a `::after` circle sliding 44−19−padding.

## Variants

| Variant | Markup | Notes |
|---------|--------|-------|
| `switch` (only) | `role="switch"` + `aria-checked` | NEVER `role="checkbox"` — switch = immediate effect, no submit |
| label-wrap | visible text + description left, control right | settings rows |
| standalone | `aria-label` only | toolbars |

## Sizes

| Part | Value | Token |
|------|-------|-------|
| track | 44×25px | between `sizing.control.xs` 24 and `sm` 32 height — acceptable (44px width target) |
| thumb | 19px circle | — |
| target | whole 44×25 ≥ 24px min | WCAG 2.5.8; 44px recommended only for primary actions |

## States (8)

| # | State | Treatment | Token |
|---|-------|-----------|-------|
| 1 | Default (off) | `rgba(255,255,255,.07)` track, `line-strong` border, thumb left | base |
| 2 | Hover | brighter track `panel-strong` | `states.hover.overlay` |
| 3 | Focus | 2px accent ring, `outline-offset:2px` | `states.focus.ring` |
| 4 | Active/pressed | accent fill track, thumb right, `border-color: transparent` | `states.active` |
| 5 | Disabled | `opacity .5`, `cursor:not-allowed`, no events | `states.disabled` |
| 6 | Loading | N/A — toggles apply instantly by design (aria-pattern rule) | — |
| 7 | Error | N/A — no validation surface; failed persistence surfaces as toast | — |
| 8 | On/selected | `.on` + `aria-checked="true"` + visible position change (never color alone) | `states.selected` |

## Token mapping

Kit: `sizing.*`, `states.*`, `motion` (0.25s ease), `shadows.focus-ring`. Player: `--line-strong`, `--dyn-accent`, `--ease`, `--r-full`.

## Accessibility

- `role="switch"` + `aria-checked` synced on every toggle (verified in `toggleDefs` handler).
- Keyboard: Space AND Enter toggle (native button gives both free).
- Visible on/off encoded by thumb POSITION + track fill, not color alone (POUR: install a text/dot cue if track hues ever rely on color only).
- Setting changes apply instantly + persist; announcements via polite toast region.
- Reduced motion: thumb snaps (no slide), state still communicated.

## Notes

- Current implementation matches this spec except Loading/Error correctly N/A.
- `low-fx` mode must not strip the on/off position cue.
