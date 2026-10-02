import { Server } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { checkServer, needsServer, onServerChange, serverOrigin, setServerOrigin, type ServerProblem } from "../../platform/server";
import { AuthLayout } from "./AuthPage";

/** Whether the Android app still needs its server's address (follows a change). */
export function useNeedsServer(): boolean {
  return useSyncExternalStore(onServerChange, needsServer, needsServer);
}

/**
 * The Android app's first screen: the address of the business's Digital Bahi
 * server (each business runs its own), checked before it is kept.
 */
export function ServerSetup() {
  const { t } = useI18n();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ServerProblem | null>(null);
  const connect = async () => {
    setBusy(true);
    setProblem(null);
    const result = await checkServer(address);
    setBusy(false);
    if ("problem" in result) setProblem(result.problem);
    else setServerOrigin(result.origin);
  };
  return (
    <AuthLayout>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{t("server.title")}</h1>
          <p className="mt-1 text-[14px] text-ink-2">{t("server.hint")}</p>
        </div>
        <Field label={t("server.address")} htmlFor="server-address" error={problem ? t(`server.problems.${problem}`) : undefined}>
          <Input
            id="server-address"
            autoFocus
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="billing.yourshop.in"
            leading={<Server size={16} />}
            value={address}
            invalid={Boolean(problem)}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" block disabled={busy || !address.trim()}>
          {busy ? t("server.checking") : t("server.connect")}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** On the sign-in screen in the app: which server, and a way to change it. */
export function ServerLine() {
  const { t } = useI18n();
  const origin = serverOrigin();
  if (!origin) return null;
  return (
    <p className="flex flex-wrap items-center justify-center gap-1 text-[12.5px] text-ink-3">
      <Server size={13} aria-hidden />
      {new URL(origin).host}
      <button type="button" className="font-medium text-accent hover:underline" onClick={() => setServerOrigin(null)}>
        {t("server.change")}
      </button>
    </p>
  );
}
