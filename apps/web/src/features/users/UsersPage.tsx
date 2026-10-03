import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PERMISSION_CATALOG, validateMobile, type PermissionModule } from "@digitalbahi/core";
import type { TranslationKey } from "@digitalbahi/i18n";
import { ShieldPlus, UserPlus } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Avatar } from "../../components/ui/misc";
import { DataTable, ErrorNote, PageHeader, TAB_TRIGGER, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";

interface Member {
  id: string;
  userId: string;
  name: string;
  mobile: string;
  email: string | null;
  /** User ID to sign in with, if the business gave one. */
  username: string | null;
  hasPassword: boolean;
  lastLoginAt: string | null;
  role: { id: string; key: string; name: string };
  isOwner: boolean;
  isActive: boolean;
}

interface Role {
  id: string;
  key: string;
  name: string;
  nameHi: string | null;
  description: string | null;
  isSystem: boolean;
  grants: string[];
  memberCount: number;
}

const MODULES = Object.keys(PERMISSION_CATALOG) as PermissionModule[];

function useTeam() {
  const members = useQuery({ queryKey: ["team", "members"], queryFn: () => api.get<{ data: Member[] }>("/members").then((r) => r.data) });
  const roles = useQuery({ queryKey: ["team", "roles"], queryFn: () => api.get<{ data: Role[] }>("/roles").then((r) => r.data) });
  return { members, roles };
}

const USERNAME = /^[a-z][a-z0-9._-]{2,29}$/;

/**
 * Team and access. People sign in with their mobile number (OTP), or with a
 * user ID and password the owner gives them when adding them; the owner
 * (or anyone allowed) adds them with a role. Roles are lists of
 * permissions the business can edit; no one can hand out access they do not
 * hold themselves, and the owner's membership cannot be changed.
 */
export function UsersPage() {
  const { t, locale, dateMedium } = useI18n();
  const { members, roles } = useTeam();
  const [inviting, setInviting] = useState(false);
  const [member, setMember] = useState<Member | null>(null);
  const [role, setRole] = useState<Role | "new" | null>(null);
  const roleName = (r: { name: string; nameHi?: string | null }) => (locale === "hi" && r.nameHi ? r.nameHi : r.name);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("users.title")}
        subtitle={t("users.subtitle")}
        actions={
          <>
            {allowed("user.manage_roles") && (
              <Button icon={<ShieldPlus size={16} />} onClick={() => setRole("new")}>
                {t("users.newRole")}
              </Button>
            )}
            {allowed("user.invite") && (
              <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setInviting(true)}>
                {t("users.invite")}
              </Button>
            )}
          </>
        }
      />
      <Tabs.Root defaultValue="members" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("users.title")}>
          <Tabs.Trigger value="members" className={TAB_TRIGGER}>
            {t("users.members")}
          </Tabs.Trigger>
          <Tabs.Trigger value="roles" className={TAB_TRIGGER}>
            {t("users.roles")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="members">
          {members.error ? <ErrorNote error={members.error} /> : null}
          <DataTable
            rows={members.data ?? []}
            loading={members.isPending}
            rowKey={(m) => m.id}
            onRowClick={(m) => !m.isOwner && setMember(m)}
            columns={[
              {
                key: "name",
                header: t("common.name"),
                render: (m) => (
                  <div className="flex items-center gap-3">
                    <Avatar name={m.name} className="size-8 text-[12px]" />
                    <div>
                      <p className="font-medium text-ink">{m.name}</p>
                      <p className="text-[12px] text-ink-3">
                        {m.mobile}
                        {m.username ? <span className="font-mono"> · {m.username}</span> : ""}
                        {m.email ? ` · ${m.email}` : ""}
                      </p>
                    </div>
                  </div>
                ),
              },
              { key: "role", header: t("users.role"), render: (m) => (m.isOwner ? <Badge tone="accent">{t("users.owner")}</Badge> : <span className="text-ink-2">{m.role.name}</span>) },
              { key: "status", header: t("common.status"), render: (m) => (m.isActive ? <Badge tone="good">{t("common.active")}</Badge> : <Badge tone="danger">{t("common.inactive")}</Badge>) },
              { key: "login", header: t("users.lastLogin"), align: "right", render: (m) => <span className="text-ink-3">{m.lastLoginAt ? dateMedium(m.lastLoginAt.slice(0, 10)) : t("users.never")}</span> },
            ]}
          />
        </Tabs.Content>
        <Tabs.Content value="roles">
          {roles.error ? <ErrorNote error={roles.error} /> : null}
          <DataTable
            rows={roles.data ?? []}
            loading={roles.isPending}
            rowKey={(r) => r.id}
            onRowClick={(r) => setRole(r)}
            columns={[
              {
                key: "name",
                header: t("users.role"),
                render: (r) => (
                  <div>
                    <p className="font-medium text-ink">
                      {roleName(r)} {r.isSystem && <Badge className="ml-1 h-5 text-[11px]">{t("users.systemRole")}</Badge>}
                    </p>
                    {r.description && <p className="text-[12px] text-ink-3">{r.description}</p>}
                  </div>
                ),
              },
              { key: "grants", header: t("users.permissions"), render: (r) => <span className="text-ink-2">{r.grants.includes("*") ? t("users.everything") : t("users.permissionCount", { count: r.grants.length })}</span> },
              { key: "members", header: t("users.members"), align: "right", render: (r) => r.memberCount },
            ]}
          />
        </Tabs.Content>
      </Tabs.Root>
      <InviteDialog open={inviting} onOpenChange={setInviting} roles={roles.data ?? []} />
      <MemberDialog member={member} onClose={() => setMember(null)} roles={roles.data ?? []} />
      <RoleDialog role={role} onClose={() => setRole(null)} />
    </div>
  );
}

function InviteDialog({ open, onOpenChange, roles }: { open: boolean; onOpenChange(v: boolean): void; roles: Role[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", mobile: "", email: "", roleId: "", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);
  const assignable = roles.filter((r) => !r.grants.includes("*"));
  useEffect(() => {
    if (open) {
      setForm({ name: "", mobile: "", email: "", roleId: assignable.find((r) => r.key === "sales")?.id ?? assignable[0]?.id ?? "", username: "", password: "" });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const mobileBad = form.mobile !== "" && validateMobile(form.mobile).length > 0;
  const username = form.username.trim().toLowerCase();
  const usernameBad = username !== "" && !USERNAME.test(username);
  const passwordBad = form.password !== "" && form.password.length < 8;
  const ok = form.name.trim().length >= 2 && form.mobile && !mobileBad && form.roleId && !usernameBad && !passwordBad && !(username && !form.password);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await api.post<Member & { existingAccount: boolean }>("/members", {
        name: form.name.trim(),
        mobile: form.mobile,
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
        roleId: form.roleId,
        ...(username ? { username } : {}),
        ...(form.password ? { password: form.password } : {}),
      });
      void qc.invalidateQueries({ queryKey: ["team"] });
      const body = m.existingAccount
        ? t("users.existingAccount", { name: m.name })
        : m.username && form.password
          ? t("users.invitedWithLogin", { name: m.name, username: m.username })
          : form.password
            ? t("users.invitedWithPassword", { name: m.name, mobile: m.mobile })
            : t("users.invitedHint", { name: m.name, mobile: m.mobile });
      toast({ tone: "success", title: t("users.invited"), body });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("users.invite")}
      description={t("users.inviteHint")}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ok} onClick={() => void save()}>
            {t("users.invite")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <Field label={t("common.name")} htmlFor="inv-name" error={fieldError("name")}>
          <Input id="inv-name" autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label={t("auth.mobile")} htmlFor="inv-mobile" error={mobileBad ? t("validation.mobile") : fieldError("mobile")}>
          <Input id="inv-mobile" inputMode="tel" value={form.mobile} onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))} />
        </Field>
        <Field label={t("auth.email")} htmlFor="inv-email" hint={t("common.optional")} error={fieldError("email")}>
          <Input id="inv-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("users.username")} htmlFor="inv-username" hint={t("users.usernameHint")} error={usernameBad ? t("users.usernameHint") : fieldError("username")}>
            <Input id="inv-username" autoComplete="off" autoCapitalize="none" spellCheck={false} className="[&_input]:font-mono" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.replace(/\s/g, "") }))} />
          </Field>
          <Field label={t("users.password")} htmlFor="inv-password" hint={t("users.passwordHint")} error={passwordBad || (username && !form.password) ? t("users.passwordHint") : fieldError("password")}>
            <Input id="inv-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
          </Field>
        </div>
        <Field label={t("users.role")} htmlFor="inv-role" error={fieldError("roleId")}>
          <Select id="inv-role" value={form.roleId} onChange={(e) => setForm((f) => ({ ...f, roleId: e.target.value }))}>
            {assignable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function MemberDialog({ member, onClose, roles }: { member: Member | null; onClose(): void; roles: Role[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [login, setLogin] = useState({ username: "", password: "" });
  useEffect(() => {
    setRoleId(member?.role.id ?? "");
    setLogin({ username: member?.username ?? "", password: "" });
    setError(null);
  }, [member]);
  const username = login.username.trim().toLowerCase();
  const loginChanged = Boolean(member) && (username !== (member?.username ?? "") || login.password !== "");
  const loginBad = (username !== "" && !USERNAME.test(username)) || (login.password !== "" && login.password.length < 8);
  const saveLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/members/${member!.id}/credentials`, {
        ...(username !== (member!.username ?? "") ? { username: username || null } : {}),
        ...(login.password ? { password: login.password } : {}),
      });
      void qc.invalidateQueries({ queryKey: ["team"] });
      toast({ tone: "success", title: t("users.signInSaved"), body: member!.name });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const ways = member ? [member.username, member.hasPassword ? `${member.mobile} + ${t("users.password").toLowerCase()}` : null, t("users.otpOnly", { mobile: member.mobile })].filter(Boolean).join(" · ") : "";
  const patch = async (body: { roleId?: string; isActive?: boolean }, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/members/${member!.id}`, body);
      void qc.invalidateQueries({ queryKey: ["team"] });
      toast({ tone: "success", title: done, body: member!.name });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={Boolean(member)}
      onOpenChange={(v) => !v && onClose()}
      title={member?.name ?? ""}
      description={member?.mobile}
      closeLabel={t("common.close")}
      footer={
        member ? (
          <>
            {allowed("user.deactivate") && (
              <Button variant={member.isActive ? "danger" : "secondary"} disabled={busy} onClick={() => void patch({ isActive: !member.isActive }, member.isActive ? t("users.deactivated") : t("users.activated"))}>
                {member.isActive ? t("users.deactivate") : t("users.activate")}
              </Button>
            )}
            {allowed("user.update") && (
              <Button variant="primary" disabled={busy || roleId === member.role.id} onClick={() => void patch({ roleId }, t("users.roleChanged"))}>
                {t("common.save")}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <Field label={t("users.role")} htmlFor="m-role" hint={member?.isActive === false ? t("users.inactiveHint") : undefined}>
          <Select id="m-role" value={roleId} disabled={!allowed("user.update")} onChange={(e) => setRoleId(e.target.value)}>
            {roles
              .filter((r) => !r.grants.includes("*"))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </Select>
        </Field>
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">{t("users.signIn")}</h3>
            <p className="text-[12.5px] text-ink-3">{t("users.signInWith", { ways })}</p>
          </div>
          {allowed("user.update") && (
            <>
              <p className="text-[12px] text-ink-3">{t("users.signInHint")}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("users.username")} htmlFor="m-username" hint={t("common.optional")}>
                  <Input id="m-username" autoComplete="off" autoCapitalize="none" spellCheck={false} className="[&_input]:font-mono" value={login.username} onChange={(e) => setLogin((l) => ({ ...l, username: e.target.value.replace(/\s/g, "") }))} />
                </Field>
                <Field label={t("users.newPassword")} htmlFor="m-password" hint={t("users.passwordHint")}>
                  <Input id="m-password" type="password" autoComplete="new-password" value={login.password} onChange={(e) => setLogin((l) => ({ ...l, password: e.target.value }))} />
                </Field>
              </div>
              <div>
                <Button disabled={busy || !loginChanged || loginBad} onClick={() => void saveLogin()}>
                  {t("users.saveSignIn")}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}

function RoleDialog({ role, onClose }: { role: Role | "new" | null; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const isNew = role === "new";
  const existing = role && role !== "new" ? role : null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const everything = grants.has("*");
  const readOnly = !allowed("user.manage_roles") || everything;

  useEffect(() => {
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setGrants(new Set(existing?.grants ?? ["dashboard.view"]));
    setError(null);
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  const has = (module: string, action: string) => everything || grants.has(`${module}.*`) || grants.has(`${module}.${action}`);
  const toggle = (module: PermissionModule, action: string, on: boolean) =>
    setGrants((g) => {
      const next = new Set(g);
      if (next.has(`${module}.*`)) {
        next.delete(`${module}.*`);
        for (const a of PERMISSION_CATALOG[module]) next.add(`${module}.${a}`);
      }
      if (on) next.add(`${module}.${action}`);
      else next.delete(`${module}.${action}`);
      return next;
    });
  const toggleModule = (module: PermissionModule, on: boolean) =>
    setGrants((g) => {
      const next = new Set([...g].filter((x) => !x.startsWith(`${module}.`)));
      if (on) next.add(`${module}.*`);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = [...grants].sort();
      if (isNew) {
        const key = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/^(\d)/, "r_$1")
          .slice(0, 40);
        await api.post("/roles", { key: key.length >= 2 ? key : `role_${Date.now().toString(36)}`, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), grants: list });
      } else if (existing) {
        if (name.trim() !== existing.name || description.trim() !== (existing.description ?? "")) {
          await api.patch(`/roles/${existing.id}`, { name: name.trim(), description: description.trim() });
        }
        if (JSON.stringify(list) !== JSON.stringify([...existing.grants].sort())) await api.put(`/roles/${existing.id}/permissions`, { grants: list });
      }
      void qc.invalidateQueries({ queryKey: ["team"] });
      toast({ tone: "success", title: t("users.roleSaved"), body: name.trim() });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/roles/${existing!.id}`);
      void qc.invalidateQueries({ queryKey: ["team"] });
      toast({ tone: "success", title: t("users.roleDeleted"), body: existing!.name });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={role !== null}
      onOpenChange={(v) => !v && onClose()}
      title={isNew ? t("users.newRole") : (existing?.name ?? "")}
      description={everything ? t("users.ownerRoleHint") : t("users.roleHint")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        !readOnly ? (
          <>
            {existing && !existing.isSystem && (
              <Button variant="ghost" disabled={busy || existing.memberCount > 0} title={existing.memberCount > 0 ? t("errors.ROLE_IN_USE") : undefined} onClick={() => void remove()}>
                {t("common.delete")}
              </Button>
            )}
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={busy || name.trim().length < 2} onClick={() => void save()}>
              {busy ? t("common.saving") : t("common.save")}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("common.name")} htmlFor="r-name">
            <Input id="r-name" autoFocus={isNew} disabled={readOnly} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("users.description")} htmlFor="r-desc" hint={t("common.optional")}>
            <Input id="r-desc" disabled={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {MODULES.map((m) => {
            const actions = PERMISSION_CATALOG[m];
            const all = everything || grants.has(`${m}.*`) || actions.every((a) => grants.has(`${m}.${a}`));
            return (
              <fieldset key={m} className="rounded-lg border border-line p-3">
                <legend className="px-1">
                  <Checkbox
                    label={<span className="font-semibold text-ink">{t(`perm.modules.${m}` as TranslationKey)}</span>}
                    checked={all}
                    disabled={readOnly || !actions.every((a) => allowed(`${m}.${a}`))}
                    onChange={(v) => toggleModule(m, v)}
                  />
                </legend>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                  {actions.map((a) => (
                    <Checkbox
                      key={a}
                      className="text-[13px]"
                      label={t(`perm.actions.${a}` as TranslationKey)}
                      checked={has(m, a)}
                      disabled={readOnly || !allowed(`${m}.${a}`)}
                      onChange={(v) => toggle(m, a, v)}
                    />
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
