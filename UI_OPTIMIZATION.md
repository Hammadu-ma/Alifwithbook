# ALIF UI optimization release

This release applies a cross-screen UI system to the Student App and Admin Dashboard without changing the core feature/data logic.

## Student app
- Removes the two non-essential page animation engines (typewriter heading and MutationObserver-based page transition driver).
- Replaces repeated heavy backdrop blur with crisp surfaces.
- Uses a single layer scale for pages, chrome, overlays, and notifications.
- Makes mobile overlays bottom sheets with safe-area padding.
- Keeps horizontal resource rails horizontally scrollable.
- Uses `content-visibility`/containment for large resource lists.
- Reduces hover/motion on touch-sized viewports and respects reduced motion.

## Admin dashboard
- Unifies sidebar, cards, KPI panels, tables, action bars and modals.
- Removes tab entrance animation and expensive modal blur.
- Keeps the existing responsive sidebar/navigation behavior.
- Converts mobile modals into predictable bottom sheets while preserving fullscreen access tools.
- Adds containment for dense lists/grids.

## Validation
- All JavaScript files pass `node --check` syntax validation.
- Student headless-Chromium validation was attempted locally but could not be completed because the static browser process hung while external module resources were loading; no app exception was established from that attempt.
