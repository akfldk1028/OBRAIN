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
    const home = parsed.nodes.find((node: { file: string }) => node.file === "000_Home_MOC.md");
    expect(parsed.edges.every((edge: { label: string; toNode: string }) => (
      edge.label === "parent" && edge.toNode === home.id
    ))).toBe(true);
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

  it("rejects extra fields at the root, node, and edge levels", () => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    expect(validateGeneratedCanvas({ ...parsed, extra: true })).toBe(false);
    expect(validateGeneratedCanvas({ ...parsed, nodes: [{ ...parsed.nodes[0], extra: true }, ...parsed.nodes.slice(1)] })).toBe(false);
    expect(validateGeneratedCanvas({ ...parsed, edges: [{ ...parsed.edges[0], extra: true }, ...parsed.edges.slice(1)] })).toBe(false);
  });

  it("rejects unknown node shapes including text nodes", () => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    const textNode = { id: "0123456789abcdef", type: "text", text: "not a file", x: 0, y: 0, width: 100, height: 100 };
    expect(validateGeneratedCanvas({ ...parsed, nodes: [textNode] })).toBe(false);
  });

  it("requires every node and edge ID to be a lowercase 16-character hex prefix", () => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    for (const id of ["short", "0123456789ABCDEf", "0123456789abcdeg"]) {
      expect(validateGeneratedCanvas({ ...parsed, nodes: [{ ...parsed.nodes[0], id }] })).toBe(false);
      expect(validateGeneratedCanvas({ ...parsed, edges: [{ ...parsed.edges[0], id }] })).toBe(false);
    }
  });

  it("rejects duplicate IDs across nodes and edges", () => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    expect(validateGeneratedCanvas({ ...parsed, nodes: [{ ...parsed.nodes[0], id: parsed.nodes[1].id }, ...parsed.nodes.slice(1)] })).toBe(false);
    expect(validateGeneratedCanvas({ ...parsed, edges: [{ ...parsed.edges[0], id: parsed.edges[1].id }, ...parsed.edges.slice(1)] })).toBe(false);
    expect(validateGeneratedCanvas({ ...parsed, edges: [{ ...parsed.edges[0], id: parsed.nodes[0].id }, ...parsed.edges.slice(1)] })).toBe(false);
  });

  it("rejects edges that point to missing nodes", () => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    expect(validateGeneratedCanvas({ ...parsed, edges: [{ ...parsed.edges[0], toNode: "0123456789abcdef" }, ...parsed.edges.slice(1)] })).toBe(false);
  });

  it.each([
    "parent",
    "related",
    "prerequisite",
    "next",
    "evidence",
    "applies-to",
    "produces",
    "contradicts",
  ])("accepts the relationship label %s", (label) => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    expect(validateGeneratedCanvas({
      ...parsed,
      edges: [{ ...parsed.edges[0], label }, ...parsed.edges.slice(1)],
    })).toBe(true);
  });

  it.each(["영역", "depends-on", "Parent", ""])("rejects the relationship label %j", (label) => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    expect(validateGeneratedCanvas({
      ...parsed,
      edges: [{ ...parsed.edges[0], label }, ...parsed.edges.slice(1)],
    })).toBe(false);
  });

  it("renders globally unique 16-character lowercase IDs", () => {
    const parsed = JSON.parse(renderBrainCanvas(BRAIN_FOUNDATION_POLICY));
    const ids = [...parsed.nodes.map((node: { id: string }) => node.id), ...parsed.edges.map((edge: { id: string }) => edge.id)];
    expect(ids.every((id: string) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
