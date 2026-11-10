/*
 * Client pieces every panel shares. Each plugin's client.js is one self-contained module, so
 * scripts/sync-shared.mjs inlines this file between the `<shared-client:ui-kit>` markers; edit it
 * here, then run `node scripts/sync-shared.mjs`. Expects `React` in scope.
 */

/**
 * Tokens and motion rules shared by every panel (`root` is the panel's root selector):
 * - one header height, motion durations and easing for all four panels;
 * - exit animations for overlays (`dshp-exit-*` classes, paired with usePresence);
 * - prefers-reduced-motion: animations and transitions collapse to an instant change.
 */
function sharedPanelCss(root) {
  return `
${root} { --dshp-header-h: 52px; --dshp-dur-fast: .12s; --dshp-dur: .16s; --dshp-ease-out: cubic-bezier(.2, .8, .2, 1); }
${root} .dshp-exit-fade { animation: dshp-fade-out var(--dshp-dur) var(--dshp-ease-out) forwards; pointer-events: none; }
${root} .dshp-exit-pop { animation: dshp-pop-out var(--dshp-dur) var(--dshp-ease-out) forwards; pointer-events: none; }
${root} .dshp-exit-drawer { animation: dshp-drawer-out var(--dshp-dur) var(--dshp-ease-out) forwards; pointer-events: none; }
@keyframes dshp-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes dshp-pop-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(4px) scale(.985); } }
@keyframes dshp-drawer-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(16px); } }
@media (prefers-reduced-motion: reduce) {
  ${root} *, ${root} *::before, ${root} *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important;
  }
}
`;
}

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * Keeps an overlay mounted for `ms` after `value` turns falsy, flagged `exiting`, so it can play an
 * exit animation instead of vanishing. `value` may be a boolean or the object the overlay renders
 * from (the last one is kept while exiting).
 * @returns {{ value: any, exiting: boolean }}
 */
function usePresence(value, ms = 160) {
  const [kept, setKept] = React.useState(value || null);
  const live = Boolean(value);
  React.useEffect(() => {
    if (live) {
      setKept(value);
      return undefined;
    }
    if (!kept) return undefined;
    const timer = setTimeout(() => setKept(null), prefersReducedMotion() ? 0 : ms);
    return () => clearTimeout(timer);
  }, [live, value]);
  return { value: live ? value : kept, exiting: !live && Boolean(kept) };
}
