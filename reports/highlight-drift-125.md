# Text window: replacement highlights drift right at 125% display scale (Windows)

Found while taking the Store screenshots from v1.0.0 (2282344) on X1 Nano. App code not changed.

## Symptom

- At 125% display scale, the yellow replacement highlights in the text box sit to the right of the words they mark, and the shift grows toward the right end of a line.
  - en (`highlight-drift-en-125.png`): `um, ` is highlighted as `um, s`; `teh` is highlighted as `eh ` (about 8 px late at x≈570 of 760 px).
  - ja (`highlight-drift-ja-125.png`): small but visible: the `えーと、` box spills into `明`; the `共有ホルダー` box is a few px right.
- At 100% scale it does not show: `e2e/screenshots/draft-scrolling-en-light.png` from an earlier `just e2e rendering` run at 100% has `e.g.` / `ください` aligned across full lines.

## Conditions

- Windows 11, display 1728×1080 logical at 125% (physical 2160×1350), WebView2.
- Release build (`pnpm tauri build --no-bundle`, LTO off), E2E profile, default text font settings, light theme.
- Text window client 760×460 physical (608×368 logical).
- Text: `Tomorrow's meeting has moved to 10 AM, um, so please check teh new invite.` with replacements `um, `→(empty), `teh`→`the`, `asap`→`as soon as possible`.

## Not verified

- Cause. Guess: the highlight layer and the textarea lay out text with different subpixel advances at a fractional device pixel ratio (different `font-kerning` / `text-rendering` / letter-spacing, or the layer snapped to whole pixels), so the error accumulates along a line.
- Whether macOS / Linux at fractional scales show the same.
- `findHighlightProblems` (`e2e/lib/rendering.mjs`) only compares wrap widths, so a horizontal drift within a line is not caught; `just e2e rendering` runs at whatever scale the machine has.

## Impact on the Store screenshots

The en `1-text.png` in knowledge `04-resources/projects/mawok/store-assets/en-US/` shows the drift. Retaking at 100% scale, or after a fix, gives aligned highlights.
