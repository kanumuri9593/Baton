# HUD chrome, Dock, and cheap resource numbers

Date: 2026-08-31

Baton’s HUD is a floating utility panel with no Dock tile, a hidden title bar, and a green status LED in the chip and menu bar. This spec makes it behave like a Mac app people already know, without turning the HUD into a normal document window, and adds a cheap per-run memory/CPU reading so a hog is obvious and Stoppable.

## Goals

- Menu bar extra: Baton mark (not a generic green circle), colored by run state, plus live count.
- Dock: full Baton icon. Click restores a hidden or minimized HUD; does not toggle. Cmd-Tab works.
- Expanded HUD: standard traffic lights. Close hides (does not quit). Yellow minimizes to the Dock. Chip/peek densities stay chrome-less.
- Session rows: optional `rss` and `cpu` from one `ps -p` on known pids, piggybacked on the existing sessions poll. Heaviest live run is marked. Stop is the existing stop.
- Sampling must stay cheap. No dedicated Performance tab, no sparklines, no process-tree UI, no VM-service heap, no Simulator.app attribution.

## Non-goals

- Dart heap dumps, GPU, disk I/O
- Killing individual child pids or Simulator.app
- Windows process sampling (absent fields, not a failure)
- Changing Run so it steals keyboard focus from the terminal

## Chrome and identity

The HUD remains an always-on-top `NSPanel` (`nonactivatingPanel`, `becomesKeyOnlyIfNeeded`). Activation policy becomes `.regular` so there is a Dock tile. `LSUIElement` is removed from the generated app plist.

| Surface | Control | Behavior |
| --- | --- | --- |
| Menu bar left-click | Toggle | Hide if shown; show if hidden or miniaturized |
| Menu bar right-click | Menu | Hide/Show HUD, reload/restart/stop all, Open in browser, Quit HUD |
| Dock click / Cmd-Tab | Restore only | Deminiaturize and order front; if already visible, leave it |
| Red traffic light | Hide | `orderOut`; app stays in Dock and menu bar |
| Yellow traffic light | Minimize | Standard miniaturize to Dock |
| Green traffic light | Zoom | Standard zoom, inspector density only |
| Chip / peek | No traffic lights | `fullSizeContentView`, buttons hidden |

Chip face uses the Baton mark (`assets/baton-mark.svg`) instead of `#chipDot`. Color follows the same states as today’s LED: idle, starting (amber), running (green), failed (red). Menu-bar glyph is the same mark, **not** a template image, filled with the same status color. Dock icon is the full tile (`assets/baton.svg` / `baton.icns`), not status-tinted.

Density is sent to the native host on resize (`density: chip \| peek \| inspector`) so traffic lights appear only for inspector.

## Resources

Source of truth is the OS: one `ps -o pid=,pcpu=,rss= -p pid1,pid2,…` for the live session pids. RSS in `ps` is kilobytes; convert to bytes once. No descendant walk.

- `SessionSnapshot` gains optional `pid`, `rssBytes`, `cpuPct`.
- Adapters record the child pid they already spawn. `pid` is always applied in `BaseSession.snapshot()` so a subclass `extraSnapshot()` cannot drop it.
- `sessions` RPC overlays samples. If `ps` fails or the platform has no sampler, snapshots are returned unchanged (no rss/cpu).
- HUD merges those fields on a 2s poll (Swift already polls `sessions`; the page does the same). Menu bar stays mark + count.
- Heaviest = live session with the largest `rssBytes`. Visual hint only; Stop is unchanged.
- Starting / no pid / sample miss → omit the numbers (`—` is not shown; the meta line simply has no size).

## Testing

- Parser and overlay are pure: injected `ps` stdout, no real processes in CI.
- Process session snapshot includes `pid` from an injected spawn.
- `sessions` RPC overlays rss/cpu onto the matching pid and leaves others untouched.
- HUD asset tests: chip mark, density posted to the native host, Swift style mask includes miniaturize, activation policy is regular, plist is not an LSUIElement.
