import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useI18n } from "../../app/i18n";
import { BUSINESS } from "../../data/db";
import { LIVE } from "../../data/source";
import { useStoreVersion } from "../../data/store";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { tintFor } from "../ui/misc";

/**
 * Two identities appear in the app. Digital Bahi is the software: its mark,
 * name and tagline on the sign-in screen, the menu and the installed app's
 * icon. The firm is the business using it: its own logo, name, address and
 * contact details in the menu and at the top of every printed document.
 */
export const DIGITAL_BAHI_MARK = "/brand/digital-bahi-mark.webp";
export const DIGITAL_BAHI_LOGO = "/brand/digital-bahi-logo.webp";

/** "Digital" in navy, "Bahi" in green, as in the logo. */
export function Wordmark({ inverse, className }: { inverse?: boolean; className?: string }) {
  return (
    <span className={cn("font-display font-bold tracking-tight whitespace-nowrap", className)}>
      <span className={inverse ? "text-white" : "text-brand-navy"}>Digital</span>
      <span className={inverse ? "text-[#a6e08f]" : "text-brand-green"}>Bahi</span>
    </span>
  );
}

/** The Digital Bahi mark and name; `tagline` adds "Aapke Business ka Digital Hisab". */
export function BrandMark({ compact, inverse, tagline }: { compact?: boolean; inverse?: boolean; tagline?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <span className={cn("flex shrink-0 items-center justify-center", inverse && "rounded-lg bg-white px-1 py-0.5")}>
        <img src={DIGITAL_BAHI_MARK} alt={compact ? "Digital Bahi" : ""} width={48} height={32} className="h-8 w-12 object-contain" />
      </span>
      {!compact && (
        <span className="flex min-w-0 flex-col">
          <Wordmark inverse={inverse} className="text-[19px] leading-none" />
          {tagline && <span className={cn("mt-1 truncate text-[10px] leading-none tracking-tight", inverse ? "text-white/80" : "text-ink-3")}>{t("app.brandTagline")}</span>}
        </span>
      )}
    </div>
  );
}

/** The firm's uploaded logo as a data URL (works on screen and in print), or null. */
export function useFirmLogo(): string | null {
  useStoreVersion();
  const id = LIVE ? (BUSINESS.logoFileId ?? null) : null;
  const q = useQuery({
    queryKey: ["firm-logo", id],
    queryFn: () => api.get<{ dataUrl: string }>("/business/logo"),
    enabled: Boolean(id),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return id ? (q.data?.dataUrl ?? null) : null;
}

/** The firm's logo, or its initials when none is uploaded. */
export function FirmLogo({ size = 40, className }: { size?: number; className?: string }) {
  const logo = useFirmLogo();
  const initials = BUSINESS.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg", logo ? "border border-line bg-white" : tintFor(BUSINESS.name || "Firm"), className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {logo ? (
        <img src={logo} alt="" className="size-full object-contain p-0.5" />
      ) : initials ? (
        <span className="font-display font-semibold" style={{ fontSize: Math.round(size * 0.38) }}>
          {initials}
        </span>
      ) : (
        <Building2 size={Math.round(size * 0.5)} />
      )}
    </span>
  );
}

/**
 * The firm's letterhead for printed documents: logo, name, address, phone,
 * email and GSTIN. `detail="short"` keeps to name, city and phone (packing
 * slips, trip sheets).
 */
export function FirmHeader({ detail = "full" }: { detail?: "full" | "short" }) {
  const logo = useFirmLogo();
  const contact = detail === "full" ? [BUSINESS.phone, BUSINESS.email] : [BUSINESS.phone];
  return (
    <div className="flex min-w-0 items-start gap-3" data-letterhead>
      {logo && <img src={logo} alt="" className={cn("shrink-0 object-contain", detail === "full" ? "h-16 w-16" : "h-12 w-12")} />}
      <div className="min-w-0">
        <h2 className={cn("leading-tight font-bold text-[#0b2d72]", detail === "full" ? "text-[22px]" : "text-[18px]")} style={{ fontFamily: "var(--font-display)" }}>
          {BUSINESS.name}
        </h2>
        {detail === "full" && BUSINESS.address && <p>{BUSINESS.address}</p>}
        {BUSINESS.city && <p>{BUSINESS.city}</p>}
        {contact.some(Boolean) && <p>{contact.filter(Boolean).join(" · ")}</p>}
        {detail === "full" && BUSINESS.gstin && <p className="mt-1 font-mono font-medium">GSTIN: {BUSINESS.gstin}</p>}
      </div>
    </div>
  );
}

/** A quiet "Made with Digital Bahi" line at the foot of printed documents. */
export function MadeWithDigitalBahi() {
  const { t } = useI18n();
  const [before, after] = t("app.madeWith", { brand: "\u0000" }).split("\u0000");
  return (
    <p className="mt-4 flex items-center justify-center gap-1 text-[10px] text-[#6a7690]">
      <img src={DIGITAL_BAHI_MARK} alt="" className="mr-0.5 h-3 w-[18px] object-contain" />
      {before}
      <span className="font-semibold">
        <span className="text-[#0b2d72]">Digital</span>
        <span className="text-[#2f8f1f]">Bahi</span>
      </span>
      {after}
    </p>
  );
}
