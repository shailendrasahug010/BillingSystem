import { dec, type Dec, type DecimalInput, sum } from "../money/decimal.js";
import { DomainError } from "../errors.js";

/**
 * Sales order workflow: Draft -> Pending -> Confirmed -> Packing -> Packed ->
 * Dispatched -> Delivered, with Cancelled reachable until dispatch.
 *
 * Not every business packs or dispatches separately (a counter-sale wholesaler
 * hands goods over immediately), so steps can be switched off per business.
 * Payment is tracked separately (payment_status) because it happens
 * independently of fulfilment and can be partial at any stage.
 */
export const ORDER_STATUSES = [
  "draft",
  "pending",
  "confirmed",
  "packing",
  "packed",
  "dispatched",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderWorkflowConfig {
  /** Orders need an explicit confirmation (e.g. manager approval / credit check) after being placed. */
  requireConfirmation: boolean;
  /** Warehouse packs orders as a separate step. */
  usePacking: boolean;
  /** Goods leave in a vehicle as a separate step before delivery. */
  useDispatch: boolean;
}

export const DEFAULT_ORDER_WORKFLOW: OrderWorkflowConfig = {
  requireConfirmation: true,
  usePacking: true,
  useDispatch: true,
};

const BASE_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["pending", "confirmed", "cancelled"],
  pending: ["confirmed", "cancelled"],
  confirmed: ["packing", "packed", "dispatched", "delivered", "cancelled"],
  packing: ["packed", "cancelled"],
  packed: ["packing", "dispatched", "delivered", "cancelled"],
  dispatched: ["delivered"],
  delivered: [],
  cancelled: [],
};

export function allowedTransitions(from: OrderStatus, config: OrderWorkflowConfig = DEFAULT_ORDER_WORKFLOW): OrderStatus[] {
  return BASE_TRANSITIONS[from].filter((to) => {
    if (!config.requireConfirmation && to === "pending") return false;
    if (config.requireConfirmation && from === "draft" && to === "confirmed") return false;
    if (!config.usePacking && (to === "packing" || to === "packed")) return false;
    if (config.usePacking && from === "confirmed" && (to === "dispatched" || to === "delivered")) return false;
    if (!config.useDispatch && to === "dispatched") return false;
    if (config.useDispatch && (from === "confirmed" || from === "packed") && to === "delivered") return false;
    return true;
  });
}

export class InvalidTransitionError extends DomainError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super("INVALID_STATUS_TRANSITION", `Cannot move an order from ${from} to ${to}`, { from, to });
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus, config?: OrderWorkflowConfig): void {
  if (!allowedTransitions(from, config).includes(to)) throw new InvalidTransitionError(from, to);
}

export interface FulfilmentLine {
  orderedQty: DecimalInput;
  packedQty?: DecimalInput;
  dispatchedQty?: DecimalInput;
  deliveredQty?: DecimalInput;
  cancelledQty?: DecimalInput;
}

export interface FulfilmentProgress {
  ordered: Dec;
  packed: Dec;
  dispatched: Dec;
  delivered: Dec;
  /** Fractions 0..1, for progress bars. */
  packedRatio: number;
  dispatchedRatio: number;
  deliveredRatio: number;
}

export function fulfilmentProgress(lines: readonly FulfilmentLine[]): FulfilmentProgress {
  const effective = (l: FulfilmentLine) => dec(l.orderedQty).minus(dec(l.cancelledQty ?? 0));
  const ordered = sum(lines.map(effective));
  const packed = sum(lines.map((l) => l.packedQty ?? 0));
  const dispatched = sum(lines.map((l) => l.dispatchedQty ?? 0));
  const delivered = sum(lines.map((l) => l.deliveredQty ?? 0));
  const ratio = (x: Dec) => (ordered.isZero() ? 0 : Math.min(1, x.dividedBy(ordered).toNumber()));
  return {
    ordered,
    packed,
    dispatched,
    delivered,
    packedRatio: ratio(packed),
    dispatchedRatio: ratio(dispatched),
    deliveredRatio: ratio(delivered),
  };
}

/**
 * Status implied by line quantities. Partial packing keeps the order in
 * "packing"; the order only becomes "packed" / "dispatched" / "delivered" when
 * every line reached that stage. The partial ratios are shown in the UI.
 */
export function deriveFulfilmentStatus(
  current: OrderStatus,
  lines: readonly FulfilmentLine[],
  config: OrderWorkflowConfig = DEFAULT_ORDER_WORKFLOW,
): OrderStatus {
  if (current === "cancelled" || current === "draft" || current === "pending") return current;
  const p = fulfilmentProgress(lines);
  if (p.ordered.isZero()) return current;
  if (p.deliveredRatio >= 1) return "delivered";
  if (config.useDispatch && p.dispatchedRatio >= 1) return "dispatched";
  if (config.usePacking) {
    if (p.packedRatio >= 1) return "packed";
    if (p.packed.gt(0)) return "packing";
  }
  return current === "confirmed" || current === "packing" || current === "packed" ? current : "confirmed";
}

export interface StatusChange {
  from: OrderStatus | null;
  to: OrderStatus;
  at: string;
  by: string;
  note?: string;
}
