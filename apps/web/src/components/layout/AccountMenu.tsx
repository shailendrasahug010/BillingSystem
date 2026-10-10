import { ChevronRight, LogOut, UserRound } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { useSession } from "../../app/session";
import { BUSINESS, WORKSPACE } from "../../data/db";
import { initialsOf } from "../../features/auth/parts";
import { cn } from "../../lib/cn";
import { tintFor } from "../ui/misc";

/**
 * The person's round initials at the top right: who is signed in, in which
 * business, their profile, switching business and Sign out, one tap away on
 * the phone and the computer alike.
 */
export function AccountMenu({ onSignOut }: { onSignOut(): void }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const user = session.user;
  if (!user) return null;
  const role = WORKSPACE.role.replace(/^\w/, (c) => c.toUpperCase());
  const item = "press flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px]";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("auth.account")}
          title={user.name}
          className={cn("press touch-40 ml-0.5 inline-flex size-9 items-center justify-center rounded-full font-display text-[12.5px] font-semibold ring-2 ring-surface transition-shadow hover:ring-accent/30", tintFor(user.name))}
        >
          {initialsOf(user.name)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={12} aria-label={t("auth.account")} className="animate-pop z-50 w-[min(19rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-surface p-2 shadow-pop">
          <div className="flex items-center gap-3 px-2 pt-2 pb-3">
            <span className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-full font-display text-[15px] font-semibold", tintFor(user.name))} aria-hidden>
              {initialsOf(user.name)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[14.5px] font-semibold text-ink">{user.name}</p>
              <p className="truncate text-[12.5px] text-ink-3">{user.email ?? user.mobile}</p>
              <p className="truncate text-[12.5px] text-ink-2">
                {role} · {BUSINESS.name}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-0.5 border-t border-line pt-2">
            <button
              type="button"
              className={cn(item, "text-ink hover:bg-surface-2")}
              onClick={() => {
                setOpen(false);
                navigate({ name: "profile" });
              }}
            >
              <UserRound size={17} className="text-ink-3" />
              <span className="flex-1">{t("auth.myProfile")}</span>
              <ChevronRight size={16} className="text-ink-3" />
            </button>
            {session.businesses.length > 1 && (
              <select
                aria-label={t("auth.switchBusiness")}
                value={WORKSPACE.businessId ?? ""}
                onChange={(e) => {
                  setOpen(false);
                  void session.switchBusiness(e.target.value);
                }}
                className="mx-1 my-1 h-10 rounded-xl border border-line bg-surface px-2 text-[13.5px] text-ink"
              >
                {session.businesses.map((b) => (
                  <option key={b.id} value={b.id} disabled={b.status === "suspended" || b.status === "closed"}>
                    {b.tradeName ?? b.legalName}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={cn(item, "text-danger hover:bg-danger-soft")}
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <LogOut size={17} />
              {t("auth.signOut")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
