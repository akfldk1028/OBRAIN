import { describe, expect, it } from "vitest";
import { parseFoundationArgs } from "../src/foundation-cli.js";

describe("foundation CLI", () => {
  it("requires an absolute vault and defaults to preview", () => {
    expect(parseFoundationArgs(["--vault", "D:\\obsidian\\Brain"])).toEqual({
      vaultRoot: "D:\\obsidian\\Brain", apply: false,
    });
    expect(() => parseFoundationArgs(["--apply"])).toThrow("--vault is required");
    expect(() => parseFoundationArgs(["--vault", "relative"])).toThrow("absolute");
  });
});
