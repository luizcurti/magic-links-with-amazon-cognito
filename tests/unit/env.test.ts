import { afterEach, describe, expect, it } from "vitest";
import { numberEnv, requireEnv } from "../../apps/api/src/lib/env.js";

describe("environment configuration", () => {
  afterEach(() => {
    delete process.env.TEST_VALUE;
  });

  it("returns a required variable when it is set", () => {
    process.env.TEST_VALUE = "table";
    expect(requireEnv("TEST_VALUE")).toBe("table");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("fails fast when a required variable is %s", (_label, value) => {
    if (value !== undefined) process.env.TEST_VALUE = value;
    expect(() => requireEnv("TEST_VALUE")).toThrow("Missing required environment variable: TEST_VALUE");
  });

  it("falls back to the default for an unset number", () => {
    expect(numberEnv("TEST_VALUE", 600)).toBe(600);
  });

  it("parses a positive number", () => {
    process.env.TEST_VALUE = "900";
    expect(numberEnv("TEST_VALUE", 600)).toBe(900);
  });

  it.each(["abc", "0", "-60"])("rejects %j instead of silently using it", (value) => {
    process.env.TEST_VALUE = value;
    expect(() => numberEnv("TEST_VALUE", 600)).toThrow("must be a positive number");
  });
});
