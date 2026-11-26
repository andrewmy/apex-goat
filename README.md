# APEX GOAT — Alpine Cliff Descent

High-speed 3D alpine cliff descent prototype built with TypeScript, Vite, and Three.js.

https://andrewmy.github.io/apex-goat/

## Controls

Supports both **Keyboard** and **Controller** with automatic HUD glyph switching and dual-rumble haptic feedback.

| Action                   | Keyboard    | Controller (Xbox / PS)                     |
| ------------------------ | ----------- | ------------------------------------------ |
| Sprint / Brake           | `W` / `S`   | `RT` / `LT` (`R2` / `L2`)                  |
| Carve / Steer            | `A` / `D`   | Left Stick / D-Pad                         |
| Leap / Wall-Kick         | `Space`     | `A` / `×`                                  |
| Slope-Pump / Dive / Grip | `Shift`     | `RB` / `B` (`R1` / `○`)                    |
| Headbutt Ram             | `F`         | `X` / `□`                                  |
| Bleat                    | `B`         | `D-Pad ↑` / `R3`                           |
| Toggle Camera            | `C`         | `View` / `Share`                           |
| Instant Restart          | `R`         | `Y` / `△`                                  |
| Last Checkpoint          | `Backspace` | `LB` / `L1`                                |
| Pause / Back             | `Esc` / `P` | `Menu` / `Options` (`B` / `○` closes menu) |

### Controller & Haptics Notes

- **Auto-detection:** Plug in or connect a controller over USB or Bluetooth and press any button—HUD prompts, start tips, and pause controls switch automatically.
- **Rumble:** Dual-rumble haptics fire on headbutt impacts, slope-pump landings, wall-kicks, wipeouts, and loose scree surfing in Chromium browsers (Chrome / Edge on macOS & Windows 11). On Windows 11, DualSense rumble is most reliable over USB-C; Xbox controllers rumble over both USB and Bluetooth.
- **Browser requirement:** The Web Gamepad API requires a secure context (`https://` such as the GitHub Pages link above, or `http://localhost:5173/`).

## Development

```bash
npm install
npm run dev
```

Play: http://localhost:5173/

## Scripts

| Command                | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | Start local Vite dev server on port 5173            |
| `npm run build`        | Typecheck and build production bundle to `dist/`    |
| `npm run preview`      | Preview the production build locally                |
| `npm run typecheck`    | Run TypeScript type checking without emitting files |
| `npm run lint`         | Run Oxlint (with type-aware rules) across the repo  |
| `npm run lint:fix`     | Run Oxlint with automatic fixes                     |
| `npm run format`       | Format files with Oxfmt                             |
| `npm run format:check` | Check formatting with Oxfmt                         |
| `npm run check`        | Run typecheck, lint, format check, and build        |
