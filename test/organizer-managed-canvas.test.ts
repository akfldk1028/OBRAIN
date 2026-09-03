import { describe, expect, it } from "vitest";
import { renderAreaCanvas, validateGeneratedCanvas } from "../src/foundation/canvas.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaMocPath } from "../src/foundation/policy.js";
import { renderManagedAreaCanvas } from "../src/organizer/managed-canvas.js";

const study = BRAIN_FOUNDATION_POLICY.areas.find((area) => area.slug === "Study")!;
const canvasPath = areaCanvasPath(study);
const mocPath = areaMocPath(study);
const currentCanvas = renderAreaCanvas(study);
const existingPaths = new Set([
  mocPath,
  "20_Study/01_Math/000_Math_MOC.md",
  "20_Study/01_Math/algebra.md",
  "20_Study/02_Physics/mechanics.md",
]);

const input = () => ({
  canvasPath,
  currentCanvas,
  existingPaths,
  areaMocPath: mocPath,
  childMocPaths: ["20_Study/01_Math/000_Math_MOC.md"],
  representativeNotePaths: ["20_Study/02_Physics/mechanics.md", "20_Study/01_Math/algebra.md"],
  relationships: [
    { from: "20_Study/01_Math/algebra.md", to: mocPath, label: "parent" },
    { from: "20_Study/02_Physics/mechanics.md", to: "20_Study/01_Math/algebra.md", label: "related" },
  ],
});

describe("managed area Canvas rendering", () => {
  it("generates only deterministic file nodes and exact-vocabulary edges", () => {
    const first = renderManagedAreaCanvas(input());
    const second = renderManagedAreaCanvas({
      ...input(),
      representativeNotePaths: [...input().representativeNotePaths].reverse(),
      relationships: [...input().relationships].reverse(),
    });
    const parsed = JSON.parse(first);

    expect(first).toBe(second);
    expect(validateGeneratedCanvas(parsed)).toBe(true);
    expect(parsed.nodes.every((node: { type: string }) => node.type === "file")).toBe(true);
    expect(parsed.nodes.map((node: { file: string; x: number; y: number }) => ({ file: node.file, x: node.x, y: node.y }))).toEqual([
      { file: mocPath, x: 0, y: 0 },
      { file: "20_Study/01_Math/000_Math_MOC.md", x: 520, y: 0 },
      { file: "20_Study/01_Math/algebra.md", x: 1040, y: 0 },
      { file: "20_Study/02_Physics/mechanics.md", x: 1040, y: 260 },
    ]);
    expect(parsed.edges.map((edge: { label: string }) => edge.label)).toEqual(["parent", "related"]);
    expect(new Set(parsed.nodes.map((node: { id: string }) => node.id)).size).toBe(parsed.nodes.length);
  });

  it("fails closed when the current Canvas is invalid JSON or not a valid file-only Canvas", () => {
    expect(() => renderManagedAreaCanvas({ ...input(), currentCanvas: "not json" })).toThrow(/current Canvas/i);
    expect(() => renderManagedAreaCanvas({
      ...input(),
      currentCanvas: JSON.stringify({
        nodes: [{ id: "0123456789abcdef", type: "text", text: "human", x: 0, y: 0, width: 100, height: 100 }],
        edges: [],
      }),
    })).toThrow(/current Canvas/i);
  });

  it("refuses manual or merely pattern-matching Canvas targets", () => {
    expect(() => renderManagedAreaCanvas({ ...input(), canvasPath: "20_Study/my.canvas" })).toThrow(/managed Canvas target/i);
    expect(() => renderManagedAreaCanvas({ ...input(), canvasPath: "20_Study/000_Evil_Map.canvas" })).toThrow(/managed Canvas target/i);
  });

  it("requires current and generated file references to exist with exact spelling", () => {
    expect(() => renderManagedAreaCanvas({
      ...input(),
      representativeNotePaths: ["20_Study/missing.md"],
    })).toThrow(/does not exist/i);
    expect(() => renderManagedAreaCanvas({
      ...input(),
      areaMocPath: "20_Study/000_study_MOC.md",
    })).toThrow(/area MOC|does not exist/i);

    const current = JSON.parse(currentCanvas);
    current.nodes[0].file = "20_Study/missing-current.md";
    expect(() => renderManagedAreaCanvas({ ...input(), currentCanvas: JSON.stringify(current) })).toThrow(/current Canvas.*does not exist/i);
  });

  it("rejects ambiguous existing-path sets and unsafe paths", () => {
    expect(() => renderManagedAreaCanvas({
      ...input(),
      existingPaths: new Set([...existingPaths, "20_Study/01_Math/ALGEBRA.md"]),
    })).toThrow(/collision|ambiguous/i);
    expect(() => renderManagedAreaCanvas({
      ...input(),
      representativeNotePaths: ["../escape.md"],
    })).toThrow(/path/i);
  });

  it("rejects unknown labels, dangling endpoints, and duplicate category membership", () => {
    expect(() => renderManagedAreaCanvas({
      ...input(),
      relationships: [{ from: "20_Study/01_Math/algebra.md", to: mocPath, label: "depends-on" }],
    })).toThrow(/relationship label/i);
    expect(() => renderManagedAreaCanvas({
      ...input(),
      relationships: [{ from: "20_Study/01_Math/algebra.md", to: "20_Study/01_Math/000_Math_MOC.md", label: "parent" }],
      childMocPaths: [],
    })).toThrow(/endpoint/i);
    expect(() => renderManagedAreaCanvas({
      ...input(),
      representativeNotePaths: ["20_Study/01_Math/000_Math_MOC.md"],
    })).toThrow(/duplicate|category/i);
  });

  it("orders nodes and edges bytewise independent of input order", () => {
    const ordinary = "20_Study/ab.md";
    const softHyphen = "20_Study/a\u00adb.md";
    const bytewisePaths = new Set([...existingPaths, ordinary, softHyphen]);
    const forward = renderManagedAreaCanvas({
      ...input(),
      existingPaths: bytewisePaths,
      representativeNotePaths: [ordinary, softHyphen],
      relationships: [
        { from: ordinary, to: mocPath, label: "parent" },
        { from: softHyphen, to: mocPath, label: "parent" },
      ],
    });
    const reversed = renderManagedAreaCanvas({
      ...input(),
      existingPaths: bytewisePaths,
      representativeNotePaths: [softHyphen, ordinary],
      relationships: [
        { from: softHyphen, to: mocPath, label: "parent" },
        { from: ordinary, to: mocPath, label: "parent" },
      ],
    });

    expect(reversed).toBe(forward);
    expect(forward.indexOf(`\"file\": \"${ordinary}\"`)).toBeLessThan(forward.indexOf(`\"file\": \"${softHyphen}\"`));
  });
});
