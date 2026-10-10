import { describe, expect, it } from "vitest";
import { describeDevice } from "./device";

describe("describeDevice", () => {
  it("names the browser and the system", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")).toEqual({ app: false, browser: "Chrome", os: "Windows", phone: false });
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0")).toMatchObject({ browser: "Edge", os: "Windows" });
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15")).toMatchObject({ browser: "Safari", os: "Mac" });
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1")).toEqual({ app: false, browser: "Chrome", os: "iPhone", phone: true });
    expect(describeDevice("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toMatchObject({ browser: "Firefox", os: "Linux" });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36")).toMatchObject({ app: false, browser: "Samsung Internet", os: "Android", phone: true });
  });

  it("knows the Android app by its web view", () => {
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-A146B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36")).toMatchObject({ app: true, os: "Android" });
  });

  it("says nothing it cannot tell", () => {
    expect(describeDevice(null)).toEqual({ app: false, browser: null, os: null, phone: false });
    expect(describeDevice("curl/8.5.0")).toEqual({ app: false, browser: null, os: null, phone: false });
  });
});
