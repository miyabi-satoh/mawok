# Windows findings: 「表示するディスプレイ」=「マウスの位置」 with mixed scaling

Found by `e2e/tests/draft-display.test.mjs` on Aero (app code = 656f159). Not fixed (app code is mac's).

## Setup

- Display 1 (primary, built-in): bounds 0,0 1920×1200, work area y=32 h=1168, 100%.
- Display 2 (external): bounds 1920,0 2560×1440, work area y=48 h=1392, 150%.
- Both at 100%: both tests pass.

## Symptom

Window placed at the bottom-right of display 1 → pointer on display 2 → hotkey: correct, bottom-right of display 2 (visible frame 3634,850 846×590; the window grew to 150%).

Then pointer on display 1 → hotkey: visible frame 1072,610 562×392. Expected bottom-right (1358,808). Right gap 286, bottom gap 198.

## Cause (from the numbers)

The target position is computed with the size the window had on display 2 (846×590): 1920−846 = 1074 ≈ 1072, 1200−590 = 610. After the move the window crosses to the 100% display, gets WM_DPICHANGED and shrinks to 562×392, keeping its top-left. So the relative position is lost when moving from a higher to a lower scale.

The low → high direction is fine.

Size and position still stay inside the work area, because the window only shrinks.

## Suggestion

Compute the position with the size the window will have on the target display (current size × target scale / current scale), or re-run the placement after the DPI change.
