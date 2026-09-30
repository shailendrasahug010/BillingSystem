import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { useDepartments, type Employee } from "./api";

const FIELDS = ["name", "mobile", "joiningDate", "designation", "email", "city", "bankAccountName", "bankAccountNumber", "bankIfsc", "pan", "aadhaar", "emergencyContactName", "emergencyContactPhone", "notes", "uan", "esiNumber"] as const;
/** Cleared on an edit by sending null (the others left blank stay as they are). */
const CLEARABLE = new Set(["uan", "esiNumber"]);
type Form = Record<(typeof FIELDS)[number], string> & { departmentId: string; gender: string; pfMember: boolean; epsMember: boolean };
const EMPTY: Form = { ...(Object.fromEntries(FIELDS.map((f) => [f, ""])) as Record<(typeof FIELDS)[number], string>), departmentId: "", joiningDate: TODAY, gender: "", pfMember: true, epsMember: true };

/** Add an employee, or edit one (bank, PAN and Aadhaar left blank stay unchanged). */
export function EmployeeDialog({ open, onOpenChange, employee }: { open: boolean; onOpenChange(v: boolean): void; employee?: Employee | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const departments = useDepartments();
  const [form, setForm] = useState<Form>(EMPTY);
  const [newDept, setNewDept] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewDept("");
    setForm(
      employee
        ? {
            ...EMPTY,
            name: employee.name,
            mobile: employee.mobile,
            joiningDate: employee.joiningDate,
            designation: employee.designation ?? "",
            email: employee.email ?? "",
            city: employee.city ?? "",
            bankAccountName: employee.bankAccountName ?? "",
            bankIfsc: employee.bankIfsc ?? "",
            emergencyContactName: employee.emergencyContactName ?? "",
            emergencyContactPhone: employee.emergencyContactPhone ?? "",
            notes: employee.notes ?? "",
            departmentId: employee.departmentId ?? "",
            uan: employee.uan ?? "",
            esiNumber: employee.esiNumber ?? "",
            gender: employee.gender ?? "",
            pfMember: employee.pfMember,
            epsMember: employee.epsMember,
          }
        : EMPTY,
    );
  }, [open, employee]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let departmentId = form.departmentId;
      if (departmentId === "__new" && newDept.trim()) {
        departmentId = (await api.post<{ id: string }>("/departments", { name: newDept.trim() })).id;
        void qc.invalidateQueries({ queryKey: ["departments"] });
      }
      const body: Record<string, unknown> = {};
      for (const k of FIELDS) {
        const v = form[k].trim();
        if (v) body[k] = k === "pan" || k === "bankIfsc" ? v.toUpperCase() : v;
        else if (employee && CLEARABLE.has(k) && employee[k as "uan" | "esiNumber"]) body[k] = null;
      }
      if (form.gender) body.gender = form.gender;
      else if (employee?.gender) body.gender = null;
      if (!employee || form.pfMember !== employee.pfMember) body.pfMember = form.pfMember;
      if (!employee || form.epsMember !== employee.epsMember) body.epsMember = form.epsMember;
      if (departmentId && departmentId !== "__new") body.departmentId = departmentId;
      const res = employee ? await api.patch<Employee>(`/employees/${employee.id}`, body) : await api.post<Employee>("/employees", body);
      void qc.invalidateQueries({ queryKey: ["employees"] });
      toast({ tone: "success", title: employee ? t("people.updated") : t("people.added"), body: `${res.employeeCode} · ${res.name}` });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const input = (k: (typeof FIELDS)[number], label: string, extra: { hint?: string; type?: string; placeholder?: string; inputMode?: "numeric" | "tel" } = {}) => (
    <Field label={label} htmlFor={`emp-${k}`} {...(extra.hint ? { hint: extra.hint } : {})} error={fieldError(k)}>
      <Input id={`emp-${k}`} type={extra.type ?? "text"} value={form[k]} onChange={set(k)} {...(extra.placeholder ? { placeholder: extra.placeholder } : {})} {...(extra.inputMode ? { inputMode: extra.inputMode } : {})} />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={employee ? `${t("people.edit")} · ${employee.name}` : t("people.add")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || form.name.trim().length < 2 || form.mobile.trim().length < 10 || !form.joiningDate} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {input("name", t("common.name"))}
          {input("mobile", t("common.mobile"), { inputMode: "tel" })}
          {input("joiningDate", t("people.joiningDate"), { type: "date" })}
          {input("designation", t("people.designation"), { hint: t("common.optional") })}
          <Field label={t("people.department")} htmlFor="emp-dept" hint={t("common.optional")}>
            <Select id="emp-dept" value={form.departmentId} onChange={set("departmentId")}>
              <option value="">—</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              <option value="__new">+ {t("people.newDepartment")}</option>
            </Select>
          </Field>
          {form.departmentId === "__new" ? (
            <Field label={t("people.newDepartment")} htmlFor="emp-new-dept">
              <Input id="emp-new-dept" value={newDept} onChange={(e) => setNewDept(e.target.value)} maxLength={60} />
            </Field>
          ) : (
            input("city", t("common.city"), { hint: t("common.optional") })
          )}
        </div>
        <fieldset className="grid grid-cols-1 gap-4 rounded-lg border border-line p-3 sm:grid-cols-2">
          <legend className="px-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("people.bankAndIds")}</legend>
          {input("bankAccountName", t("people.bankAccountName"), { hint: t("common.optional") })}
          {input("bankAccountNumber", t("people.bankAccountNumber"), { inputMode: "numeric", hint: employee?.bankAccountLast4 ? t("people.keepBlank", { last4: employee.bankAccountLast4 }) : t("people.encrypted") })}
          {input("bankIfsc", "IFSC", { hint: t("common.optional") })}
          {input("pan", "PAN", { hint: employee?.panMasked ? t("people.keepBlankMasked", { masked: employee.panMasked }) : t("people.encrypted") })}
          {input("aadhaar", t("people.aadhaar"), { inputMode: "numeric", hint: employee?.aadhaarLast4 ? t("people.keepBlank", { last4: employee.aadhaarLast4 }) : t("people.aadhaarHint") })}
          {input("email", t("common.email"), { type: "email", hint: t("common.optional") })}
        </fieldset>
        <fieldset className="grid grid-cols-1 gap-4 rounded-lg border border-line p-3 sm:grid-cols-2">
          <legend className="px-1 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("people.statutory")}</legend>
          {input("uan", t("people.uan"), { inputMode: "numeric", hint: t("people.uanHint") })}
          {input("esiNumber", t("people.esiNumber"), { inputMode: "numeric", hint: t("people.esiNumberHint") })}
          <Field label={t("people.gender")} htmlFor="emp-gender" hint={t("people.genderHint")} error={fieldError("gender")}>
            <Select id="emp-gender" value={form.gender} onChange={set("gender")}>
              <option value="">—</option>
              {(["male", "female", "other"] as const).map((g) => (
                <option key={g} value={g}>
                  {t(`people.genders.${g}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col justify-center gap-2">
            <Checkbox label={t("people.pfMember")} checked={form.pfMember} onChange={(v) => setForm((f) => ({ ...f, pfMember: v }))} />
            <Checkbox label={t("people.epsMember")} checked={form.pfMember && form.epsMember} disabled={!form.pfMember} onChange={(v) => setForm((f) => ({ ...f, epsMember: v }))} />
          </div>
        </fieldset>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {input("emergencyContactName", t("people.emergencyName"), { hint: t("common.optional") })}
          {input("emergencyContactPhone", t("people.emergencyPhone"), { inputMode: "tel", hint: t("common.optional") })}
        </div>
        {input("notes", t("common.notes"), { hint: t("common.optional") })}
      </div>
    </Dialog>
  );
}
