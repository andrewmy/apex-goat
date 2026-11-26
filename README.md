# APEX GOAT — Alpine Cliff Descent

High-speed 3D alpine cliff descent prototype built with TypeScript, Vite, and Three.js.

https://andrewmy.github.io/apex-goat/

## Controls

- **W / A / S / D** — Sprint, climb & carve
- **Space** — Leap / Wall-Kick
- **Shift** — Hoof-Grip / Slope-Pump (hold mid-air to fast-dive into steep landings)
- **B** — Bleat
- **C** — Toggle camera (Chase Cam / GoPro Action POV)
- **R** — Instant restart
- **Backspace** — Reset to last checkpoint

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
