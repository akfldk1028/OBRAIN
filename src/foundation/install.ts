import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { renderAreaCanvas, renderBrainCanvas } from "./canvas.js";
import { renderAreaGuide, renderAreaMoc, renderHomeMoc, renderRootGuide } from "./markdown.js";
import {
  areaCanvasPath,
  areaGuidePath,
  areaMocPath,
  type VaultFoundationPolicy,
} from "./policy.js";

export interface FoundationChange {
  path: string;
  content: string;
}

export interface FoundationResult {
  created: string[];
  skippedExisting: string[];
  preview: boolean;
}

export function buildFoundationFiles(policy: VaultFoundationPolicy): FoundationChange[] {
  return [
    { path: policy.rootGuide, content: renderRootGuide(policy) },
    { path: policy.homeMoc, content: renderHomeMoc(policy) },
    { path: policy.brainCanvas, content: renderBrainCanvas(policy) },
    ...policy.areas.flatMap((area) => [
      { path: areaMocPath(area), content: renderAreaMoc(area) },
      { path: areaGuidePath(area), content: renderAreaGuide(area) },
      { path: areaCanvasPath(area), content: renderAreaCanvas(area) },
    ]),
  ];
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

async function ensureSafeParent(root: string, target: string): Promise<void> {
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;

  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`foundation parent is a symlink: ${segment}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }

  const canonicalParent = await realpath(path.dirname(target));
  if (isOutside(root, canonicalParent)) {
    throw new Error("foundation parent escaped vault");
  }
}

export async function installFoundation(input: {
  vaultRoot: string;
  policy: VaultFoundationPolicy;
  apply: boolean;
}): Promise<FoundationResult> {
  const root = await realpath(input.vaultRoot);
  const result: FoundationResult = { created: [], skippedExisting: [], preview: !input.apply };

  for (const change of buildFoundationFiles(input.policy)) {
    const target = path.resolve(root, change.path);
    if (isOutside(root, target)) throw new Error("foundation path escaped vault");

    if (!input.apply) {
      result.created.push(change.path);
      continue;
    }

    await ensureSafeParent(root, target);
    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(change.content, "utf8");
      } finally {
        await handle.close();
      }
      result.created.push(change.path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      result.skippedExisting.push(change.path);
    }
  }

  const review = path.join(root, input.policy.inbox, "검토필요", ".keep");
  if (input.apply) await ensureSafeParent(root, review);
  return result;
}
