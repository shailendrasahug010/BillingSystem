import { useEffect, useState, type RefObject } from "react";
import { cn } from "../../lib/cn";

interface Section {
  id: string;
  label: string;
}

/**
 * The settings' sections as a list beside them (a row of chips on a phone): each card's
 * own heading, found on the page, so a card added later is listed without touching this.
 * Tapping one scrolls to it; the one in view is marked.
 */
export function SectionNav({ content, label }: { content: RefObject<HTMLElement | null>; label: string }) {
  const [sections, setSections] = useState<Section[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const root = content.current;
    if (!root) return;
    const read = () => {
      const found = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2")).map((h, i) => {
        // A heading that appears later can take an earlier one's place in the order, so a
        // number already used is skipped rather than given out twice.
        if (!h.id) {
          let n = i;
          while (document.getElementById(`settings-section-${n}`)) n++;
          h.id = `settings-section-${n}`;
        }
        h.style.scrollMarginTop = "96px";
        return { id: h.id, label: h.textContent?.trim() ?? "" };
      });
      setSections((before) => (before.length === found.length && before.every((s, i) => s.id === found[i]!.id && s.label === found[i]!.label) ? before : found));
    };
    read();
    // Cards that load later (the business's own settings) join the list when they appear.
    const watch = new MutationObserver(read);
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [content]);

  useEffect(() => {
    const root = content.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) seen.observe(el);
    });
    return () => seen.disconnect();
  }, [content, sections]);

  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };

  if (sections.length < 3) return null;
  return (
    <nav aria-label={label} className="scroll-x -mx-1 flex gap-1.5 px-1 pb-1 lg:sticky lg:top-20 lg:mx-0 lg:flex-col lg:gap-0.5 lg:px-0">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          aria-current={active === s.id ? "true" : undefined}
          onClick={() => go(s.id)}
          className={cn(
            "press shrink-0 rounded-full border px-3 py-1.5 text-left text-[13px] font-medium whitespace-nowrap lg:rounded-lg lg:border-0 lg:py-2 lg:whitespace-normal",
            active === s.id ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:text-ink lg:bg-transparent lg:hover:bg-surface-2",
          )}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
