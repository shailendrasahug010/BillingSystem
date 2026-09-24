import { useEffect, useId, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Several documents can be mounted at once (an invoice page with a credit
// note dialog open over it); the most recently opened one is printed.
let stack: string[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const top = () => stack.at(-1) ?? null;

/**
 * Renders a document (invoice, receipt, note) straight under <body>, hidden
 * on screen. When printing, it is the only thing on the page: no sidebar,
 * header or dialog chrome, and "Save as PDF" in the print dialog gives a
 * clean file.
 */
export function PrintPortal({ children }: { children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    stack = [...stack, id];
    emit();
    return () => {
      stack = stack.filter((x) => x !== id);
      emit();
    };
  }, [id]);
  const active = useSyncExternalStore(subscribe, top, top) === id;
  if (!active) return null;
  return createPortal(<div className="print-root">{children}</div>, document.body);
}
