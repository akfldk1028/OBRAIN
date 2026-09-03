# Brain Vault Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the approved Brain Vault folder system, AI guides, MOCs, generated Canvas maps, and safely place the three existing Inbox notes in their initial destinations.

**Architecture:** A small TypeScript foundation module holds one structured area manifest and renders deterministic Markdown and JSON Canvas files from it. A CLI supports dry-run and no-overwrite apply modes against any explicitly supplied Vault root; the first production run targets `D:\obsidian\Brain`, after which Syncthing delivers the same files to Oracle.

**Tech Stack:** Node.js 20+, TypeScript, Zod, Vitest, Obsidian Markdown, JSON Canvas, Syncthing

**Spec:** `docs/superpowers/specs/2026-09-03-brain-vault-auto-organization-design.md`

## Global Constraints

- Markdown remains the source of truth; Canvas is a generated human visualization.
- The root intake folder remains exactly `Agent-Inbox`.
- Approved top-level areas are exactly `00_Prompt`, `01_Development`, `10_Agent`, `20_Study`, `30_Business`, `40_Research`, `50_Project`, `60_Tools`, `98_DK`, and `99_Archive`.
- Folder depth is at most five levels below the Vault root.
- Foundation creation is no-overwrite and never modifies `.obsidian`, `.stfolder`, hidden folders, or a pre-existing file.
- `000_*_Map.canvas` files are AI-managed; all other Canvas files are human-managed.
- Existing Inbox note contents must remain byte-for-byte identical when moved in this phase.
- No secret, key, password, token, `.env`, or local machine credential may enter Git or a generated Vault file.
- The legacy `D:\obsidian\claude\Local_Claude` Vault remains untouched.

---

## File Structure

- Create `src/foundation/policy.ts`: canonical area manifest and foundation policy types.
- Create `src/foundation/markdown.ts`: pure Markdown renderers for root and area files.
- Create `src/foundation/canvas.ts`: pure deterministic JSON Canvas renderer and validator.
- Create `src/foundation/install.ts`: dry-run/no-overwrite directory and file installer.
- Create `src/foundation-cli.ts`: command-line entrypoint for previewing and applying the foundation.
- Create `test/foundation-policy.test.ts`: manifest and structural-policy tests.
- Create `test/foundation-markdown.test.ts`: Markdown template and managed-marker tests.
- Create `test/foundation-canvas.test.ts`: JSON Canvas shape and determinism tests.
- Create `test/foundation-install.test.ts`: filesystem dry-run, apply, idempotency, and no-overwrite tests.
- Modify `package.json`: add foundation preview/apply scripts.
- Modify `README.md`: document the foundation CLI and generated-file ownership.

### Task 1: Canonical Foundation Policy

**Files:**
- Create: `src/foundation/policy.ts`
- Test: `test/foundation-policy.test.ts`

**Interfaces:**
- Produces: `AreaDefinition`, `VaultFoundationPolicy`, `BRAIN_FOUNDATION_POLICY`, `areaMocPath()`, `areaGuidePath()`, and `areaCanvasPath()`.
- Consumed by: every later task in this plan and the organizer plan.

- [ ] **Step 1: Write the failing manifest tests**

```ts
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
```

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run: `npm test -- test/foundation-policy.test.ts`

Expected: FAIL because `src/foundation/policy.ts` does not exist.

- [ ] **Step 3: Implement the canonical policy**

```ts
export interface AreaDefinition {
  directory: string;
  slug: string;
  titleKo: string;
  purpose: string;
}

export interface VaultFoundationPolicy {
  version: string;
  inbox: "Agent-Inbox";
  maxDepth: 5;
  rootGuide: "000_AI_WORK_GUIDE.md";
  homeMoc: "000_Home_MOC.md";
  brainCanvas: "000_Brain_Map.canvas";
  areas: readonly AreaDefinition[];
}

export const BRAIN_FOUNDATION_POLICY: VaultFoundationPolicy = {
  version: "1.0.0",
  inbox: "Agent-Inbox",
  maxDepth: 5,
  rootGuide: "000_AI_WORK_GUIDE.md",
  homeMoc: "000_Home_MOC.md",
  brainCanvas: "000_Brain_Map.canvas",
  areas: [
    { directory: "00_Prompt", slug: "Prompt", titleKo: "프롬프트", purpose: "시스템 가이드와 재사용 프롬프트" },
    { directory: "01_Development", slug: "Development", titleKo: "개발", purpose: "코드, 설계, 구현 기록" },
    { directory: "10_Agent", slug: "Agent", titleKo: "AI 에이전트", purpose: "에이전트 구성과 운영" },
    { directory: "20_Study", slug: "Study", titleKo: "학습", purpose: "강의, 논문, 학습 노트" },
    { directory: "30_Business", slug: "Business", titleKo: "비즈니스", purpose: "사업과 운영 기록" },
    { directory: "40_Research", slug: "Research", titleKo: "연구", purpose: "연구 질문, 실험, 결과" },
    { directory: "50_Project", slug: "Project", titleKo: "프로젝트", purpose: "프로젝트별 실행 기록" },
    { directory: "60_Tools", slug: "Tools", titleKo: "도구", purpose: "도구와 서버 설정" },
    { directory: "98_DK", slug: "DK", titleKo: "기타 지식", purpose: "아직 확정되지 않은 기타 지식" },
    { directory: "99_Archive", slug: "Archive", titleKo: "보관", purpose: "완료 자료와 이력" },
  ],
};

export const areaMocPath = (area: AreaDefinition) =>
  `${area.directory}/000_${area.slug}_MOC.md`;
export const areaCanvasPath = (area: AreaDefinition) =>
  `${area.directory}/000_${area.slug}_Map.canvas`;
export const areaGuidePath = (area: AreaDefinition) =>
  `${area.directory}/99_작업가이드_다음AI용.md`;
```

- [ ] **Step 4: Run the focused test**

Run: `npm test -- test/foundation-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the policy**

```bash
git add src/foundation/policy.ts test/foundation-policy.test.ts
git commit -m "feat: define Brain Vault foundation policy"
```

### Task 2: Root Guide, Home MOC, and Area Markdown

**Files:**
- Create: `src/foundation/markdown.ts`
- Test: `test/foundation-markdown.test.ts`

**Interfaces:**
- Consumes: `VaultFoundationPolicy` and `AreaDefinition` from Task 1.
- Produces: `renderRootGuide(policy)`, `renderHomeMoc(policy)`, `renderAreaMoc(area)`, and `renderAreaGuide(area)` returning complete Markdown strings.

- [ ] **Step 1: Write failing content-contract tests**

```ts
import { describe, expect, it } from "vitest";
import { BRAIN_FOUNDATION_POLICY } from "../src/foundation/policy.js";
import { renderAreaMoc, renderHomeMoc, renderRootGuide } from "../src/foundation/markdown.js";

describe("foundation Markdown", () => {
  it("teaches every AI the required reading and writing rules", () => {
    const guide = renderRootGuide(BRAIN_FOUNDATION_POLICY);
    expect(guide).toContain("policy_version: 1.0.0");
    expect(guide).toContain("1. `000_AI_WORK_GUIDE.md`");
    expect(guide).toContain("Agent-Inbox");
    expect(guide).toContain("> [!abstract] 한눈에 보기");
    expect(guide).toContain("원문을 그대로 보존");
    expect(guide).toContain("최대 5레벨");
    for (const heading of [
      "## Vault 전체 구조", "## MOC 규칙", "## 수식 설명 순서", "## PDF와 논문",
      "## 태그", "## 링크와 Canvas", "## 자동 정리", "## 사용자 선호", "## 작업 체크리스트",
    ]) expect(guide).toContain(heading);
  });

  it("links Home to every area MOC and reserves one managed block", () => {
    const home = renderHomeMoc(BRAIN_FOUNDATION_POLICY);
    for (const area of BRAIN_FOUNDATION_POLICY.areas) {
      expect(home).toContain(`[[${area.directory}/000_${area.slug}_MOC]]`);
    }
    expect(home.match(/brain-auto:start note-index/g)).toHaveLength(1);
    expect(home.match(/brain-auto:end note-index/g)).toHaveLength(1);
  });

  it("creates an area MOC with a protected human section and managed index", () => {
    const study = renderAreaMoc(BRAIN_FOUNDATION_POLICY.areas[3]);
    expect(study).toContain("# 📚 Study MOC");
    expect(study).toContain("## 사람이 작성하는 설명");
    expect(study).toContain("<!-- brain-auto:start note-index -->");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- test/foundation-markdown.test.ts`

Expected: FAIL because the renderer module is missing.

- [ ] **Step 3: Implement deterministic Markdown renderers**

Use exact, non-placeholder sections so future AIs see the same contract:

```ts
import type { AreaDefinition, VaultFoundationPolicy } from "./policy.js";

const managedBlock = [
  "<!-- brain-auto:start note-index -->",
  "_자동 정리기가 이 구간만 갱신합니다._",
  "<!-- brain-auto:end note-index -->",
].join("\n");

export function renderRootGuide(policy: VaultFoundationPolicy): string {
  return `---\npolicy_version: ${policy.version}\ntype: ai-work-guide\n---\n\n` +
    `# 🤖 AI 작업 가이드\n\n` +
    `> [!abstract] 목적\n> 모든 AI가 같은 폴더·노트·링크 규칙을 사용합니다.\n\n` +
    `## 작업 전 읽기 순서\n\n1. \`000_AI_WORK_GUIDE.md\`\n2. \`000_Home_MOC.md\`\n` +
    `3. 작업 폴더의 \`99_작업가이드_다음AI용.md\`\n4. 작업 폴더의 \`000_*_MOC.md\`\n\n` +
    `## 필수 안전 규칙\n\n- 새 AI 노트는 먼저 \`${policy.inbox}\`에 생성합니다.\n` +
    `- 폴더는 최대 ${policy.maxDepth}레벨입니다.\n- 기존 파일을 덮어쓰거나 영구 삭제하지 않습니다.\n` +
    `- 비밀번호, API 키, SSH 키, 토큰은 노트에 기록하지 않습니다.\n` +
    `- 자동 정리 시 사용자의 원문을 그대로 보존합니다.\n\n` +
    `## 기본 노트 표현\n\n> [!abstract] 한눈에 보기\n> 쉬운 요약\n\n` +
    `> [!example] 쉬운 비유\n> 일상적인 예시\n\n> [!note] 추가 설명\n> 헷갈리는 부분\n\n` +
    `> [!tip] 기억할 핵심\n> 결론\n\n> [!warning] 주의할 점\n> 한계와 위험\n\n` +
    `## 연결 규칙\n\n모든 노트는 상위 MOC를 연결하며, 실제 근거가 있을 때만 관련·선행·후속·근거·활용·결과물·충돌 링크를 추가합니다.\n`;
}

export function renderHomeMoc(policy: VaultFoundationPolicy): string {
  const links = policy.areas.map((area) =>
    `- [[${area.directory}/000_${area.slug}_MOC|${area.titleKo}]] — ${area.purpose}`,
  ).join("\n");
  return `# 🧠 Brain Home MOC\n\n> [!abstract] 시작점\n> 사람과 AI가 Brain 전체를 탐색하는 공식 홈입니다.\n\n## 영역\n\n${links}\n\n## 자동 색인\n\n${managedBlock}\n`;
}

export function renderAreaMoc(area: AreaDefinition): string {
  return `# 📚 ${area.slug} MOC\n\n> [!abstract] 영역 목적\n> ${area.purpose}\n\n` +
    `## 사람이 작성하는 설명\n\n이 영역의 목표와 중요한 맥락을 기록합니다.\n\n## 자동 색인\n\n${managedBlock}\n\n` +
    `## 상위\n\n- [[000_Home_MOC]]\n`;
}

export function renderAreaGuide(area: AreaDefinition): string {
  return `# ${area.titleKo} 작업 가이드 — 다음 AI용\n\n> [!note] 먼저 읽기\n> 루트의 [[000_AI_WORK_GUIDE]]와 [[000_Home_MOC]]를 먼저 읽습니다.\n\n` +
    `## 범위\n\n${area.purpose}\n\n## 완료 조건\n\n- 원문 보존\n- 상위 MOC 연결\n- 실제 관련 노트만 연결\n- 출처가 있으면 페이지와 링크 기록\n`;
}
```

Expand `renderRootGuide()` with these exact operational sections and content; keep the pure string
renderer deterministic and end the file with `#AI가이드 #인수인계 #시스템 #범용`:

| Section | Required content |
|---|---|
| `Vault 전체 구조` | Local path `D:/obsidian/Brain/`, the ten area purposes, `Agent-Inbox`, and maximum five levels |
| `MOC 규칙` | Each area requires a `000_*_MOC.md`; child notes link upward; managed marker bytes belong only to automation |
| `노트 작성 규칙` | `[!abstract]`, `[!example]`, `[!note]`, `[!tip]`, `[!warning]`, `[!info]`, and `[!success]` purposes |
| `수식 설명 순서` | everyday analogy, middle-school intuition, formula, symbol table, and step-by-step reason in that order |
| `PDF와 논문` | source title, section, page range, numbered topic notes, master-note embeds, exam questions, and `활용 인사이트` |
| `태그` | `#MOC`, `#학습`, `#논문`, `#프로젝트`, `#RL`, `#CV`, `#NLP`, and `#Unity` |
| `링크와 Canvas` | wikilink, heading link, block link, embed syntax, parent/related/prerequisite/next/evidence/applies-to/produces/contradicts semantics |
| `자동 정리` | write to Inbox, secret scan, proposal, validation, confidence bands, MOC/Canvas refresh, audit, and undo |
| `사용자 선호` | Korean with English technical terms, casual tone, beginner-level explanation, humanistic analogy first, attractive callouts |
| `작업 체크리스트` | read guides/MOCs before work; preserve sources, links, formulas, and original text; update MOC and guide after work |

`renderAreaGuide()` must add one area-specific rule block: Study requires citations and the five-step
formula order; Research requires question/method/evidence/limitation/insight; Project requires goal,
status, decisions, outputs, and next action; Development requires environment, reproduction, change,
test, and rollback; Tools requires configuration purpose, dependencies, verification, recovery, and
strict exclusion of secret values. Other areas inherit the root contract and state their purpose.

- [ ] **Step 4: Run the Markdown tests**

Run: `npm test -- test/foundation-markdown.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the renderers**

```bash
git add src/foundation/markdown.ts test/foundation-markdown.test.ts
git commit -m "feat: render Brain Vault guides and MOCs"
```

### Task 3: Deterministic Generated Canvas Maps

**Files:**
- Create: `src/foundation/canvas.ts`
- Test: `test/foundation-canvas.test.ts`

**Interfaces:**
- Consumes: `VaultFoundationPolicy` and `AreaDefinition`.
- Produces: `JsonCanvas`, `renderBrainCanvas(policy)`, `renderAreaCanvas(area)`, and `validateGeneratedCanvas(value)`.

- [ ] **Step 1: Write failing JSON Canvas tests**

```ts
import { describe, expect, it } from "vitest";
import { renderBrainCanvas, validateGeneratedCanvas } from "../src/foundation/canvas.js";
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
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npm test -- test/foundation-canvas.test.ts`

Expected: FAIL because the Canvas module is missing.

- [ ] **Step 3: Implement stable file nodes and labeled edges**

```ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AreaDefinition, VaultFoundationPolicy } from "./policy.js";
import { areaMocPath } from "./policy.js";

const idFor = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const nodeSchema = z.object({
  id: z.string(), type: z.literal("file"), file: z.string(),
  x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
});
const edgeSchema = z.object({
  id: z.string(), fromNode: z.string(), toNode: z.string(), label: z.string(),
});
const canvasSchema = z.object({ nodes: z.array(nodeSchema), edges: z.array(edgeSchema) });
export type JsonCanvas = z.infer<typeof canvasSchema>;

export function validateGeneratedCanvas(value: unknown): value is JsonCanvas {
  return canvasSchema.safeParse(value).success;
}

export function renderBrainCanvas(policy: VaultFoundationPolicy): string {
  const homeId = idFor(policy.homeMoc);
  const home = { id: homeId, type: "file" as const, file: policy.homeMoc, x: 0, y: 0, width: 360, height: 220 };
  const areaNodes = policy.areas.map((area, index) => ({
    id: idFor(areaMocPath(area)), type: "file" as const, file: areaMocPath(area),
    x: 520 + (index % 2) * 440, y: Math.floor(index / 2) * 260 - 520,
    width: 360, height: 200,
  }));
  const edges = areaNodes.map((node) => ({
    id: idFor(`${homeId}:parent:${node.id}`), fromNode: homeId, toNode: node.id, label: "영역",
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
```

- [ ] **Step 4: Run Canvas tests**

Run: `npm test -- test/foundation-canvas.test.ts`

Expected: PASS and two consecutive renders are identical.

- [ ] **Step 5: Commit Canvas generation**

```bash
git add src/foundation/canvas.ts test/foundation-canvas.test.ts
git commit -m "feat: generate deterministic Brain Canvas maps"
```

### Task 4: Dry-Run and No-Overwrite Foundation Installer

**Files:**
- Create: `src/foundation/install.ts`
- Test: `test/foundation-install.test.ts`

**Interfaces:**
- Consumes: policy and renderers from Tasks 1-3.
- Produces: `FoundationChange`, `FoundationResult`, `buildFoundationFiles(policy)`, and `installFoundation({ vaultRoot, policy, apply })`.

- [ ] **Step 1: Write failing installer tests**

```ts
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_FOUNDATION_POLICY } from "../src/foundation/policy.js";
import { installFoundation } from "../src/foundation/install.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("foundation installer", () => {
  it("previews without writing, then applies without overwriting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    roots.push(root);
    const preview = await installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: false });
    expect(preview.created.length).toBeGreaterThan(30);
    await expect(readFile(path.join(root, "000_AI_WORK_GUIDE.md"), "utf8")).rejects.toThrow();

    await writeFile(path.join(root, "000_Home_MOC.md"), "human home", "utf8");
    const applied = await installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true });
    expect(await readFile(path.join(root, "000_Home_MOC.md"), "utf8")).toBe("human home");
    expect(applied.skippedExisting).toContain("000_Home_MOC.md");
    expect(await readFile(path.join(root, "20_Study/000_Study_MOC.md"), "utf8")).toContain("Study MOC");
  });

  it("rejects an existing area symlink instead of writing through it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brain-foundation-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "brain-outside-"));
    roots.push(root, outside);
    await symlink(outside, path.join(root, "20_Study"), "junction");
    await expect(installFoundation({ vaultRoot: root, policy: BRAIN_FOUNDATION_POLICY, apply: true }))
      .rejects.toThrow("symlink");
    await expect(readFile(path.join(outside, "000_Study_MOC.md"), "utf8")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- test/foundation-install.test.ts`

Expected: FAIL because the installer is missing.

- [ ] **Step 3: Implement a create-only installer**

```ts
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { renderAreaCanvas, renderBrainCanvas } from "./canvas.js";
import { renderAreaGuide, renderAreaMoc, renderHomeMoc, renderRootGuide } from "./markdown.js";
import { areaCanvasPath, areaGuidePath, areaMocPath, type VaultFoundationPolicy } from "./policy.js";

export interface FoundationChange { path: string; content: string }
export interface FoundationResult { created: string[]; skippedExisting: string[]; preview: boolean }

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

async function ensureSafeParent(root: string, target: string): Promise<void> {
  const relativeParent = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`foundation parent is a symlink: ${segment}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  const canonicalParent = await realpath(path.dirname(target));
  const confined = path.relative(root, canonicalParent);
  if (confined.startsWith("..") || path.isAbsolute(confined)) throw new Error("foundation parent escaped vault");
}

export async function installFoundation(input: {
  vaultRoot: string; policy: VaultFoundationPolicy; apply: boolean;
}): Promise<FoundationResult> {
  const root = await realpath(input.vaultRoot);
  const result: FoundationResult = { created: [], skippedExisting: [], preview: !input.apply };
  for (const change of buildFoundationFiles(input.policy)) {
    const target = path.resolve(root, change.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("foundation path escaped vault");
    if (!input.apply) { result.created.push(change.path); continue; }
    await ensureSafeParent(root, target);
    try {
      const handle = await open(target, "wx", 0o600);
      try { await handle.writeFile(change.content, "utf8"); } finally { await handle.close(); }
      result.created.push(change.path);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      result.skippedExisting.push(change.path);
    }
  }
  const review = path.join(root, input.policy.inbox, "검토필요", ".keep");
  if (input.apply) await ensureSafeParent(root, review);
  return result;
}
```

- [ ] **Step 4: Add idempotency and hidden-folder assertions**

Extend the same test to call `installFoundation(...apply: true)` twice and assert that the second call
creates no files. Also assert that `.obsidian` and `.stfolder` do not appear in `created`.

- [ ] **Step 5: Run installer and foundation tests**

Run: `npm test -- test/foundation-policy.test.ts test/foundation-markdown.test.ts test/foundation-canvas.test.ts test/foundation-install.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the installer**

```bash
git add src/foundation/install.ts test/foundation-install.test.ts
git commit -m "feat: install Vault foundation without overwrites"
```

### Task 5: Foundation CLI and Operator Documentation

**Files:**
- Create: `src/foundation-cli.ts`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/foundation-cli.test.ts`

**Interfaces:**
- Consumes: `installFoundation()` and `BRAIN_FOUNDATION_POLICY`.
- Produces: `node dist/foundation-cli.js --vault ABSOLUTE_VAULT_PATH [--apply]`.

- [ ] **Step 1: Write failing argument-parser tests**

```ts
import { describe, expect, it } from "vitest";
import { parseFoundationArgs } from "../src/foundation-cli.js";

describe("foundation CLI", () => {
  it("requires an absolute vault and defaults to preview", () => {
    expect(parseFoundationArgs(["--vault", "D:\\obsidian\\Brain"])).toEqual({
      vaultRoot: "D:\\obsidian\\Brain", apply: false,
    });
    expect(() => parseFoundationArgs(["--apply"])).toThrow("--vault is required");
    expect(() => parseFoundationArgs(["--vault", "relative"])).toThrow("absolute");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- test/foundation-cli.test.ts`

Expected: FAIL because the CLI is missing.

- [ ] **Step 3: Implement the CLI with an import-safe main guard**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFoundation } from "./foundation/install.js";
import { BRAIN_FOUNDATION_POLICY } from "./foundation/policy.js";

export function parseFoundationArgs(args: string[]): { vaultRoot: string; apply: boolean } {
  const index = args.indexOf("--vault");
  const vaultRoot = index >= 0 ? args[index + 1] : undefined;
  if (!vaultRoot) throw new Error("--vault is required");
  if (!path.isAbsolute(vaultRoot)) throw new Error("--vault must be absolute");
  return { vaultRoot, apply: args.includes("--apply") };
}

async function main(): Promise<void> {
  const args = parseFoundationArgs(process.argv.slice(2));
  const result = await installFoundation({ ...args, policy: BRAIN_FOUNDATION_POLICY });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
```

- [ ] **Step 4: Add package scripts and exact README commands**

Add these scripts:

```json
{
  "foundation:preview": "node dist/foundation-cli.js",
  "foundation:apply": "node dist/foundation-cli.js --apply"
}
```

Document that callers append the quoted absolute Vault path and add `--apply` only after reviewing
preview output:

```powershell
npm run build
node dist/foundation-cli.js --vault "D:\obsidian\Brain"
node dist/foundation-cli.js --vault "D:\obsidian\Brain" --apply
```

- [ ] **Step 5: Run the CLI and full regression suite**

Run: `npm test -- test/foundation-cli.test.ts && npm run typecheck && npm run build`

Expected: tests pass, typecheck passes, and `dist/foundation-cli.js` exists.

- [ ] **Step 6: Commit the CLI and docs**

```bash
git add src/foundation-cli.ts test/foundation-cli.test.ts package.json README.md
git commit -m "feat: add Brain Vault foundation CLI"
```

### Task 6: Apply Foundation and Rehome the Three Known Notes

**Files:**
- Create in Vault: the files generated by Tasks 1-5 beneath `D:\obsidian\Brain`
- Move in Vault: exact three existing `Agent-Inbox` files listed below
- No Git source file changes

**Interfaces:**
- Consumes: built foundation CLI and the existing bidirectional Syncthing folder.
- Produces: initialized local and Oracle Brain Vaults with identical structure.

- [ ] **Step 1: Request write permission for only the Brain Vault**

Request filesystem write access to `D:\obsidian\Brain`. Do not request access to the legacy Vault or
the whole `D:` drive.

- [ ] **Step 2: Build and preview the exact changes**

Run:

```powershell
npm run build
node dist/foundation-cli.js --vault "D:\obsidian\Brain"
```

Expected: a JSON preview containing the three root files, thirty area files, and no path outside the
Brain Vault. Existing files appear only as skipped if already present.

- [ ] **Step 3: Apply foundation files with create-only semantics**

Run:

```powershell
node dist/foundation-cli.js --vault "D:\obsidian\Brain" --apply
node dist/foundation-cli.js --vault "D:\obsidian\Brain" --apply
```

Expected: first run creates missing files; second run reports every foundation file as existing and
does not change its contents.

- [ ] **Step 4: Hash and move the exact current notes without force**

Use one PowerShell process end-to-end. Resolve every source and destination, verify each remains
inside `D:\obsidian\Brain`, verify all destinations are absent, record SHA-256 hashes, and then use
`Move-Item -LiteralPath` without `-Force`:

```powershell
$brainRoot = (Resolve-Path -LiteralPath 'D:\obsidian\Brain').Path
$moves = @(
  @{
    Source = 'Agent-Inbox\2026-09-02-AI-인수인계-Obsidian-MCP-서버-fa8e7a2e.md'
    Target = '60_Tools\61_Obsidian_MCP\01_Oracle_MCP_서버_인수인계.md'
  },
  @{
    Source = 'Agent-Inbox\2026-09-02-연결-테스트-51d5613c.md'
    Target = '99_Archive\99_Connection_Tests\2026-09-02-연결-테스트-51d5613c.md'
  },
  @{
    Source = 'Agent-Inbox\2026-09-02-연결-테스트-d2c086aa.md'
    Target = '99_Archive\99_Connection_Tests\2026-09-02-연결-테스트-d2c086aa.md'
  }
)
$before = @{}
foreach ($move in $moves) {
  $source = [IO.Path]::GetFullPath((Join-Path $brainRoot $move.Source))
  $target = [IO.Path]::GetFullPath((Join-Path $brainRoot $move.Target))
  $sourceRel = [IO.Path]::GetRelativePath($brainRoot, $source)
  $targetRel = [IO.Path]::GetRelativePath($brainRoot, $target)
  if ($sourceRel.StartsWith('..') -or [IO.Path]::IsPathRooted($sourceRel)) { throw 'unsafe source' }
  if ($targetRel.StartsWith('..') -or [IO.Path]::IsPathRooted($targetRel)) { throw 'unsafe target' }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "missing source: $source" }
  if (Test-Path -LiteralPath $target) { throw "target exists: $target" }
  $before[$target] = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
  Move-Item -LiteralPath $source -Destination $target
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $before[$target]) { throw "hash mismatch: $target" }
}
```

Expected: each target exists with the same SHA-256 as its source content; none of the three original
paths remains.

- [ ] **Step 5: Verify Obsidian files and JSON Canvas locally**

Run:

```powershell
Get-Content -Raw -LiteralPath 'D:\obsidian\Brain\000_AI_WORK_GUIDE.md'
Get-Content -Raw -LiteralPath 'D:\obsidian\Brain\000_Home_MOC.md'
Get-Content -Raw -LiteralPath 'D:\obsidian\Brain\000_Brain_Map.canvas' | ConvertFrom-Json | Select-Object nodes,edges
Get-ChildItem -LiteralPath 'D:\obsidian\Brain\Agent-Inbox' -File -Recurse
```

Expected: guides are readable, Canvas JSON parses, and no top-level Inbox files remain.

- [ ] **Step 6: Verify synchronization before claiming completion**

Wait until local Syncthing reports `idle` and zero pending bytes. On Oracle, verify the Home MOC,
Brain Canvas, Tools handoff note, and two archived tests exist under `/srv/brain/vaults/brain`, then
compare their SHA-256 values to local files. Finally use public MCP `search_notes` and `read_note` to
confirm the moved handoff note is indexed at its new path.

Expected: local and server hashes match, Syncthing is idle, and MCP search/read returns the new path.

### Task 7: Foundation Regression Gate

**Files:**
- No new files

**Interfaces:**
- Consumes: completed foundation code and applied Vault.
- Produces: a verified foundation baseline for the organizer plan.

- [ ] **Step 1: Run the complete repository verification**

Run: `npm run verify`

Expected: all tests, typecheck, build, local smoke, and HTTP smoke pass.

- [ ] **Step 2: Check the repository and Vault boundaries**

Run:

```powershell
git status --short
rg -n "sk-[A-Za-z0-9]|BEGIN .*PRIVATE KEY|DASHSCOPE_API_KEY=|MCP_JWT_SECRET=" src test docs README.md
```

Expected: clean Git worktree and no committed secret value.

- [ ] **Step 3: Record the completion commit only if verification required a tracked correction**

If a tracked correction was necessary, return to the task that owns the failing file, repeat that
task's explicit `git add` command and test gate, and commit with that task's specified message. If no
correction was necessary, do not create an empty commit.
