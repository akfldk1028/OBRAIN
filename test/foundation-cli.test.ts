import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFoundationArgs } from "../src/foundation-cli.js";

describe("foundation CLI", () => {
  it("requires a native absolute vault and defaults to preview", () => {
    const vaultRoot = path.resolve("test-vault");

    expect(parseFoundationArgs(["--vault", vaultRoot])).toEqual({
      vaultRoot, apply: false,
    });
    expect(() => parseFoundationArgs(["--apply"])).toThrow("--vault is required");
    expect(() => parseFoundationArgs(["--vault", "relative"])).toThrow("absolute");
  });

  it("handles Windows and POSIX paths using the current host path rules", () => {
    const windowsPath = "D:\\obsidian\\Brain";
    const posixPath = "/srv/obsidian/Brain";

    if (process.platform === "win32") {
      expect(parseFoundationArgs(["--vault", windowsPath])).toEqual({ vaultRoot: windowsPath, apply: false });
      expect(parseFoundationArgs(["--vault", posixPath])).toEqual({ vaultRoot: posixPath, apply: false });
      return;
    }

    expect(parseFoundationArgs(["--vault", posixPath])).toEqual({ vaultRoot: posixPath, apply: false });
    expect(() => parseFoundationArgs(["--vault", windowsPath])).toThrow("absolute");
  });

  it("allows explicit apply", () => {
    expect(parseFoundationArgs(["--vault", path.resolve("test-vault"), "--apply"])).toEqual({
      vaultRoot: path.resolve("test-vault"), apply: true,
    });
  });

  it.each([
    [["--vault", path.resolve("test-vault"), "--unknown"], "unknown argument"],
    [["unexpected", "--vault", path.resolve("test-vault")], "unknown argument"],
    [["--vault", path.resolve("one"), "--vault", path.resolve("two")], "--vault may only be provided once"],
    [["--vault", path.resolve("test-vault"), "--apply", "--apply"], "--apply may only be provided once"],
    [["--vault"], "--vault requires a value"],
    [["--vault", "--apply"], "--vault requires a value"],
  ])("rejects malformed arguments %j", (args, message) => {
    expect(() => parseFoundationArgs(args)).toThrow(message);
  });
});
