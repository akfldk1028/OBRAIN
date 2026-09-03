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

  it.each([
    "D:\\obsidian\\Brain",
    "D:/obsidian/Brain",
    "\\\\server\\share\\Brain",
    "//server/share/Brain",
  ])("accepts fully qualified Windows vault path %j", (vaultRoot) => {
    expect(parseFoundationArgs(["--vault", vaultRoot], "win32")).toEqual({ vaultRoot, apply: false });
  });

  it.each([
    "/srv/obsidian/Brain",
    "\\srv\\obsidian\\Brain",
    "D:obsidian\\Brain",
    "relative",
  ])("rejects ambiguous Windows vault path %j", (vaultRoot) => {
    expect(() => parseFoundationArgs(["--vault", vaultRoot], "win32")).toThrow("absolute");
  });

  it("requires slash-rooted paths under POSIX semantics", () => {
    const vaultRoot = "/srv/obsidian/Brain";
    expect(parseFoundationArgs(["--vault", vaultRoot], "linux")).toEqual({ vaultRoot, apply: false });
    expect(() => parseFoundationArgs(["--vault", "srv/obsidian/Brain"], "linux")).toThrow("absolute");
    expect(() => parseFoundationArgs(["--vault", "D:\\obsidian\\Brain"], "linux")).toThrow("absolute");
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
