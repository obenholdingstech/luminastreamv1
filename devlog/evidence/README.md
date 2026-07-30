# Ticket 4 — knob-grid layout evidence

`knob-grid-before-after.png` — the tuning console's knob grid rendered at a
CEO-width viewport (1440px), **before** (`max-w-2xl`, 672px) and **after**
(`max-w-4xl`, 896px) the fix, from the *same* agent broadcast and the *same*
`KnobRow`/`groupKnobs` markup as `src/pages/LiveKitTest.jsx`.

## What it shows

The grid splits to two columns at `lg` (viewport ≥1024px) while the old 672px
container stayed narrow — so each cell was ~320px, and a `<input type="range">`
(which browsers refuse to shrink below its intrinsic width) collapsed to a bare
thumb with no track, colliding with its label/value. That is the residual
collision from #19 ticket 5 that couldn't be live-verified. Widening the dev
console to `max-w-4xl` (896px) gives each 2-column cell ~432px: full sliders,
readable selects, room to spare.

This is a **pure layout** harness — the collision is a CSS/grid/flex property,
so it needs no live agent or LiveKit connection to reproduce faithfully. The
data in `broadcast.json` is the real `agent_config` payload
(`knobs.metadata("tts", …)` + a config snapshot), so every current knob is
present, including the new Loudness and Spend groups and the long cloned-voice
name.

## Reproduce

```bash
cd devlog/evidence
node gen_harness.mjs                                   # broadcast.json → harness.html
printf '@tailwind base;@tailwind components;@tailwind utilities;\n' > input.css
npx tailwindcss@3 -i input.css -o tw.css --content harness.html --minify
npx playwright screenshot --channel chrome --viewport-size 1440,1600 \
  --full-page file://"$PWD"/harness.html knob-grid-before-after.png
```

(`harness.html`, `input.css`, `tw.css` are build artifacts — not committed.)
