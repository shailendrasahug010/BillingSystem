import type { Suggestion } from "@digitalbahi/core";
import { useMemo, useRef } from "react";
import { LIVE } from "../../data/source";
import { api, newIdempotencyKey } from "../../lib/api";

/** One suggestion as offered or taken, as POST /suggestions/feedback takes it. */
interface Item {
  productId: string;
  group: Suggestion["group"];
  /** Position in the whole list of suggestions, 1 = first. */
  rank: number;
  reasons: string[];
}

/** The server keeps at most this many of each per bill. */
const MAX_ITEMS = 50;

const itemOf = (s: Suggestion, all: Suggestion[]): Item => ({
  productId: s.productId,
  group: s.group,
  rank: all.findIndex((x) => x.productId === s.productId) + 1,
  reasons: [...new Set(s.reasons.map((r) => r.code))].slice(0, 8),
});

/**
 * What the billing screen offered and what the user took from it, for one
 * bill (docs/07 §12: acceptance by reason and position, and the share of bill
 * lines that came from suggestions). Kept in memory; sent once, after the bill
 * is saved online. Nothing is sent for a bill saved offline or not saved.
 */
export interface SuggestionFeedback {
  /** The suggestions on screen now; ranks are positions in `all`. */
  offered(visible: Suggestion[], all: Suggestion[]): void;
  /** A suggestion was added to the bill. */
  taken(productId: string, all: Suggestion[]): void;
  /** Sends it with the saved bill (taken ones still on the bill), then starts over. Never throws. */
  send(invoiceId: string, billProductIds: readonly string[]): void;
  /** Starts over without sending. */
  reset(): void;
}

interface Session {
  id: string;
  customerId: string | null;
  shown: Map<string, Item>;
  added: Map<string, Item>;
}

const fresh = (customerId: string | null): Session => ({ id: newIdempotencyKey(), customerId, shown: new Map(), added: new Map() });

export function useSuggestionFeedback(customerId: string | null): SuggestionFeedback {
  const customer = useRef(customerId);
  customer.current = customerId;
  const session = useRef<Session>(fresh(customerId));
  return useMemo<SuggestionFeedback>(() => {
    /** The session for the customer now on the bill: another customer starts a new one. */
    const current = () => {
      if (session.current.customerId !== customer.current) session.current = fresh(customer.current);
      return session.current;
    };
    return {
      offered(visible, all) {
        const s = current();
        for (const sug of visible) {
          if (!s.shown.has(sug.productId) && s.shown.size < MAX_ITEMS) s.shown.set(sug.productId, itemOf(sug, all));
        }
      },
      taken(productId, all) {
        const s = current();
        const sug = all.find((x) => x.productId === productId);
        if (sug && !s.added.has(productId) && s.added.size < MAX_ITEMS) s.added.set(productId, s.shown.get(productId) ?? itemOf(sug, all));
      },
      send(invoiceId, billProductIds) {
        const s = current();
        session.current = fresh(customer.current);
        if (!LIVE || !s.customerId || s.shown.size === 0) return;
        const onBill = new Set(billProductIds);
        void api
          .post("/suggestions/feedback", {
            id: s.id,
            customerId: s.customerId,
            invoiceId,
            shown: [...s.shown.values()],
            added: [...s.added.values()].filter((i) => onBill.has(i.productId)),
          })
          .catch(() => {
            /* best effort: feedback never gets in the way of billing */
          });
      },
      reset() {
        session.current = fresh(customer.current);
      },
    };
  }, []);
}
