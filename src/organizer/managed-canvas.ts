import { createHash } from "node:crypto";
import { validateGeneratedCanvas, type JsonCanvas } from "../foundation/canvas.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaMocPath } from "../foundation/policy.js";

const MAX_CANVAS_BYTES = 1_048_576;
const MAX_EXISTING_PATHS = 4_096;
const MAX_NODES = 1_024;
const MAX_RELATIONSHIPS = 4_096;
const UNSAFE_PATH = /[\\\[\]|#\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_INVALID = /[:<>"?*]/u;
const RELATIONSHIP_LABELS = new Set([
  "parent", "related", "prerequisite", "next", "evidence", "applies-to", "produces", "contradicts",
]);

type RelationshipLabel = "parent" | "related" | "prerequisite" | "next" | "evidence" | "applies-to" | "produces" | "contradicts";

export interface ManagedAreaCanvasInput {
  canvasPath: string;
  currentCanvas: string;
  existingPaths: ReadonlySet<string>;
  areaMocPath: string;
  childMocPaths: string[];
  representativeNotePaths: string[];
  relationships: Array<{ from: string; to: string; label: string }>;
}

const managedTargets = new Map(BRAIN_FOUNDATION_POLICY.areas.map((area) => [areaCanvasPath(area), areaMocPath(area)]));

function idFor(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateMarkdownPath(value: string): string {
  if (
    !value
    || value !== value.normalize("NFKC")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || UNSAFE_PATH.test(value)
    || WINDOWS_INVALID.test(value)
    || Buffer.byteLength(value, "utf8") > 1_024
  ) throw new Error(`managed Canvas path is unsafe: ${value}`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || /[ .]$/u.test(segment))) {
    throw new Error(`managed Canvas path is unsafe: ${value}`);
  }
  if (!value.toLocaleLowerCase("en-US").endsWith(".md")) throw new Error(`managed Canvas path is not Markdown: ${value}`);
  return value;
}

function validateExistingPaths(paths: ReadonlySet<string>): Set<string> {
  if (!(paths instanceof Set) || paths.size > MAX_EXISTING_PATHS) throw new Error("managed Canvas existing-path set is invalid or exceeds limit");
  const result = new Set<string>();
  const keys = new Set<string>();
  for (const path of paths) {
    const valid = validateMarkdownPath(path);
    const key = collisionKey(valid);
    if (keys.has(key)) throw new Error(`managed Canvas existing-path collision is ambiguous: ${valid}`);
    keys.add(key);
    result.add(valid);
  }
  return result;
}

function parseCurrentCanvas(text: string, existing: Set<string>): JsonCanvas {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CANVAS_BYTES) throw new Error("current Canvas exceeds limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("current Canvas is invalid JSON");
  }
  if (!validateGeneratedCanvas(parsed)) throw new Error("current Canvas is not a valid file-only generated Canvas");
  for (const node of parsed.nodes) {
    validateMarkdownPath(node.file);
    if (!existing.has(node.file)) throw new Error(`current Canvas file does not exist: ${node.file}`);
  }
  return parsed;
}

/** Total ordering over UTF-8 bytes; unlike localeCompare, this cannot vary with host ICU data. */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function comparePaths(left: string, right: string): number {
  return compareUtf8(collisionKey(left), collisionKey(right)) || compareUtf8(left, right);
}

function requireExisting(path: string, existing: Set<string>): string {
  const valid = validateMarkdownPath(path);
  if (!existing.has(valid)) throw new Error(`managed Canvas file does not exist with exact spelling: ${valid}`);
  return valid;
}

export function renderManagedAreaCanvas(input: ManagedAreaCanvasInput): string {
  const expectedMoc = managedTargets.get(input.canvasPath);
  if (!expectedMoc) throw new Error(`not an approved managed Canvas target: ${input.canvasPath}`);
  const existing = validateExistingPaths(input.existingPaths);
  parseCurrentCanvas(input.currentCanvas, existing);
  if (input.areaMocPath !== expectedMoc) throw new Error(`area MOC does not match managed Canvas target: ${input.areaMocPath}`);

  if (!Array.isArray(input.childMocPaths) || !Array.isArray(input.representativeNotePaths)) throw new Error("managed Canvas node lists are invalid");
  if (1 + input.childMocPaths.length + input.representativeNotePaths.length > MAX_NODES) throw new Error("managed Canvas nodes exceed limit");
  if (!Array.isArray(input.relationships) || input.relationships.length > MAX_RELATIONSHIPS) throw new Error("managed Canvas relationships exceed limit");

  const area = requireExisting(input.areaMocPath, existing);
  const children = input.childMocPaths.map((path) => requireExisting(path, existing)).sort(comparePaths);
  const notes = input.representativeNotePaths.map((path) => requireExisting(path, existing)).sort(comparePaths);
  const categories = [area, ...children, ...notes];
  const categoryKeys = new Set<string>();
  for (const path of categories) {
    const key = collisionKey(path);
    if (categoryKeys.has(key)) throw new Error(`duplicate managed Canvas category membership: ${path}`);
    categoryKeys.add(key);
  }

  const nodes = [
    { id: idFor(area), type: "file" as const, file: area, x: 0, y: 0, width: 360, height: 220 },
    ...children.map((file, index) => ({ id: idFor(file), type: "file" as const, file, x: 520, y: index * 260, width: 360, height: 200 })),
    ...notes.map((file, index) => ({ id: idFor(file), type: "file" as const, file, x: 1040, y: index * 260, width: 360, height: 200 })),
  ];
  const nodeIds = new Map(nodes.map((node) => [node.file, node.id]));
  const relationshipKeys = new Set<string>();
  const relationships = input.relationships.map((relationship) => {
    if (!relationship || typeof relationship !== "object" || !RELATIONSHIP_LABELS.has(relationship.label)) {
      throw new Error(`invalid Canvas relationship label: ${relationship?.label ?? ""}`);
    }
    const from = requireExisting(relationship.from, existing);
    const to = requireExisting(relationship.to, existing);
    const fromNode = nodeIds.get(from);
    const toNode = nodeIds.get(to);
    if (!fromNode || !toNode) throw new Error("managed Canvas relationship endpoint is not a selected node");
    if (from === to) throw new Error("managed Canvas relationship endpoint cannot reference itself");
    const key = `${collisionKey(from)}\u0000${relationship.label}\u0000${collisionKey(to)}`;
    if (relationshipKeys.has(key)) throw new Error("duplicate managed Canvas relationship");
    relationshipKeys.add(key);
    return { from, to, fromNode, toNode, label: relationship.label as RelationshipLabel, key };
  }).sort((left, right) => compareUtf8(left.key, right.key));
  const edges = relationships.map((relationship) => ({
    id: idFor(`${relationship.fromNode}:${relationship.label}:${relationship.toNode}`),
    fromNode: relationship.fromNode,
    toNode: relationship.toNode,
    label: relationship.label,
  }));

  const canvas = { nodes, edges };
  if (!validateGeneratedCanvas(canvas)) throw new Error("rendered managed Canvas failed validation");
  for (const node of canvas.nodes) {
    if (!existing.has(node.file)) throw new Error(`rendered managed Canvas file does not exist: ${node.file}`);
  }
  return `${JSON.stringify(canvas, null, 2)}\n`;
}
