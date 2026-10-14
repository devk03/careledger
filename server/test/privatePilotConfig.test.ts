import { describe, expect, it } from "vitest";
import { privatePilotConfig } from "../src/privatePilotConfig.js";

const valid = { ADENO_EDITION: "trusted-private", ADENO_PRIVATE_ORIGIN: "https://adeno.example.invalid",
  ADENO_PRIVATE_DB_PATH: "/data/case.sqlite", ADENO_PRIVATE_SECRETS_DIR: "/data/secrets",
  ADENO_PRIVATE_WEB_ROOT: "/app/web", PORT: "8080" };

describe("trusted private runtime configuration", () => {
  it("requires an explicit server-readable edition and exact HTTPS origin", () => {
    expect(privatePilotConfig(valid)).toMatchObject({ port: 8080,
      origin: "https://adeno.example.invalid", databasePath: "/data/case.sqlite" });
    for (const edition of [undefined, "managed", "community"]) {
      expect(() => privatePilotConfig({ ...valid, ADENO_EDITION: edition })).toThrow();
    }
  });
  it.each(["http://adeno.example.invalid", "https://adeno.example.invalid/",
    "https://adeno.example.invalid/path", "https://adeno.example.invalid?token=secret",
    "https://user:password@adeno.example.invalid", "https://localhost", "invalid"])(
    "rejects unsafe or ambiguous origin %s", origin => {
      expect(() => privatePilotConfig({ ...valid, ADENO_PRIVATE_ORIGIN: origin })).toThrow();
    });
  it("rejects relative storage paths and invalid ports without exposing their values", () => {
    for (const key of ["ADENO_PRIVATE_DB_PATH", "ADENO_PRIVATE_SECRETS_DIR", "ADENO_PRIVATE_WEB_ROOT"]) {
      expect(() => privatePilotConfig({ ...valid, [key]: "relative-secret-path" })).toThrow();
    }
    for (const port of ["80", "65536", "8080junk", "8e3", ""]) {
      expect(() => privatePilotConfig({ ...valid, PORT: port })).toThrow();
    }
  });
});
