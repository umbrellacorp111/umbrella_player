# Player Modal (Dialog)

Confirm / prompt / list dialog (organism). ARIA pattern: `accessibility/aria-patterns.md` → Dialog. Render via the [Framework Adapter Protocol](../frameworks/adapter-protocol.md).

---

## Anatomy

```
[backdrop blur] [ card 420px: icon │ h3 title │ p body │ input|list │ (Отмена)(Confirm) ]
.modal > .modal-backdrop + .modal-card[role=dialog aria-modal=true aria-labelledby]
```

## Variants

| Variant | Body slot | Confirm semantics |
|---------|-----------|-------------------|
| `confirm` | text only | destructive (`btn-danger-solid`) vs neutral |
| `prompt` | text input (`autocomplete=off spellcheck=false`) | value returned trimmed; Enter confirms |
| `list` | button rows (label + sublabel) | click row resolves `{idx}`; footer = cancel |

## Sizes

| Part | Value | Token |
|------|-------|-------|
| card | `min(420px, 100%−40px)`, pad 28, `r-lg` | dialog template |
| icon | 54px, r16 | `sizing` |
| buttons | `control.md` 40px min | `sizing.control.md` |

## States (8)

| # | State | Treatment | Token |
|---|-------|-----------|-------|
| 1 | Default | glass card, centered, `modalIn` spring | `motion` |
| 2 | Hover | button hovers only (card static) | `states.hover` |
| 3 | Focus | trap: Tab/Shift+Tab cycle inside; visible ring | `states.focus.ring` |
| 4 | Active | confirm press scale/glow | `states.active` |
| 5 | Disabled | confirm disabled until valid (prompt empty → disabled, not error) | `states.disabled` |
| 6 | Loading | confirm → spinner + `aria-busy`, full strength (never disabled-dimming) | `states.loading` |
| 7 | Error | inline error text + `aria-invalid` on input + `aria-describedby` | `states.error` |
| 8 | Open/selected | `aria-modal`, background `inert`/hidden from AT | dialog pattern |

## Token mapping

Kit: `sizing.*`, `states.*`, `shadows` (lg + focus-ring), `motion`. Player: `--line-strong`, `--r-lg/md`, `--dyn-*`, `--spring/--ease`, `.btn-danger-solid/.btn-ghost/.modal-input`.

## Accessibility

- Open: move focus INTO dialog (confirm button / input / first row). Close (Esc, backdrop, cancel): return focus to trigger. **Delta (open): current code moves focus only in prompt mode and has NO focus trap — prescribe trap per pattern §5.**
- `aria-labelledby=modalTitle`; prompt input gets `aria-describedby` when error text shows.
- Destructive confirms name the object (`«name» будет удалён безвозвратно`) — matches current copy.
- Reduced motion: no spring entrance; backdrop static.
- Toast undo (playlist-track removal) is the dialog's complement, not replacement, for low-risk deletes.

## Notes

- Focus-trap + `inert` background is the single normative gap vs implementation; everything else matches.
- Overlays also gate with `verify_focustrap.mjs --open=<trigger>`.
