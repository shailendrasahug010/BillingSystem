import { WifiOff } from "lucide-react";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import type { Outcome, TodayCall } from "./data";

const OUTCOME_TONE: Record<Outcome, Tone> = { bill: "good", order: "good", payment: "accent", note: "neutral", no_order: "warn", visited: "neutral" };

/** What came of today's call: billed ₹, order ₹, payment ₹, no order (why), visited. */
export function CallBadge({ call }: { call: TodayCall }) {
  const { t, money } = useI18n();
  const amount = call.outcome === "bill" ? call.billed : call.outcome === "order" ? call.ordered : call.outcome === "payment" ? call.collected : 0;
  const text =
    call.outcome === "no_order"
      ? `${t("beat.outcome.no_order")}${call.reason ? `: ${t(`beat.reasons.${call.reason as "other"}`)}` : ""}`
      : amount > 0
        ? `${t(`beat.outcome.${call.outcome}`)} ${money(amount, 0)}`
        : t(`beat.outcome.${call.outcome}`);
  return (
    <Badge tone={OUTCOME_TONE[call.outcome]} dot>
      {text}
      {call.waiting && <span className="sr-only"> · {t("beat.waitingHere")}</span>}
      {call.waiting && <WifiOff size={11} aria-hidden />}
    </Badge>
  );
}
