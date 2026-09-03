import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
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

interface PlannedFoundationChange extends FoundationChange {
  target: string;
  parent: string;
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

function foundationPathError(relativePath: string): Error {
  return new Error(`foundation path is unsafe: ${relativePath}`);
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function validateRelativeFoundationPath(relativePath: string): void {
  if (
    !relativePath
    || /[\u0000-\u001F\u007F]/u.test(relativePath)
    || path.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
  ) {
    throw foundationPathError(relativePath);
  }

  const segments = relativePath.split(/[\\/]/u);
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || segment.startsWith(".")
    || /[:<>"|?*]/u.test(segment)
  ))) {
    throw foundationPathError(relativePath);
  }
}

function pathSegments(root: string, candidate: string): string[] {
  const relative = path.relative(root, candidate);
  if (isOutside(root, candidate)) throw new Error("foundation parent escaped vault");
  return relative ? relative.split(path.sep).filter(Boolean) : [];
}

async function assertSafeExistingPath(root: string, candidate: string): Promise<void> {
  let current = root;
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("foundation vault root is not a directory");
  }

  for (const segment of pathSegments(root, candidate)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`foundation parent is a symlink: ${segment}`);
    if (!stat.isDirectory()) throw new Error(`foundation parent is not a directory: ${segment}`);
  }

  const canonical = await realpath(candidate);
  if (isOutside(root, canonical)) throw new Error("foundation parent escaped vault");
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  let current = root;
  for (const segment of pathSegments(root, directory)) {
    current = path.join(current, segment);
    try {
      await lstat(current);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError: unknown) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
    }

    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`foundation parent is a symlink: ${segment}`);
    if (!stat.isDirectory()) throw new Error(`foundation parent is not a directory: ${segment}`);
  }

  const canonical = await realpath(directory);
  if (isOutside(root, canonical)) throw new Error("foundation parent escaped vault");
}

async function preflightParents(root: string, changes: readonly PlannedFoundationChange[], reviewDirectory: string): Promise<void> {
  const parents = new Set([...changes.map((change) => change.parent), reviewDirectory]);
  for (const parent of parents) await assertSafeExistingPath(root, parent);
}

async function removeTemporaryFile(root: string, temp: string): Promise<void> {
  await assertSafeExistingPath(root, path.dirname(temp));
  try {
    await unlink(temp);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function publishCreateOnly(root: string, change: PlannedFoundationChange): Promise<"created" | "existing"> {
  const temp = path.join(change.parent, `foundation-tmp-${randomUUID()}`);
  let primaryError: unknown;

  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(change.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await assertSafeExistingPath(root, change.parent);
    try {
      await link(temp, change.target);
    } catch (error: unknown) {
      await assertSafeExistingPath(root, change.parent);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    }
    await assertSafeExistingPath(root, change.parent);
    return "created";
  } catch (error: unknown) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await removeTemporaryFile(root, temp);
    } catch (cleanupError: unknown) {
      if (!primaryError) throw cleanupError;
    }
  }
}

export async function installFoundation(input: {
  vaultRoot: string;
  policy: VaultFoundationPolicy;
  apply: boolean;
}): Promise<FoundationResult> {
  const root = await realpath(input.vaultRoot);
  const changes = buildFoundationFiles(input.policy);
  const planned = changes.map((change): PlannedFoundationChange => {
    validateRelativeFoundationPath(change.path);
    const target = path.resolve(root, change.path);
    if (isOutside(root, target)) throw foundationPathError(change.path);
    return { ...change, target, parent: path.dirname(target) };
  });

  const reviewRelative = `${input.policy.inbox}/검토필요`;
  validateRelativeFoundationPath(reviewRelative);
  const reviewDirectory = path.resolve(root, reviewRelative);
  if (isOutside(root, reviewDirectory)) throw foundationPathError(reviewRelative);

  await preflightParents(root, planned, reviewDirectory);

  const result: FoundationResult = { created: [], skippedExisting: [], preview: !input.apply };
  if (!input.apply) {
    result.created.push(...changes.map((change) => change.path));
    return result;
  }

  for (const change of planned) {
    await ensureSafeDirectory(root, change.parent);
    const published = await publishCreateOnly(root, change);
    if (published === "created") result.created.push(change.path);
    else result.skippedExisting.push(change.path);
  }

  await ensureSafeDirectory(root, reviewDirectory);
  return result;
}
