import { createHash } from "node:crypto";
import { z } from "zod";
import type { AreaDefinition, VaultFoundationPolicy } from "./policy.js";
import { areaMocPath } from "./policy.js";

const idFor = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const nodeSchema = z.object({
  id: z.string(),
  type: z.literal("file"),
  file: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const edgeSchema = z.object({
  id: z.string(),
  fromNode: z.string(),
  toNode: z.string(),
  label: z.string(),
});

const canvasSchema = z.object({ nodes: z.array(nodeSchema), edges: z.array(edgeSchema) });

export type JsonCanvas = z.infer<typeof canvasSchema>;

export function validateGeneratedCanvas(value: unknown): value is JsonCanvas {
  return canvasSchema.safeParse(value).success;
}

export function renderBrainCanvas(policy: VaultFoundationPolicy): string {
  const homeId = idFor(policy.homeMoc);
  const home = {
    id: homeId,
    type: "file" as const,
    file: policy.homeMoc,
    x: 0,
    y: 0,
    width: 360,
    height: 220,
  };
  const areaNodes = policy.areas.map((area, index) => ({
    id: idFor(areaMocPath(area)),
    type: "file" as const,
    file: areaMocPath(area),
    x: 520 + (index % 2) * 440,
    y: Math.floor(index / 2) * 260 - 520,
    width: 360,
    height: 200,
  }));
  const edges = areaNodes.map((node) => ({
    id: idFor(`${homeId}:parent:${node.id}`),
    fromNode: homeId,
    toNode: node.id,
    label: "영역",
  }));

  return `${JSON.stringify({ nodes: [home, ...areaNodes], edges }, null, 2)}\n`;
}

export function renderAreaCanvas(area: AreaDefinition): string {
  const file = areaMocPath(area);
  return `${JSON.stringify({
    nodes: [{ id: idFor(file), type: "file", file, x: 0, y: 0, width: 360, height: 220 }],
    edges: [],
  }, null, 2)}\n`;
}
