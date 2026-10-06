/**
 * Rows that scroll sideways (tabs, settings chips, place chips) fade out at the
 * edge that has more to show, so a row cut at "E-" reads as "swipe for more".
 * Marks each such row with data-more="left" / "right" / "both"; the fade itself is in app.css.
 */
const ROWS = '.scroll-x[role="tablist"], nav.scroll-x, .scroll-x[role="group"], .scroll-x[role="radiogroup"], .scroll-x[data-fade]';

function mark(el: HTMLElement) {
  const left = el.scrollLeft > 2;
  const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
  const more = left && right ? "both" : left ? "left" : right ? "right" : "";
  if ((el.dataset.more ?? "") !== more) {
    if (more) el.dataset.more = more;
    else delete el.dataset.more;
  }
}

export function startScrollFade() {
  if (typeof window === "undefined" || typeof ResizeObserver === "undefined") return;
  const seen = new WeakSet<HTMLElement>();
  const sizes = new ResizeObserver((entries) => entries.forEach((e) => mark(e.target as HTMLElement)));
  const scan = () =>
    document.querySelectorAll<HTMLElement>(ROWS).forEach((el) => {
      if (seen.has(el)) return mark(el);
      seen.add(el);
      el.addEventListener("scroll", () => mark(el), { passive: true });
      sizes.observe(el);
      mark(el);
    });
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
}
