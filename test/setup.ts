import { beforeEach } from "vitest";
import { resetNetForTests } from "../src/lib/net.ts";

// Unit tests never touch the network. Live suites opt in through their own env flags.
const live = Object.keys(process.env).some((k) => /LIVE|PROBE/.test(k));
if (!live) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new TypeError(`network disabled in unit tests: ${new URL(url).host}`);
  }) as typeof fetch;
}

beforeEach(() => {
  resetNetForTests();
});
