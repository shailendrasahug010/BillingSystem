import { afterEach, describe, expect, it } from "vitest";
import { uuid } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid", () => {
  afterEach(() => {
    delete (crypto as { randomUUID?: unknown }).randomUUID;
  });

  it("uses the browser's own on a secure page", () => {
    expect(uuid()).toMatch(V4);
  });

  it("makes one from random bytes where the page is not secure (a phone on http://192.168.x.x)", () => {
    // Plain HTTP at a network address: crypto.randomUUID is not there.
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    expect(typeof crypto.randomUUID).toBe("undefined");
    const ids = Array.from({ length: 500 }, uuid);
    for (const id of ids) expect(id).toMatch(V4);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
