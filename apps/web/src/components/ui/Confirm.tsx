import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  /** A red confirm button, for steps that throw something away. */
  danger?: boolean;
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(() => Promise.resolve(false));

/**
 * The app's own "are you sure?" box in place of the browser's confirm():
 * styled like every other dialog, a bottom sheet on phones, translated buttons.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [asked, setAsked] = useState<ConfirmOptions | null>(null);
  const resolve = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback<Ask>(
    (o) =>
      new Promise<boolean>((done) => {
        resolve.current?.(false);
        resolve.current = done;
        setAsked(o);
      }),
    [],
  );
  const answer = (ok: boolean) => {
    resolve.current?.(ok);
    resolve.current = null;
    setAsked(null);
  };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog
        open={asked !== null}
        onOpenChange={(open) => !open && answer(false)}
        title={asked?.title ?? ""}
        size="sm"
        closeLabel={t("common.close")}
        footer={
          <>
            <Button variant="ghost" onClick={() => answer(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant={asked?.danger ? "danger" : "primary"} onClick={() => answer(true)} autoFocus>
              {asked?.confirmLabel}
            </Button>
          </>
        }
      >
        {asked?.body && <p className="text-[14px] text-ink-2">{asked.body}</p>}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Ask {
  return useContext(ConfirmContext);
}
