import { describe, expect, it } from "vitest";
import { renderAreaCanvas, renderBrainCanvas, validateGeneratedCanvas } from "../src/foundation/canvas.js";
import { BRAIN_FOUNDATION_POLICY } from "../src/foundation/policy.js";

describe("generated Brain Canvas", () => {
  it("contains file nodes for Home and all area MOCs", () => {
    const first = renderBrainCanvas(BRAIN_FOUNDATION_POLICY);
    const second = renderBrainCanvas(BRAIN_FOUNDATION_POLICY);
    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(validateGeneratedCanvas(parsed)).toBe(true);
    expect(parsed.nodes.filter((node: { type: string }) => node.type === "file")).toHaveLength(11);
    expect(parsed.nodes.map((node: { file: string }) => node.file)).toContain("000_Home_MOC.md");
    expect(parsed.edges).toHaveLength(10);
  });

  it("renders a standalone area canvas with one file node", () => {
    const area = BRAIN_FOUNDATION_POLICY.areas[3];
    const parsed = JSON.parse(renderAreaCanvas(area));

    expect(validateGeneratedCanvas(parsed)).toBe(true);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].file).toBe("20_Study/000_Study_MOC.md");
    expect(parsed.edges).toEqual([]);
  });

  it("rejects malformed generated Canvas values", () => {
    expect(validateGeneratedCanvas({ nodes: [], edges: [{ id: "edge" }] })).toBe(false);
  });
});
