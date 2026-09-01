import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs on Node", () => {
    expect(process.versions.node).toMatch(/^\d+\./);
  });
});
