# Adaptive HUD System

Design-approved adaptive theming for the Baton HUD chip and topnav.

## Assets

| File | Description |
|------|-------------|
| `baton-glyph-adaptive.svg` | 16×16 glyph with `currentColor` strokes |
| `baton-mark-adaptive.svg` | 64×64 mark with `currentColor` for HUD |
| `baton-tokens.css` | Full design token system with adaptive themes |
| `hud-tokens.css` | HUD-specific tokens merged into hud.css |

## Theming Modes

1. **System** (`data-appearance="system"`) — follows `prefers-color-scheme`
2. **Light** (`data-appearance="light"`) — explicit light theme
3. **Dark** (`data-appearance="dark"`) — explicit dark theme

## CSS Variables (Chip)

```css
--chip-bg: rgba(...);
--chip-border: rgba(...);
--chip-shadow: 0 4px 24px...;
--chip-icon-color: #...;
--chip-count-bg: var(--accent);
--chip-count-color: #fff;
--chip-radius: 10px;
--chip-icon-size: 32px;
```

## Classes

- `.baton-chip` — base chip container with backdrop-filter
- `.baton-chip--icon` — 32×32 icon-only variant
- `.baton-chip__mark` — mark container (uses currentColor)
- `.baton-chip__count` — floating badge (supports status colors)
- `.baton-topnav` — Linear-density header
- `.baton-topnav__brand` — brand section
- `.baton-topnav__tab` — navigation tab buttons
- `.baton-topnav__action` — icon action buttons
- `.baton-topnav__run` — gradient run button

## Status Colors

| Class | Token | Color |
|-------|-------|-------|
| `.running` | `--ok` | `#34d399` |
| `.starting` | `--warn` | `#fbbf24` |
| `.failed` | `--err` | `#f87171` |
| `.idle` | `--idle` | `#64748b` |

## JavaScript API

```javascript
// Set appearance mode
window.batonSetAppearance('system' | 'light' | 'dark');

// Sync from system (called automatically)
syncChipAppearance();
```

## macOS Native Integration

The Swift host (`hud/mac/main.swift`) syncs appearance:

1. `NSVisualEffectView` with `.hudWindow` material behind chip
2. `NSApp.effectiveAppearance` observation
3. Injects `data-theme` and `data-appearance` via JavaScript
