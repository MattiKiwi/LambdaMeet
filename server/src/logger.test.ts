import { describe, expect, it } from "vitest";
import { actionStart, actionSuccess, withComponent } from "./logger.js";

describe("logger", () => {
  it("creates component logger and logs actions without throwing", () => {
    const log = withComponent("test");
    expect(log).toBeDefined();
    expect(() => actionStart("test", "sample", { foo: "bar" })).not.toThrow();
    expect(() => actionSuccess("test", "sample", { foo: "bar" })).not.toThrow();
  });
});
