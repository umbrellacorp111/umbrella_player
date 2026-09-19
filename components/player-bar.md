# Player Bar

Bottom playback bar (organism): identity + transport + seek + volume + auxiliaries. Render via the [Framework Adapter Protocol](../frameworks/adapter-protocol.md).

---

## Anatomy

```
[cover btn│title/artist│fav] [shuffle prev PLAY next repeat] [t current][slider][t total] [vol][queue][lyrics]
grid: minmax(200px,1fr) minmax(320px,2fr) minmax(200px,1fr), h84 (--pb-h), glass
```

## Variants

| Variant | Change |
|---------|--------|
| `idle` | no track: controls disabled, meta placeholder |
| `playing` | pause icon, eq/LED live, times ticking |
| `paused` | play icon, frozen times, `particle-paused` throb on np-play |
| `loading` | `playbackLoading` overlay (`aria-live=polite`), controls full-strength + spinner (never disabled-look) |
| `full` (now-playing) | 70px play, wave canvas, speed/cover/dj buttons |

## Sizes

| Part | Value | Token |
|------|-------|-------|
| bar | h84 fixed, 3-col grid | organism template |
| pb-play | 40px white disc, dark glyph | `sizing.avatar.lg`, 3:1 non-text (white on dark) |
| np-play | 70px | hero control |
| side buttons | 36–40px targets | `sizing.control.sm–md` |
| slider | full-width track, knob; ≥24px grab area | `sizing.control.xs` min |

## States (8)

| # | State | Treatment | Token |
|---|-------|-----------|-------|
| 1 | Default | glass bar, `text-1/3` | base |
| 2 | Hover | button wash + lift (play: scale) | `states.hover` |
| 3 | Focus | ring on every control incl. slider | `states.focus.ring` |
| 4 | Active | pressed scale, shuffle/repeat `.active` tinted | `states.active/selected` |
| 5 | Disabled | idle: dimmed + `disabled` attr, no events | `states.disabled` |
| 6 | Loading | overlay + `aria-busy` on bar | `states.loading` |
| 7 | Error | stream failure: danger toast WITH retry action + label, bar stays usable | `states.error` |
| 8 | Toggled | shuffle/repeat/fav `.active` + `aria-pressed="true"` (icon + state, not color alone) | `states.selected` |

## Token mapping

Kit: `sizing.*`, `states.*`, `motion`, `shadows`. Player: `--pb-h`, `--text-1/2/3`, `--dyn-accent`, `--r-*`, `--spring`. Times use tabular numerals.

## Accessibility

- Slider pattern (`aria-patterns.md` → Slider): custom `role="slider"` + arrows implemented; **delta: add PageUp/Down (±10×), Home/End + `aria-valuetext` ("1:23 of 4:05").**
- Play/pause is ONE button morphing icon with stable `aria-label` ("Воспроизвести/пауза" per state).
- Shuffle/repeat/fav are toggle buttons: `aria-pressed`, active styling redundant with icon change.
- Volume: icon button + slider; keyboard reaches both; mute state announced.
- `aria-hidden="true"` on LED canvases (decorative); times `aria-hidden` when duplicated by slider `aria-valuetext`.
- Sticky bar must never cover focused content (WCAG 2.4.11): content bottom padding ≥ bar height.

## Notes

- `low-fx` keeps layout, drops backdrop blur (already implemented).
- Bar is `position:fixed`: reserve `--pb-h` + safe-area in content padding.
