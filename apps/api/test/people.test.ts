import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

describe.skipIf(!hasDatabase)("employees, attendance, leave and payroll", () => {
  let t: TestApp;
  let owner: Session;
  let salesToken: string;
  let hrToken: string;
  const ids: Record<string, string> = {};
  const comp: Record<string, string> = {};
  const leaveType: Record<string, string> = {};
  const post = (url: string, body: unknown, token = owner.token) => call(t.app, "POST", url, { token, body });
  const put = (url: string, body: unknown, token = owner.token) => call(t.app, "PUT", url, { token, body });
  const patch = (url: string, body: unknown, token = owner.token) => call(t.app, "PATCH", url, { token, body });
  const get = (url: string, token = owner.token) => call(t.app, "GET", url, { token });

  const login = async (roleId: string, name: string) => {
    const mobile = nextMobile();
    await post("/members", { name, mobile, roleId });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    return (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken as string;
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "People Traders", stateCode: "23" });
    const roles = Object.fromEntries((await get("/roles")).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    salesToken = await login(roles.sales, "Sales Sam");
    hrToken = await login(roles.hr, "Hema HR");
    for (const c of (await get("/salary-components")).body.data) comp[c.code] = c.id;
    for (const l of (await get("/leave-types")).body.data) leaveType[l.code] = l.id;
  });
  afterAll(async () => {
    await t?.close();
  });

  describe("employees", () => {
    it("adds employees with codes, keeps bank / PAN / Aadhaar encrypted and shows only masked copies", async () => {
      ids.dept = (await post("/departments", { name: "Warehouse" })).body.id;
      const res = await post("/employees", {
        name: "Ramesh Yadav",
        mobile: "9876500001",
        joiningDate: "2025-04-01",
        departmentId: ids.dept,
        designation: "Packer",
        bankAccountName: "Ramesh Yadav",
        bankAccountNumber: "123456789012",
        bankIfsc: "SBIN0001234",
        pan: "ABCPY1234K",
        aadhaar: "123412341234",
      });
      expect(res.status).toBe(201);
      ids.ramesh = res.body.id;
      expect(res.body).toMatchObject({ employeeCode: "E001", departmentName: "Warehouse", bankAccountLast4: "9012", panMasked: "ABXXXXX34K", aadhaarLast4: "1234", status: "active" });
      expect(JSON.stringify(res.body)).not.toContain("123456789012");
      const row = (await t.owner.query(`select bank_account_number_enc, pan_enc from employees where id = $1`, [ids.ramesh])).rows[0];
      expect(row.bank_account_number_enc).toMatch(/^v1\./);
      expect(row.pan_enc).not.toContain("ABCPY1234K");

      const sensitive = await get(`/employees/${ids.ramesh}/sensitive`);
      expect(sensitive.body).toMatchObject({ bankAccountNumber: "123456789012", pan: "ABCPY1234K", aadhaar: "123412341234" });
      expect((await get(`/employees/${ids.ramesh}/sensitive`, hrToken)).status).toBe(200);
      expect((await get("/employees", salesToken)).status).toBe(403);

      ids.sita = (await post("/employees", { name: "Sita Verma", mobile: "9876500002", joiningDate: "2026-09-16", designation: "Billing" }, hrToken)).body.id;
      const list = (await get("/employees")).body.data;
      expect(list.map((e: { employeeCode: string; name: string }) => `${e.employeeCode} ${e.name}`)).toEqual(["E001 Ramesh Yadav", "E002 Sita Verma"]);
      expect((await get("/employees?q=pack")).body.data).toHaveLength(1);
    });

    it("saves a salary structure from a date and shows the monthly gross", async () => {
      const res = await put(`/employees/${ids.ramesh}/salary`, {
        effectiveFrom: "2026-04-01",
        basic: "12000",
        overtimeRatePerHour: "60",
        components: [
          { componentId: comp.HRA, percent: "40" },
          { componentId: comp.CONV, amount: "1500" },
          { componentId: comp.PF, percent: "12" },
          { componentId: comp.PT, amount: "200" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ basic: "12000.00", monthlyGross: "18300.00", lines: expect.arrayContaining([expect.objectContaining({ componentId: comp.HRA, percent: "40.000" })]) });
      expect((await get(`/employees/${ids.ramesh}`)).body.monthlySalary).toBe("18300.00");
      expect((await get(`/employees/${ids.ramesh}/salary`)).body.history).toHaveLength(1);
    });
  });

  describe("attendance and leave", () => {
    it("marks a day for everyone and builds the month register", async () => {
      const day = await get("/attendance?date=2026-09-03");
      expect(day.body.data.map((x: { name: string }) => x.name)).toEqual(["Ramesh Yadav"]); // Sita joins on the 16th
      expect((await put("/attendance", { date: "2026-09-03", entries: [{ employeeId: ids.ramesh, status: "absent", note: "Village" }] })).body.saved).toBe(1);
      await put("/attendance", { date: "2026-09-12", entries: [{ employeeId: ids.ramesh, status: "present", checkIn: "09:00", checkOut: "21:00", overtimeHours: "2" }] });
      expect((await put("/attendance", { date: "2026-09-25", entries: [{ employeeId: ids.ramesh, status: "present" }] })).body.error.code).toBe("FUTURE_DATE_NOT_ALLOWED");
      const month = (await get("/attendance/month?month=2026-09")).body;
      const ramesh = month.data.find((x: { id: string }) => x.id === ids.ramesh);
      expect(ramesh.days).toEqual({ "2026-09-03": "absent", "2026-09-12": "present" });
      expect(ramesh.counts).toMatchObject({ absent: 1, present: 1 });
      expect(ramesh.overtimeHours).toBe("2.000");
    });

    it("applies, checks balance and overlap, approves (days marked as leave) and cancels", async () => {
      const cl = await post("/leave/requests", { employeeId: ids.ramesh, leaveTypeId: leaveType.CL, fromDate: "2026-09-07", toDate: "2026-09-08", reason: "Wedding" }, hrToken);
      expect(cl.status).toBe(201);
      expect(cl.body).toMatchObject({ days: "2.000", status: "pending", leaveTypeCode: "CL" });
      expect((await post("/leave/requests", { employeeId: ids.ramesh, leaveTypeId: leaveType.SL, fromDate: "2026-09-08", toDate: "2026-09-09" })).body.error.code).toBe("LEAVE_OVERLAP");
      expect((await post("/leave/requests", { employeeId: ids.ramesh, leaveTypeId: leaveType.CL, fromDate: "2026-10-01", toDate: "2026-10-11" })).body.error).toMatchObject({ code: "LEAVE_BALANCE_INSUFFICIENT", params: { available: "10.0", requested: "11.0" } });

      const approved = await post(`/leave/requests/${cl.body.id}/decide`, { decision: "approve" }, hrToken);
      expect(approved.body.status).toBe("approved");
      expect((await get("/attendance?date=2026-09-07")).body.data[0]).toMatchObject({ status: "leave", note: "CL", leave: { type: "CL" } });
      const balances = (await get(`/leave/balances?employeeId=${ids.ramesh}&year=2026`)).body.data;
      expect(balances.find((b: { code: string }) => b.code === "CL")).toMatchObject({ entitled: "12.000", used: "2.000", available: "10.000" });

      const ul = await post("/leave/requests", { employeeId: ids.ramesh, leaveTypeId: leaveType.UL, fromDate: "2026-09-21", toDate: "2026-09-21" });
      await post(`/leave/requests/${ul.body.id}/decide`, { decision: "approve" });
      const sl = await post("/leave/requests", { employeeId: ids.ramesh, leaveTypeId: leaveType.SL, fromDate: "2026-09-15", toDate: "2026-09-15", halfDay: true });
      expect(sl.body.days).toBe("0.500");
      await post(`/leave/requests/${sl.body.id}/decide`, { decision: "approve" });
      expect((await post(`/leave/requests/${sl.body.id}/cancel`, {}, salesToken)).status).toBe(403);
      expect((await post(`/leave/requests/${sl.body.id}/cancel`, {})).body.status).toBe("cancelled");
      expect((await get("/attendance?date=2026-09-15")).body.data[0].status).toBeNull();
      expect((await get("/leave/requests?status=approved")).body.data).toHaveLength(2);
    });
  });

  describe("payroll", () => {
    it("pays an advance now and recovers it through payroll", async () => {
      const res = await post(`/employees/${ids.ramesh}/advances`, { type: "advance", amount: "3000", installmentAmount: "1000", method: "cash", notes: "Festival" });
      expect(res.status).toBe(201);
      expect(res.body.paymentNumber).toBe("PAY/26-27/00001");
      const payments = (await get("/payments?direction=out")).body.data;
      expect(payments[0]).toMatchObject({ partyName: "Ramesh Yadav", amount: "3000.00", partyType: "employee" });
      expect((await post(`/payments/${payments[0].id}/cancel`, { reason: "Test only" })).body.error.code).toBe("EMPLOYEE_PAYMENT_LOCKED");
    });

    it("runs the month from attendance, leave, structure and advances", async () => {
      const run = await post("/payroll/runs", { month: "2026-09" });
      expect(run.status).toBe(201);
      ids.run = run.body.id;
      expect(run.body).toMatchObject({ status: "draft", month: "2026-09" });
      expect(run.body.skipped).toEqual([expect.objectContaining({ name: "Sita Verma" })]); // no salary structure yet
      const [slip] = run.body.slips;
      ids.slip = slip.id;
      // 30 days; 1 absent + 1 unpaid leave (CL is paid) -> 28 paid.
      // Basic 11200, HRA 4480, conveyance 1400, overtime 2 h x 60 = 120 -> 17200.
      // PF 1344, PT 200, advance 1000 -> 2544. Net 14656.
      expect(slip).toMatchObject({ workingDays: "30.000", paidDays: "28.000", unpaidDays: "2.000", overtimeHours: "2.000", grossEarnings: "17200.00", totalDeductions: "2544.00", netPay: "14656.00" });
      expect(run.body).toMatchObject({ totalGross: "17200.00", totalNet: "14656.00" });
      expect((await post("/payroll/runs", { month: "2026-09" })).body.error.code).toBe("PAYROLL_RUN_EXISTS");
      expect((await post("/payroll/runs", { month: "2026-10" })).body.error.code).toBe("PAYROLL_MONTH_IN_FUTURE");
    });

    it("takes this month's incentive, recalculates after changes, then finalizes and pays", async () => {
      const adjusted = await patch(`/payroll/runs/${ids.run}/slips/${ids.slip}`, { manual: [{ componentId: comp.INCENT, amount: "500" }] });
      expect(adjusted.body.slips[0]).toMatchObject({ id: ids.slip, grossEarnings: "17700.00", netPay: "15156.00" });
      expect((await patch(`/payroll/runs/${ids.run}/slips/${adjusted.body.slips[0].id}`, { manual: [{ componentId: comp.BASIC, amount: "1" }] })).body.error.code).toBe("NOT_A_MANUAL_COMPONENT");

      // Sita gets a structure; a recalculation adds her (from her joining date) and keeps the incentive.
      await put(`/employees/${ids.sita}/salary`, { effectiveFrom: "2026-09-16", basic: "9000", components: [] });
      const recalculated = await post(`/payroll/runs/${ids.run}/recalculate`, {});
      expect(recalculated.body.skipped).toEqual([]);
      const byName = Object.fromEntries(recalculated.body.slips.map((s: { employeeName: string }) => [s.employeeName, s]));
      expect(byName["Ramesh Yadav"]).toMatchObject({ grossEarnings: "17700.00", netPay: "15156.00" });
      expect(byName["Sita Verma"]).toMatchObject({ paidDays: "15.000", grossEarnings: "4500.00", netPay: "4500.00" });

      expect((await post(`/payroll/runs/${ids.run}/pay`, { method: "bank_transfer" })).body.error.code).toBe("PAYROLL_NOT_FINALIZED");
      const finalized = await post(`/payroll/runs/${ids.run}/finalize`, {});
      expect(finalized.body.status).toBe("finalized");
      const advances = (await get(`/employees/${ids.ramesh}/advances`)).body.data;
      expect(advances[0]).toMatchObject({ amount: "3000.00", recoveredAmount: "1000.00", isClosed: false });
      expect((await patch(`/payroll/runs/${ids.run}/slips/${byName["Ramesh Yadav"].id}`, { manual: [] })).body.error.code).toBe("PAYROLL_NOT_DRAFT");

      const paid = await post(`/payroll/runs/${ids.run}/pay`, { method: "bank_transfer", referenceNumber: "NEFT-SEP" });
      expect(paid.body.status).toBe("paid");
      expect(paid.body.slips.map((s: { paymentNumber: string }) => s.paymentNumber).sort()).toEqual(["PAY/26-27/00002", "PAY/26-27/00003"]);
      expect((await post(`/payroll/runs/${ids.run}/pay`, { method: "cash" })).body.error.code).toBe("PAYROLL_ALREADY_PAID");

      const slip = (await get(`/payroll/slips/${byName["Ramesh Yadav"].id}`)).body;
      expect(slip).toMatchObject({ month: "2026-09", netPay: "15156.00", employee: { employeeCode: "E001", bankAccountLast4: "9012", department: "Warehouse" }, payment: { number: expect.stringMatching(/^PAY\//), method: "bank_transfer" } });
      expect(slip.lines.map((l: { label: string; amount: string }) => `${l.label} ${l.amount}`)).toEqual([
        "Basic 11200.00",
        "House Rent Allowance 4480.00",
        "Conveyance 1400.00",
        "Incentive 500.00",
        "Overtime 120.00",
        "Provident Fund 1344.00",
        "Professional Tax 200.00",
        "Advance recovery 1000.00",
      ]);
      const runs = (await get("/payroll/runs")).body.data;
      expect(runs[0]).toMatchObject({ month: "2026-09", status: "paid", employees: 2, paid: 2, totalNet: "19656.00" });
      const actions = (await get("/audit-logs?entityType=payroll_run")).body.data.map((a: { action: string }) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["payroll.run_created", "payroll.slip_adjusted", "payroll.recalculated", "payroll.finalized", "payroll.paid"]));
    });

    it("records an exit and keeps payroll out of other roles", async () => {
      const exit = await post(`/employees/${ids.sita}/exit`, { exitDate: "2026-09-30", status: "resigned", reason: "Moving city" });
      expect(exit.body).toMatchObject({ status: "resigned", exitDate: "2026-09-30" });
      expect((await get("/employees")).body.data.map((e: { name: string }) => e.name)).toEqual(["Ramesh Yadav"]);
      expect((await get("/employees?status=all")).body.data).toHaveLength(2);
      expect((await get("/payroll/runs", salesToken)).status).toBe(403);
      expect((await get("/payroll/runs", hrToken)).status).toBe(200);
    });
  });
});
