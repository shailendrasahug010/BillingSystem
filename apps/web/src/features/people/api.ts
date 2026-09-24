import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../app/i18n";
import { allowed } from "../../data/db";
import { api } from "../../lib/api";

export type EmployeeStatus = "active" | "on_notice" | "resigned" | "terminated";

export interface EmployeeRow {
  id: string;
  employeeCode: string;
  name: string;
  mobile: string;
  designation: string | null;
  departmentId: string | null;
  departmentName: string | null;
  joiningDate: string;
  exitDate: string | null;
  status: EmployeeStatus;
  monthlySalary: string | null;
}

export interface Employee extends EmployeeRow {
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  stateCode: string | null;
  pincode: string | null;
  bankAccountName: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  panMasked: string | null;
  aadhaarLast4: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
}

export interface SalaryComponent {
  id: string;
  code: string;
  name: string;
  nameHi: string | null;
  type: "earning" | "deduction";
  calcType: "fixed" | "percent_of_basic" | "per_day" | "per_hour" | "manual";
  defaultValue: string;
  defaultPercent: string;
  isProrated: boolean;
  sortOrder: number;
}

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  nameHi: string | null;
  isPaid: boolean;
  annualQuota: string;
  allowHalfDay: boolean;
  isActive: boolean;
}

export const STATUS_TONE: Record<EmployeeStatus, "good" | "warn" | "neutral" | "danger"> = { active: "good", on_notice: "warn", resigned: "neutral", terminated: "danger" };

export function useDepartments() {
  return useQuery({ queryKey: ["departments"], queryFn: () => api.get<{ data: Array<{ id: string; name: string }> }>("/departments").then((r) => r.data), staleTime: 60_000 });
}

export function useSalaryComponents() {
  return useQuery({
    queryKey: ["salary-components"],
    queryFn: () => api.get<{ data: SalaryComponent[] }>("/salary-components").then((r) => r.data),
    staleTime: 300_000,
    enabled: allowed("payroll.view"),
  });
}

export function useLeaveTypes() {
  return useQuery({ queryKey: ["leave-types"], queryFn: () => api.get<{ data: LeaveType[] }>("/leave-types").then((r) => r.data), staleTime: 60_000, enabled: allowed("leave.view") });
}

/** Current employees for pickers (first 200, by name). */
export function useEmployeeOptions() {
  return useQuery({
    queryKey: ["employees", "options"],
    queryFn: () => api.get<{ data: EmployeeRow[] }>("/employees", { limit: 200 }).then((r) => r.data),
    staleTime: 60_000,
    enabled: allowed("employee.view"),
  });
}

/** A master's name in the current language (salary components, leave types). */
export function useLocalName() {
  const { locale } = useI18n();
  return (x: { name: string; nameHi?: string | null }) => (locale === "hi" && x.nameHi) || x.name;
}
