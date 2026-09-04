import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit.js";
import { validateGeneratedCanvas } from "../src/foundation/canvas.js";
import { installFoundation } from "../src/foundation/install.js";
import { BRAIN_FOUNDATION_POLICY, areaCanvasPath, areaMocPath } from "../src/foundation/policy.js";
import { IndexCoordinator } from "../src/index-coordinator.js";
import { KnowledgeBase } from "../src/knowledge-base.js";
import type { OrganizerContext, OrganizerProvider } from "../src/organizer/provider.js";
import { OrganizerService } from "../src/organizer/service.js";
import { OrganizerStore } from "../src/organizer/store.js";
import { OrganizerTransactionEngine } from "../src/organizer/transaction.js";
import type { OrganizerConfig, ProposalDraft } from "../src/organizer/types.js";
import { SearchIndex } from "../src/search-index.js";
import { VaultRegistry } from "../src/vault-registry.js";

const START = "2026-09-01T12:00:00.000Z";
const AFTER_TRIAL = "2026-09-09T12:00:00.000Z";

const sources = {
  high: "# Safe high confidence\n\nBellman equation insight from the original source.\n",
  medium: "# Ambiguous medium confidence\n\nThis may belong to more than one study topic.\n",
  low: "# Low confidence\n\nA fragment without enough organizing context.\n",
  secret: "# Secret-bearing note\n\npassword: synthetic-not-a-real-secret\n",
  conflict: "# Sync conflict\n\nA conflicted copy must remain untouched.\n",
} as const;

class StoryProvider implements OrganizerProvider {
  readonly received: string[] = [];

  async propose(context: OrganizerContext): Promise<ProposalDraft> {
    this.received.push(context.note.content);
    const common: Omit<ProposalDraft, "title" | "summary" | "confidence"> = {
      targetDirectory: "20_Study/22_RL",
      type: "study",
      status: "active",
      tags: ["integration"],
      relatedNotePaths: [],
      reason: "Synthetic deterministic integration decision.",
    };
    if (context.note.content.includes("Safe high confidence")) {
      return { ...common, title: "Bellman Planning", summary: "A safe high-confidence study note.", confidence: 0.95 };
    }
    if (context.note.content.includes("Ambiguous medium confidence")) {
      return { ...common, title: "Ambiguous Topic", summary: "This note needs human review.", confidence: 0.75 };
    }
    if (context.note.content.includes("Low confidence")) {
      return { ...common, title: "Uncertain Fragment", summary: "There is not enough context.", confidence: 0.40 };
    }
    throw new Error("unexpected integration source reached the provider");
  }
}

describe("Brain organizer complete local story", () => {
  it("moves only a safe high-confidence note after trial and undoes it exactly", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-integration-"));
    const vaultRoot = path.join(temporaryRoot, "vault");
    const dataRoot = path.join(temporaryRoot, "data");
    const recoveryRoot = path.join(temporaryRoot, "recovery");
    const auditPath = path.join(dataRoot, "audit.jsonl");
    let store: OrganizerStore | undefined;
    let knowledge: KnowledgeBase | undefined;

    try {
      await mkdir(vaultRoot);
      await mkdir(dataRoot);
      const foundation = await installFoundation({
        vaultRoot,
        policy: BRAIN_FOUNDATION_POLICY,
        apply: true,
      });
      expect(foundation.preview).toBe(false);
      expect(foundation.created).toHaveLength(33);
      await mkdir(path.join(vaultRoot, "20_Study", "22_RL"), { recursive: true });

      const inboxPaths = {
        high: "Agent-Inbox/01-safe-high.md",
        medium: "Agent-Inbox/02-ambiguous.md",
        low: "Agent-Inbox/03-low.md",
        secret: "Agent-Inbox/04-secret.md",
        conflict: "Agent-Inbox/05-note.sync-conflict-20260901.md",
      } as const;
      const stableAt = new Date(Date.parse(START) - 600_000);
      for (const key of Object.keys(inboxPaths) as Array<keyof typeof inboxPaths>) {
        const absolute = path.join(vaultRoot, ...inboxPaths[key].split("/"));
        await writeFile(absolute, sources[key], "utf8");
        await utimes(absolute, stableAt, stableAt);
      }

      const registry = await VaultRegistry.create([{ id: "brain", root: vaultRoot }]);
      const searchIndex = new SearchIndex(path.join(dataRoot, "index.sqlite"));
      const coordinator = new IndexCoordinator(registry, searchIndex);
      const auditLogger = new AuditLogger(auditPath);
      const provider = new StoryProvider();
      store = new OrganizerStore(path.join(dataRoot, "organizer.sqlite"));
      let clock = START;
      const config: OrganizerConfig = {
        enabledVaults: ["brain"],
        mode: "automatic",
        minStableSeconds: 300,
        autoApplyConfidence: 0.90,
        maxNotesPerRun: 20,
        maxNoteBytes: 131_072,
        maxContextBytes: 262_144,
        proposalTtlHours: 24,
        recoveryDays: 30,
        reportsDirectory: "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports",
      };
      const organizer = new OrganizerService({
        registry,
        config,
        store,
        provider,
        transaction: new OrganizerTransactionEngine({ store, recoveryRoot, now: () => clock }),
        auditLogger,
        now: () => clock,
        lockPath: path.join(dataRoot, "organizer.lock"),
      });
      knowledge = new KnowledgeBase(registry, searchIndex, coordinator, auditLogger, organizer);
      await knowledge.initialize();

      const policy = await knowledge.getPolicy("brain");
      expect(policy.readingOrder).toEqual(["Agent-Inbox", ...BRAIN_FOUNDATION_POLICY.areas.map((area) => area.directory)]);

      const dryRun = await organizer.runToCompletion({ vault: "brain", requestedMode: "automatic" });
      expect(dryRun).toMatchObject({
        mode: "dry-run", discovered: 4, proposed: 3, applied: 0, review: 1, skipped: 2, failed: 0, status: "complete",
      });
      for (const key of Object.keys(inboxPaths) as Array<keyof typeof inboxPaths>) {
        await expect(readFile(path.join(vaultRoot, ...inboxPaths[key].split("/")), "utf8")).resolves.toBe(sources[key]);
      }

      clock = AFTER_TRIAL;
      const automatic = await organizer.runToCompletion({ vault: "brain", requestedMode: "automatic" });
      expect(automatic).toMatchObject({
        mode: "automatic", discovered: 4, proposed: 3, applied: 1, review: 1, skipped: 2, failed: 0, status: "complete",
      });

      const targetDirectory = path.join(vaultRoot, "20_Study", "22_RL");
      const targetFiles = (await readdir(targetDirectory)).filter((name) => name.endsWith(".md"));
      expect(targetFiles).toHaveLength(1);
      const destinationPath = `20_Study/22_RL/${targetFiles[0]}`;
      const organized = await readFile(path.join(targetDirectory, targetFiles[0]!), "utf8");
      expect(organized).toContain(`## 원문\n\n${sources.high}`);
      await expect(readFile(path.join(vaultRoot, ...inboxPaths.high.split("/")), "utf8")).rejects.toThrow();
      for (const key of ["medium", "low", "secret", "conflict"] as const) {
        await expect(readFile(path.join(vaultRoot, ...inboxPaths[key].split("/")), "utf8")).resolves.toBe(sources[key]);
      }
      expect(provider.received).toHaveLength(6);
      expect(provider.received).not.toContain(sources.secret);
      expect(provider.received).not.toContain(sources.conflict);

      const studyMocPath = areaMocPath(BRAIN_FOUNDATION_POLICY.areas[3]!);
      const studyMoc = await readFile(path.join(vaultRoot, ...studyMocPath.split("/")), "utf8");
      expect(studyMoc).toContain(`[[${destinationPath}|Bellman Planning]]`);
      for (const canvasPath of [
        BRAIN_FOUNDATION_POLICY.brainCanvas,
        ...BRAIN_FOUNDATION_POLICY.areas.map(areaCanvasPath),
      ]) {
        const canvas = JSON.parse(await readFile(path.join(vaultRoot, ...canvasPath.split("/")), "utf8"));
        expect(validateGeneratedCanvas(canvas)).toBe(true);
      }

      await coordinator.reconcile();
      expect((await knowledge.searchNotes({ query: "Bellman equation insight", vaults: ["brain"] })).hits.map((hit) => hit.path))
        .toEqual([destinationPath]);
      expect((await knowledge.getNoteLinks({ vault: "brain", path: destinationPath })).backlinks).toContain(studyMocPath);

      const integrity = await knowledge.audit({ vault: "brain" });
      expect(integrity.findings).toEqual([{
        code: "forbidden_artifact",
        category: "temporary",
        path: inboxPaths.conflict,
      }]);

      const transactionId = organized.match(/transaction_id:\s*(ORG-[A-Za-z0-9-]+)/u)?.[1];
      expect(transactionId).toBeDefined();
      await knowledge.undo({ vault: "brain", transactionId: transactionId! });
      await expect(readFile(path.join(vaultRoot, ...inboxPaths.high.split("/")), "utf8")).resolves.toBe(sources.high);
      await expect(readFile(path.join(vaultRoot, ...destinationPath.split("/")), "utf8")).rejects.toThrow();
      expect(await readFile(path.join(vaultRoot, ...studyMocPath.split("/")), "utf8")).not.toContain(destinationPath);

      const reports = await organizer.listReportPaths("brain");
      expect(reports).toHaveLength(2);
      const auditEvents = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(auditEvents.map((event) => event.action)).toEqual(expect.arrayContaining([
        "organizer_run", "organizer_apply", "organizer_audit", "organizer_undo",
      ]));
    } finally {
      await knowledge?.close();
      store?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
