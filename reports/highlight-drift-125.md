# Text window: replacement highlights do not sit on the words they mark

Found while taking the Store screenshots from v1.0.0 (2282344) on X1 Nano. App code not changed.

## Symptom

- The yellow replacement highlights in the text box sit to the right of the words they mark on the first line, and on a wrapped line a highlight can be a whole character off.
  - en (`highlight-drift-en-125.png`): `um, ` is highlighted as `um, s`; `teh` is highlighted as `eh `.
  - ja (`highlight-drift-ja-125.png`): the `えーと、` box spills into `明`.
- Earlier I wrote that 100% scale does not show it. That was wrong: cause 1 below does not depend on the scale. Cause 2 needs a fractional scale (125% here).

## Cause (found with live CDP on Windows at 125%)

Method: release `mawok.exe` from v1.0.0 with the E2E profile and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`, text set through CDP, overlay text made red and textarea text blue so the two layouts can be compared (`highlight-drift-ghost-*.png`).

1. **A stray space at the start of the overlay.** In `src/routes/+page.svelte` (overlay inner div), the line break between `{#if text === '' && guidance}...{/if}` and `{#each previewSegmentsList ...}` becomes a `" "` text node. The overlay is `white-space: pre-wrap`, so it renders as a leading space: the whole first paragraph of the overlay starts one space width (4.4 px at 15 px) to the right, and the overlay can wrap that paragraph at a different place than the textarea. Measured: first glyph of the overlay at x=23.19, textarea content starts at x=18.8. Removing the text node puts the first glyph at 18.80 and line 1 overlaps exactly (`highlight-drift-ghost-before-line1.png` vs `highlight-drift-ghost-space-only.png`). This is in the DOM on every OS, so it likely explains the macOS drift too (not checked on macOS).
2. **The overlay is 0.4 px narrower than the textarea content at 125%.** `measureScrollbar()` computes `offsetWidth - clientWidth - borders`. At 125% a 1 px border computes as `0.8px` (snapped to one device pixel), while `offsetWidth` / `clientWidth` are rounded integers, so with no scrollbar it gives `544 - 542 - 1.6 = 0.4` and sets `right: 0.4px` on the overlay. The overlay then wraps a nearly full line one character earlier: in the ja sample `置` moved to the next line and `下さい` was highlighted as `さい。` (`highlight-drift-ghost-space-only.png`). Setting `right: 0px` fixes it (`highlight-drift-ghost-after.png`). With a scrollbar the same formula gives 15.4 px while the real scrollbar is 15.21 px (ResizeObserver `contentBoxSize` 507.19 vs rect inner 522.4), so the overlay is 0.2 px narrower there too; no wrap change was visible in my long sample.

Ruled out:

- Hypothesis 1 (compositing layer from `transform`): setting the inner div's `transform: none` changed nothing. It was `translate(0px, 0px)`, a 2D transform that does not create a layer anyway.
- Hypothesis 2 (CSS mismatch): every computed property that affects text is the same on the textarea and the overlay (only `row-rule-color` / `--tw-outline-style` differ). Glyph advances match once the space is removed (line 1 overlaps pixel for pixel).
- Hypothesis 3 (`rounded-[0.1em]` / `<mark>`): not needed; with the two fixes and the marks unchanged, all highlights align.

Before / after (same text, normal colours): `highlight-drift-cdp-before.png` → `highlight-drift-cdp-after.png`.

## Proposed minimal change (not committed)

1. Keep the `{#if}` and `{#each}` on the same line with no whitespace between them (or wrap them so no text node is created), e.g.

   ```svelte
   <div style="transform: translate({-scrollLeft}px, {-scrollTop}px);">
   	{#if text === '' && guidance}<span class="draft-guidance">{guidance}</span>{/if}{#each previewSegmentsList as segment, index (index)}...{/each}
   </div>
   ```

   The leading newline+tab inside the div is already dropped by Svelte; only the whitespace between the two blocks survives. Worth a regression check in `findHighlightProblems` (`e2e/lib/rendering.mjs`): assert the overlay inner div has no whitespace-only text node, or compare the first glyph's x with the textarea content box.
2. Measure the scrollbar from the textarea's content box instead of integer `offsetWidth` / `clientWidth`, e.g. in a `ResizeObserver` on the textarea: `scrollbarWidth = rect.width - borderL - borderR - paddingL - paddingR - entry.contentBoxSize[0].inlineSize` (measured 15.2125 with a scrollbar, 0 without). A smaller change, `Math.round(...)`, fixes the no-scrollbar case (0.4 → 0) but makes the overlay 0.2 px wider with a scrollbar at 125%.

## Not verified

- macOS (1x, WKWebView) and Linux: whether the two fixes remove the drift there. Cause 1 is platform-independent; the macOS report that ja shifts left is not explained here.
- A wrap mismatch with a scrollbar from the 0.2 px error (not seen in my sample).
