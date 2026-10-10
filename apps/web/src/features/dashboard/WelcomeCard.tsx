import { PartyPopper } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { setWelcomeBusiness, welcomeBusiness } from "../../lib/lastSignIn";

/** Right after sign-up: the business is ready, and the checklist below is where to start. Shown until closed or until the first bill is made. */
export function WelcomeCard({ billed }: { billed?: boolean }) {
  const { t } = useI18n();
  const [business, setBusiness] = useState(welcomeBusiness);
  // Once a bill is made the card has done its job ("make your first bill" no longer fits).
  useEffect(() => {
    if (billed && business) {
      setWelcomeBusiness(null);
      setBusiness("");
    }
  }, [billed, business]);
  if (!business || billed) return null;
  const close = () => {
    setWelcomeBusiness(null);
    setBusiness("");
  };
  return (
    <section aria-labelledby="welcome-title" data-welcome-card className="animate-page relative overflow-hidden rounded-2xl border border-good/25 bg-gradient-to-br from-good-soft via-surface to-accent-soft px-5 py-4 shadow-card">
      <div className="flex flex-wrap items-center gap-4">
        <span className="animate-logo inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-good text-ink-inverse shadow-glow" aria-hidden>
          <PartyPopper size={24} />
        </span>
        <div className="min-w-[12rem] flex-1">
          <h2 id="welcome-title" className="font-display text-[18px] font-semibold text-ink">
            {t("auth.welcomeTitle", { business })}
          </h2>
          <p className="mt-0.5 text-[13.5px] text-ink-2">{t("auth.welcomeBody")}</p>
        </div>
        <Button type="button" variant="secondary" onClick={close}>
          {t("auth.welcomeDismiss")}
        </Button>
      </div>
    </section>
  );
}
