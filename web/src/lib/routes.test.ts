import { describe, expect, it } from "vitest";
import { isRoute, routes } from "./routes";

describe("routes", () => {
  it("matches route pathnames", () => {
    expect(isRoute("/", "user")).toBe(true);
    expect(isRoute("/login", "login")).toBe(true);
    expect(isRoute("/admin", "admin")).toBe(true);
    expect(isRoute("/call", "call")).toBe(true);
    expect(isRoute("/call", "admin")).toBe(false);
    expect(routes.call).toBe("/call");
  });
});
