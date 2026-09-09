# Baton app settings

Open the control panel with `baton app`, then choose **Settings** or press
<kbd>Command</kbd>–<kbd>,</kbd>. `baton hud` remains a compatibility alias.

## Preferences

| Preference | Default | Where it applies |
|---|---|---|
| Theme | System | macOS app and browser control panel |
| Motion | System | macOS app and browser control panel |
| Open as | Last used view | macOS app and browser control panel |
| Keep control panel on top | Off | macOS app; compact launcher always floats |
| Launch at login | Off | macOS 13+ app |
| Restore last project | On | macOS app and browser control panel |
| Confirm Stop all | On | Browser/app toolbar; the native menu always confirms |

Theme, motion, layout, and project preferences are stored locally by the
control panel. Native window and login preferences are stored in macOS
`UserDefaults`. Baton does not sync preferences or send them to a service.

## Keyboard controls

- <kbd>Control</kbd>–<kbd>Option</kbd>–<kbd>B</kbd>: show or hide Baton from any app on macOS.
- <kbd>Command</kbd>–<kbd>,</kbd>: open Settings.
- <kbd>r</kbd>: hot reload the running sessions in view.
- <kbd>R</kbd>: hot restart the running sessions in view.
- <kbd>Escape</kbd>: close Settings or leave a focused field.

## Why the command used to be called `hud`

The first interface was a tiny heads-up display over the desktop, so the
implementation and command were named HUD. Baton has grown into a normal
control panel with project navigation, run history, logs, network inspection,
diagnostics, and launch configuration editing. “Control panel” now describes
the product more accurately. Internal filenames and `baton hud` stay in place
to avoid breaking existing scripts and installations.
