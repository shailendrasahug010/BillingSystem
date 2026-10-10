/**
 * A signed-in device in words, from how its browser or app describes itself
 * (its User-Agent): "Chrome on Windows", or the Android app. Names of
 * products are not translated.
 */
export interface DeviceName {
  /** The Digital Bahi app on an Android phone (its web view says "wv"). */
  app: boolean;
  browser: string | null;
  os: string | null;
  phone: boolean;
}

const OSES: Array<[RegExp, string]> = [
  [/Android/, "Android"],
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux/, "Linux"],
];

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg(A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function describeDevice(userAgent: string | null): DeviceName {
  const ua = userAgent ?? "";
  const os = OSES.find(([re]) => re.test(ua))?.[1] ?? null;
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  return {
    app: os === "Android" && /; wv\)/.test(ua),
    browser,
    os,
    phone: /Mobile|Android|iPhone|iPod/.test(ua),
  };
}
