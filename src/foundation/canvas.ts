import { createHash } from "node:crypto";
import { z } from "zod";
import type { AreaDefinition, VaultFoundationPolicy } from "./policy.js";
import { areaMocPath } from "./policy.js";

const idFor = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const idSchema = z.string().regex(/^[0-9a-f]{16}$/);

const nodeSchema = z.object({
  id: idSchema,
  type: z.literal("file"),
  file: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
}).strict();

const edgeSchema = z.object({
  id: idSchema,
  fromNode: idSchema,
  toNode: idSchema,
  label: z.enum([
    "parent",
    "related",
    "prerequisite",
    "next",
    "evidence",
    "applies-to",
    "produces",
    "contradicts",
  ]),
}).strict();

const canvasSchema = z.object({ nodes: z.array(nodeSchema), edges: z.array(edgeSchema) }).strict();

export type JsonCanvas = z.infer<typeof canvasSchema>;

export function validateGeneratedCanvas(value: unknown): value is JsonCanvas {
  const parsed = canvasSchema.safeParse(value);
  if (!parsed.success) return false;

  const nodeIds = new Set(parsed.data.nodes.map((node) => node.id));
  if (nodeIds.size !== parsed.data.nodes.length) return false;

  const allIds = new Set(nodeIds);
  for (const edge of parsed.data.edges) {
    if (allIds.has(edge.id)) return false;
    allIds.add(edge.id);
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) return false;
  }

  return true;
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
    id: idFor(`${node.id}:parent:${homeId}`),
    fromNode: node.id,
    toNode: homeId,
    label: "parent" as const,
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
