import { useEffect, useState } from "react";

/**
 * How tall a list dropped under a field may be and stay in sight: down to the foot of what shows
 * (above a phone's keyboard while it is up), at most `cap` px, at least `floor` px. `el` is the
 * list once shown (the element a callback ref is given), so it is measured where it really is;
 * it follows the keyboard coming up and going down, and the page scrolling.
 */
export function useRoomBelow(el: HTMLElement | null, cap: number, floor = 144): number {
  const [room, setRoom] = useState(cap);
  useEffect(() => {
    if (!el) return;
    const vv = window.visualViewport;
    const measure = () => {
      // Text size (Aa) zooms the page: the room on screen is that many times fewer of its pixels.
      const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-zoom")) || 1;
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const space = (bottom - el.getBoundingClientRect().top - 8) / zoom;
      setRoom(Math.round(Math.min(cap, Math.max(floor, space))));
    };
    measure();
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [el, cap, floor]);
  return room;
}
