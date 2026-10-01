import type { OrderStatus } from "@digitalbahi/core";
import type { Tone } from "../components/ui/Badge";

/** One mapping from workflow state to badge tone, used by every list and detail screen. */
export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  draft: "neutral",
  pending: "warn",
  confirmed: "accent",
  packing: "accent",
  packed: "accent",
  dispatched: "accent",
  delivered: "good",
  cancelled: "danger",
};

export const PAYMENT_STATUS_TONE = { unpaid: "neutral", partial: "warn", paid: "good", overdue: "danger" } as const satisfies Record<string, Tone>;
