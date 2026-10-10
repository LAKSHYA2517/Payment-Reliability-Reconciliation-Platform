import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("applies defaults and coerces PORT to a number", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/db", PORT: "4000" });
    expect(config).toEqual({
      NODE_ENV: "development",
      PORT: 4000,
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
    });
  });

  it("fails fast when DATABASE_URL is missing or not a postgres URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });
});
