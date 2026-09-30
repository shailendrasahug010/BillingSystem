import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

/**
 * PF, ESI and professional tax worked out on the slips of a Maharashtra
 * business for September 2026, checked against figures worked out by hand:
 *   Asha (woman): basic 12,000 + HRA 40% + conveyance 1,600 = 18,400.
 *     PF 12% of 12,000 = 1,440; employer EPS 1,000, EPF 440. ESI 138 / 598. PT nil (women up to 25,000).
 *   Bharat: basic 25,000 + HRA 40%, absent one day: 33,833.34. PF on the ₹15,000 ceiling = 1,800,
 *     outside the pension scheme so the employer's 1,800 all goes to EPF; NCP 1 day. Earns above
 *     21,000: no ESI. PT 200.
 *   Chetan: not in PF; raised in September to 23,000 but covered by ESI for the April–September
 *     period (10,000 at its start): ESI 173 / 748. PT 200.
 */
describe.skipIf(!hasDatabase)("PF, ESI and professional tax on salary slips", () => {
  let t: TestApp;
  let owner: Session;
  const ids: Record<string, string> = {};
  const comp: Record<string, string> = {};
  const post = (url: string, body: unknown) => call(t.app, "POST", url, { token: owner.token, body });
  const put = (url: string, body: unknown) => call(t.app, "PUT", url, { token: owner.token, body });
  const get = (url: string) => call(t.app, "GET", url, { token: owner.token });
  const STATUTORY = {
    pf: { enabled: true, establishmentCode: "mhban0012345000", restrictToCeiling: true, wagesRule: "codes" },
    esi: { enabled: true, employerCode: "31000123450000999" },
    pt: { enabled: true, stateCode: null, rule: null },
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Pune Distributors", stateCode: "27" });
    for (const c of (await get("/salary-components")).body.data) comp[c.code] = c.id;
    const employee = async (name: string, extra: object) =>
      (await post("/employees", { name, mobile: nextMobile(), joiningDate: "2025-06-01", ...extra })).body.id as string;
    ids.asha = await employee("Asha Patil", { gender: "female", uan: "100200300400", esiNumber: "3100123456" });
    ids.bharat = await employee("Bharat Joshi", { gender: "male", uan: "100200300401", epsMember: false });
    ids.chetan = await employee("Chetan More", { gender: "male", pfMember: false });
    // As set up by hand before: 10% PF and a fixed ESI on the structure; the law replaces them.
    const hraConv = (conv: string) => [
      { componentId: comp.HRA, percent: "40" },
      { componentId: comp.CONV, amount: conv },
      { componentId: comp.PF, percent: "10" },
    ];
    await put(`/employees/${ids.asha}/salary`, { effectiveFrom: "2025-06-01", basic: "12000", components: hraConv("1600") });
    await put(`/employees/${ids.bharat}/salary`, { effectiveFrom: "2025-06-01", basic: "25000", components: [{ componentId: comp.HRA, percent: "40" }] });
    await put(`/employees/${ids.chetan}/salary`, { effectiveFrom: "2025-06-01", basic: "9000", components: [{ componentId: comp.CONV, amount: "1000" }] });
    await put(`/employees/${ids.chetan}/salary`, { effectiveFrom: "2026-09-01", basic: "22000", components: [{ componentId: comp.CONV, amount: "1000" }] });
    await put("/attendance", { date: "2026-09-10", entries: [{ employeeId: ids.bharat, status: "absent" }] });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("keeps PF, ESI and PT off until the business turns them on, and checks the settings", async () => {
    expect((await get("/settings")).body["payroll.statutory"]).toMatchObject({ pf: { enabled: false, restrictToCeiling: true, wagesRule: "codes" }, pt: { enabled: false, stateCode: null, rule: null } });
    expect((await put("/settings/payroll.statutory", { value: { ...STATUTORY, pf: { ...STATUTORY.pf, establishmentCode: "MH BAN 1" } } })).status).toBe(400);
    expect((await put("/settings/payroll.statutory", { value: STATUTORY })).body.value.pf.establishmentCode).toBe("MHBAN0012345000");
    expect((await get(`/employees/${ids.bharat}`)).body).toMatchObject({ uan: "100200300401", pfMember: true, epsMember: false, gender: "male" });
    expect((await call(t.app, "PATCH", `/employees/${ids.bharat}`, { token: owner.token, body: { uan: "12345" } })).status).toBe(400);
  });

  it("works PF, ESI and PT out on each slip in place of the components set up by hand", async () => {
    const run = await post("/payroll/runs", { month: "2026-09" });
    expect(run.status).toBe(201);
    ids.run = run.body.id;
    const byName = Object.fromEntries(run.body.slips.map((s: { employeeName: string }) => [s.employeeName, s]));
    expect(byName["Asha Patil"]).toMatchObject({ grossEarnings: "18400.00", totalDeductions: "1578.00", netPay: "16822.00" });
    expect(byName["Bharat Joshi"]).toMatchObject({ grossEarnings: "33833.34", totalDeductions: "2000.00", netPay: "31833.34" });
    expect(byName["Chetan More"]).toMatchObject({ grossEarnings: "23000.00", totalDeductions: "373.00", netPay: "22627.00" });
    const asha = (await get(`/payroll/slips/${byName["Asha Patil"].id}`)).body;
    expect(asha.lines.filter((l: { type: string }) => l.type === "deduction").map((l: { code: string; amount: string }) => [l.code, l.amount])).toEqual([
      ["PF", "1440.00"],
      ["ESI", "138.00"],
    ]);
    expect(asha.statutory).toEqual({
      pf: { wages: "12000", epfWages: "12000", epsWages: "12000", edliWages: "12000", employee: "1440", employerEps: "1000", employerEpf: "440" },
      esi: { wages: "18400.00", employee: "138", employer: "598" },
      pt: { amount: "0", stateCode: "27" },
    });
    expect(asha.employee).toMatchObject({ uan: "100200300400", esiNumber: "3100123456" });
  });

  it("sums the month for the challans and lists what the filings still need", async () => {
    const s = (await get(`/payroll/runs/${ids.run}/statutory`)).body;
    expect(s.settings).toMatchObject({ pf: { enabled: true, establishmentCode: "MHBAN0012345000" }, pt: { stateCode: "27", hasSlabs: true } });
    expect(s.pf.members.map((m: { name: string; ncpDays: string; employerEps: string }) => [m.name, m.ncpDays, m.employerEps])).toEqual([
      ["Asha Patil", "0", "1000"],
      ["Bharat Joshi", "1", "0"],
    ]);
    // Account 1: 3,240 + 2,240; 2: admin 0.5% of 27,000 is 135, so the ₹500 minimum; 10: 1,000; 21: EDLI 135.
    expect(s.pf.totals).toMatchObject({ employee: "3240", employerEpf: "2240", employerEps: "1000", epfWages: "27000", ac1: "5480", ac2: "500", ac10: "1000", ac21: "135", ac22: "0", total: "7115" });
    expect(s.esi.members.map((m: { name: string; employee: string; employer: string }) => [m.name, m.employee, m.employer])).toEqual([
      ["Asha Patil", "138", "598"],
      ["Chetan More", "173", "748"],
    ]);
    expect(s.esi.totals).toMatchObject({ employee: "311", employer: "1346", total: "1657" });
    expect(s.pt).toMatchObject({ stateCode: "27", total: "400" });
    expect(s.missing).toEqual([{ employeeId: ids.chetan, name: "Chetan More", what: "esiNumber" }]);
  });

  it("downloads the PF ECR, the ESI sheet and the professional tax list", async () => {
    const ecr = await t.app.inject({ method: "GET", url: `/api/v1/payroll/runs/${ids.run}/statutory/ecr`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(ecr.headers["content-disposition"]).toContain("ECR_092026.txt");
    expect(ecr.body.split("\n")).toEqual([
      "100200300400#~#ASHA PATIL#~#18400#~#12000#~#12000#~#12000#~#1440#~#1000#~#440#~#0#~#0",
      "100200300401#~#BHARAT JOSHI#~#33833#~#15000#~#0#~#15000#~#1800#~#0#~#1800#~#1#~#0",
    ]);
    const esi = await t.app.inject({ method: "GET", url: `/api/v1/payroll/runs/${ids.run}/statutory/esi`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(esi.body.split("\r\n").slice(1, 3)).toEqual(["3100123456,Asha Patil,30,18400,,", ",Chetan More,30,23000,,"]);
    const pt = await t.app.inject({ method: "GET", url: `/api/v1/payroll/runs/${ids.run}/statutory/pt`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(pt.headers["content-disposition"]).toContain("PT_27_092026.csv");
    expect(pt.body).toContain("Chetan More,23000.00,200");
    const log = (await get("/audit-logs?entityType=payroll_run")).body.data.map((e: { action: string }) => e.action);
    expect(log).toContain("payroll.statutory_downloaded");
  });

  it("uses the business's own professional tax slabs when it sets them, on recalculation", async () => {
    const rule = { basis: "monthly", slabs: [{ above: 0, amount: 100 }] };
    expect((await put("/settings/payroll.statutory", { value: { ...STATUTORY, pt: { enabled: true, stateCode: "27", rule } } })).status).toBe(200);
    await post(`/payroll/runs/${ids.run}/recalculate`, {});
    expect((await get(`/payroll/runs/${ids.run}/statutory`)).body.pt.total).toBe("300");
  });
});
