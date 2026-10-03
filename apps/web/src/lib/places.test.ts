import { describe, expect, it } from "vitest";
import { byCity, byPinThenName, cityKey } from "./places";

describe("places", () => {
  it("takes spellings of one place as one", () => {
    expect(cityKey(" Dewas ")).toBe("dewas");
    expect(cityKey("DEWAS")).toBe("dewas");
    expect(cityKey(null)).toBe("");
    expect(cityKey(undefined)).toBe("");
  });

  it("groups rows by place, in the order the places first come up", () => {
    const shops = [
      { name: "Anand", city: "Indore" },
      { name: "Malwa", city: "DEWAS" },
      { name: "Ganesh", city: " dewas" },
      { name: "Bansal", city: null },
      { name: "Dewas Traders", city: "Dewas" },
      { name: "Chouhan", city: "indore" },
      { name: "Sonkatch Agencies", city: "Sonkatch" },
      { name: "Gupta", city: "  " },
    ];
    const groups = byCity(shops, (s) => s.city);
    expect(groups.map((g) => [g.key, g.label, g.rows.map((s) => s.name)])).toEqual([
      ["indore", "Indore", ["Anand", "Chouhan"]],
      ["dewas", "Dewas", ["Malwa", "Ganesh", "Dewas Traders"]],
      ["", null, ["Bansal", "Gupta"]],
      ["sonkatch", "Sonkatch", ["Sonkatch Agencies"]],
    ]);
  });

  it("puts neighbours together: by PIN code, those without one last, then by name", () => {
    const shops = [
      { name: "Gupta", pincode: "" },
      { name: "Shree Ganesh", pincode: "455111" },
      { name: "Malwa", pincode: "455001" },
      { name: "Anand", pincode: "" },
      { name: "Dewas Traders", pincode: "455001" },
    ];
    expect([...shops].sort(byPinThenName).map((s) => s.name)).toEqual(["Dewas Traders", "Malwa", "Shree Ganesh", "Anand", "Gupta"]);
  });

  it("shows a place as most of its rows write it, and with a capital on a tie", () => {
    expect(byCity(["DEWAS", "DEWAS", "Dewas"], (c) => c)[0]?.label).toBe("DEWAS");
    expect(byCity(["DEWAS", "Dewas"], (c) => c)[0]?.label).toBe("Dewas");
    expect(byCity(["dewas", "Dewas"], (c) => c)[0]?.label).toBe("Dewas");
    expect(byCity(["DEWAS", "dewas"], (c) => c)[0]?.label).toBe("dewas");
    expect(byCity(["देवास", "देवास "], (c) => c)[0]?.label).toBe("देवास");
  });
});
