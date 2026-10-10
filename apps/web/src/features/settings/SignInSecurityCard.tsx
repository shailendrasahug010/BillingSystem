import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useSession } from "../../app/session";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import type { Settings } from "./shared";

interface RoleRow {
  id: string;
  key: string;
  name: string;
  nameHi: string | null;
}

/**
 * Which roles must sign in with a code from an authenticator app as well as
 * the password or OTP. Until a member of such a role turns it on, the
 * business stays closed to them. Only the owner changes it (an admin cannot
 * excuse themselves), and only once they use it themselves if their own role
 * is asked.
 */
export function SignInSecurityCard() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const owner = Boolean(useSession().me?.business?.isOwner);
  const canSee = allowed("user.view");
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") });
  const roles = useQuery({ queryKey: ["team", "roles"], queryFn: () => api.get<{ data: RoleRow[] }>("/roles").then((r) => r.data), enabled: canSee });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  if (!canSee) return null;
  const chosen = settings.data?.["security.two_step_roles"] ?? [];

  const toggle = async (key: string, on: boolean) => {
    const next = on ? [...chosen, key] : chosen.filter((k) => k !== key);
    setSaving(true);
    setError(null);
    try {
      await api.put("/settings/security.two_step_roles", { value: next });
      qc.setQueryData<Settings>(["settings"], (s) => (s ? { ...s, "security.two_step_roles": next } : s));
      toast({ tone: "success", title: t("settings.saved") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("twoStep.settingsTitle")} short={t("twoStep.settingsShort")} subtitle={t("twoStep.settingsHint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5" data-two-step-roles>
        {error ? <ErrorNote error={error} /> : null}
        {settings.error || roles.error ? <ErrorNote error={settings.error ?? roles.error} onRetry={() => void Promise.all([settings.refetch(), roles.refetch()])} /> : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(roles.data ?? []).map((r) => (
            <Checkbox
              key={r.key}
              label={locale === "hi" && r.nameHi ? r.nameHi : r.name}
              checked={chosen.includes(r.key)}
              disabled={!owner || saving || !settings.data}
              onChange={(v) => void toggle(r.key, v)}
            />
          ))}
        </div>
        <p className="text-[12.5px] text-ink-3">{owner ? t("twoStep.settingsOwnerNote") : t("twoStep.settingsOnlyOwner")}</p>
      </div>
    </Card>
  );
}
