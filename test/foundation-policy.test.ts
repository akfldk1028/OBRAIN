import { describe, expect, it } from "vitest";
import {
  BRAIN_FOUNDATION_POLICY,
  areaCanvasPath,
  areaGuidePath,
  areaMocPath,
} from "../src/foundation/policy.js";

describe("Brain foundation policy", () => {
  it("uses the ten approved top-level areas in order", () => {
    expect(BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory)).toEqual([
      "00_Prompt", "01_Development", "10_Agent", "20_Study", "30_Business",
      "40_Research", "50_Project", "60_Tools", "98_DK", "99_Archive",
    ]);
    expect(BRAIN_FOUNDATION_POLICY.maxDepth).toBe(5);
    expect(BRAIN_FOUNDATION_POLICY.inbox).toBe("Agent-Inbox");
  });

  it("derives stable required file paths", () => {
    const study = BRAIN_FOUNDATION_POLICY.areas[3];
    expect(areaMocPath(study)).toBe("20_Study/000_Study_MOC.md");
    expect(areaCanvasPath(study)).toBe("20_Study/000_Study_Map.canvas");
    expect(areaGuidePath(study)).toBe("20_Study/99_작업가이드_다음AI용.md");
  });
});
