import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAIN_FOUNDATION_POLICY, areaMocPath } from "../src/foundation/policy.js";
import { OrganizerService } from "../src/organizer/service.js";
import { OrganizerStore } from "../src/organizer/store.js";
import { OrganizerTransactionEngine } from "../src/organizer/transaction.js";
import type { OrganizerConfig, ProposalDraft } from "../src/organizer/types.js";
import type { OrganizerContext, OrganizerProvider } from "../src/organizer/provider.js";
import { VaultRegistry } from "../src/vault-registry.js";

const roots: string[] = [];
const stores: OrganizerStore[] = [];
const now = "2026-09-04T12:00:00.000Z";
const markers = "<!-- brain-auto:start note-index -->\n<!-- brain-auto:end note-index -->\n";

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("timed out waiting for organizer run");
}

class FakeProvider implements OrganizerProvider {
  calls: OrganizerContext[] = [];
  draft: ProposalDraft = {
    targetDirectory: "20_Study/22_RL", title: "Markov decision processes", type: "study", status: "active",
    tags: ["rl"], summary: "Sequential decisions.", relatedNotePaths: [], confidence: 0.91, reason: "Study note.",
  };
  wait?: Promise<void>;
  async propose(context: OrganizerContext): Promise<ProposalDraft> {
    this.calls.push(context);
    await this.wait;
    return this.draft;
  }
}

type ReportPublicationEvent = "after_parent_bound" | "after_content_write" | "before_cleanup";

async function fixture(content = "# Inbox\n\nordinary note"): Promise<{ root: string; source: string; service: (provider?: OrganizerProvider | ((options: { maxContextBytes: number }) => OrganizerProvider), config?: Partial<OrganizerConfig>, timestamp?: string, onBeforeReportOpen?: () => void | Promise<void>, onReportPublicationEvent?: (event: ReportPublicationEvent) => void | Promise<void>) => OrganizerService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-service-"));
  roots.push(root);
  const source = path.join(root, "Agent-Inbox", "note.md");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, content, "utf8");
  await utimes(source, new Date(Date.parse(now) - 600_000), new Date(Date.parse(now) - 600_000));
  for (const area of BRAIN_FOUNDATION_POLICY.areas) {
    await mkdir(path.join(root, area.directory), { recursive: true });
    await writeFile(path.join(root, areaMocPath(area)), `# ${area.slug}\n\n${markers}`, "utf8");
  }
  await mkdir(path.join(root, "20_Study", "22_RL"), { recursive: true });
  const registry = await VaultRegistry.create([{ id: "brain", root }]);
  const store = new OrganizerStore(path.join(root, "organizer.sqlite"));
  stores.push(store);
  const base: OrganizerConfig = {
    enabledVaults: ["brain"], mode: "automatic", minStableSeconds: 300, autoApplyConfidence: 0.9,
    maxNotesPerRun: 20, maxNoteBytes: 131_072, maxContextBytes: 262_144, proposalTtlHours: 24,
    recoveryDays: 30, reportsDirectory: "60_Tools/61_Obsidian_MCP/90_Auto_Organizer_Reports",
  };
  return {
    root, source,
    service: (provider, config = {}, timestamp = now, onBeforeReportOpen, onReportPublicationEvent) => new OrganizerService({
      registry, store, config: { ...base, ...config }, provider,
      transaction: new OrganizerTransactionEngine({ store, recoveryRoot: path.join(path.dirname(root), `${path.basename(root)}-recovery`), now: () => timestamp }),
      now: () => timestamp, lockPath: path.join(root, "organizer.lock"), onBeforeReportOpen, onReportPublicationEvent,
    }),
  };
}

afterEach(async () => { stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("OrganizerService", () => {
  it("returns a safe unavailable run without constructing or calling a disabled provider", async () => {
    const fx = await fixture();
    const provider = new FakeProvider();
    let constructed = 0;
    const summary = await fx.service(() => { constructed += 1; return provider; }, { mode: "disabled" }).runToCompletion({ vault: "brain" });
    expect(summary).toMatchObject({ mode: "disabled", status: "complete" });
    expect(constructed).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("skips secret-bearing sources before provider invocation", async () => {
    const fx = await fixture("password: synthetic-not-a-real-secret");
    const provider = new FakeProvider();
    let constructed = 0;
    const summary = await fx.service(() => { constructed += 1; return provider; }).runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    expect(summary.skipped).toBe(1);
    expect(constructed).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("stores a dry-run proposal and report without changing the source", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); const original = await readFile(fx.source, "utf8");
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    expect(summary).toMatchObject({ mode: "dry-run", proposed: 1, applied: 0, status: "complete" });
    expect(await readFile(fx.source, "utf8")).toBe(original);
    const reports = await fx.service(provider).listReportPaths("brain");
    expect(reports).toHaveLength(1);
  });

  it("clamps automatic runs to dry-run during the seven-day trial", async () => {
    const fx = await fixture(); const provider = new FakeProvider();
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "automatic" });
    expect(summary.mode).toBe("dry-run");
    expect(summary.proposed).toBe(1);
  });

  it.each([[0.7, "review"], [0.699, "skipped"]] as const)("counts confidence %s during a trial-clamped dry-run", async (confidence, field) => {
    const fx = await fixture(); const provider = new FakeProvider(); provider.draft.confidence = confidence;
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "automatic" });
    expect(summary).toMatchObject({ mode: "dry-run", [field]: 1 });
    await expect(readFile(fx.source, "utf8")).resolves.toContain("Inbox");
  });

  it("applies confidence of 0.90 and above after the trial", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); provider.draft.confidence = 0.9;
    await fx.service(provider, {}, "2026-08-20T00:00:00.000Z").runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "automatic" });
    expect(summary).toMatchObject({ mode: "automatic", applied: 1, status: "complete" });
  });

  it.each([[0.7, "review"], [0.699, "skipped"]] as const)("keeps lower confidence %s sources in place", async (confidence, field) => {
    const fx = await fixture(); const provider = new FakeProvider(); provider.draft.confidence = confidence;
    await fx.service(provider, {}, "2026-08-20T00:00:00.000Z").runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "automatic" });
    expect(summary[field]).toBe(1);
    await expect(readFile(fx.source, "utf8")).resolves.toContain("Inbox");
  });

  it("rejects provider targets outside existing approved directories", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); provider.draft.targetDirectory = "99_Archive/missing";
    await expect(fx.service(provider).propose({ vault: "brain", path: "Agent-Inbox/note.md" })).rejects.toThrow(/destination does not exist/i);
  });

  it("honors max notes and context-byte limits", async () => {
    const fx = await fixture(); await writeFile(path.join(fx.root, "Agent-Inbox", "two.md"), "two", "utf8");
    await utimes(path.join(fx.root, "Agent-Inbox", "two.md"), new Date(Date.parse(now) - 600_000), new Date(Date.parse(now) - 600_000));
    const provider = new FakeProvider();
    const summary = await fx.service(provider, { maxNotesPerRun: 1, maxContextBytes: 512 }).runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    expect(summary.discovered).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(provider.calls[0]), "utf8")).toBeLessThanOrEqual(512);
  });

  it("passes configured context bytes into a lazy provider factory", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); let received: number | undefined;
    await fx.service((options) => { received = options.maxContextBytes; return provider; }, { maxContextBytes: 512 })
      .runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    expect(received).toBe(512);
    expect(Buffer.byteLength(JSON.stringify(provider.calls[0]), "utf8")).toBeLessThanOrEqual(512);
  });

  it("bounds provider context paths and directories to the provider schema limits", async () => {
    const fx = await fixture(); const old = new Date(Date.parse(now) - 600_000);
    for (let index = 0; index < 520; index += 1) await writeFile(path.join(fx.root, "20_Study", "22_RL", `reference-${index}.md`), "reference", "utf8");
    for (let index = 0; index < 270; index += 1) await mkdir(path.join(fx.root, "20_Study", `topic-${index}`), { recursive: true });
    const provider = new FakeProvider();
    await fx.service(provider, { maxContextBytes: 262_144 }).runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    expect(provider.calls[0]?.candidateNotes.length).toBeLessThanOrEqual(512);
    expect(provider.calls[0]?.approvedDirectories.length).toBeLessThanOrEqual(256);
  });

  it("continues after a failed note", async () => {
    const fx = await fixture(); await writeFile(path.join(fx.root, "Agent-Inbox", "two.md"), "two", "utf8");
    await utimes(path.join(fx.root, "Agent-Inbox", "two.md"), new Date(Date.parse(now) - 600_000), new Date(Date.parse(now) - 600_000));
    const provider = new FakeProvider(); let count = 0; provider.propose = async (context) => { provider.calls.push(context); if (count++ === 0) throw new Error("synthetic provider failure"); return provider.draft; };
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    expect(summary).toMatchObject({ failed: 1, proposed: 1 });
  });

  it("is idempotent after an applied source and proposal", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); const service = fx.service(provider);
    await fx.service(provider, {}, "2026-08-20T00:00:00.000Z").runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    await service.runToCompletion({ vault: "brain", requestedMode: "automatic" });
    const again = await service.runToCompletion({ vault: "brain", requestedMode: "automatic" });
    expect(again.discovered).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });

  it("returns immediately while a run is active and rejects a simultaneous start", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); let resolve!: () => void; provider.wait = new Promise<void>((done) => { resolve = done; });
    const service = fx.service(provider);
    const first = await service.startRun({ vault: "brain", requestedMode: "dry-run" });
    const second = await service.startRun({ vault: "brain", requestedMode: "dry-run" });
    await new Promise((done) => setTimeout(done, 25));
    expect(first.status).toBe("running");
    expect(second.status).toBe("already_running");
    resolve();
    await waitFor(() => provider.calls.length === 1);
    await waitFor(async () => (await readFile(path.join(fx.root, "60_Tools", "61_Obsidian_MCP", "90_Auto_Organizer_Reports", `${first.runId}.json`), "utf8").catch(() => undefined)) !== undefined);
    await waitFor(async () => (await lstat(path.join(fx.root, "organizer.lock")).catch(() => undefined)) === undefined);
  });

  it("reports already_running for a second service blocked by the filesystem lock", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); let resolve!: () => void; provider.wait = new Promise<void>((done) => { resolve = done; });
    const firstService = fx.service(provider); const secondService = fx.service(new FakeProvider());
    const first = await firstService.startRun({ vault: "brain", requestedMode: "dry-run" });
    await new Promise((done) => setTimeout(done, 25));
    const second = await secondService.startRun({ vault: "brain", requestedMode: "dry-run" });
    expect(first.status).toBe("running");
    expect(second.status).toBe("already_running");
    resolve();
    await waitFor(() => provider.calls.length === 1);
    await waitFor(async () => (await readFile(path.join(fx.root, "60_Tools", "61_Obsidian_MCP", "90_Auto_Organizer_Reports", `${first.runId}.json`), "utf8").catch(() => undefined)) !== undefined);
    await waitFor(async () => (await lstat(path.join(fx.root, "organizer.lock")).catch(() => undefined)) === undefined);
  });

  it("writes per-note report paths and stable codes without provider error text", async () => {
    const fx = await fixture(); const provider = new FakeProvider(); provider.draft.confidence = 0.7;
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "automatic" });
    const report = JSON.parse(await readFile(path.join(fx.root, "60_Tools", "61_Obsidian_MCP", "90_Auto_Organizer_Reports", `${summary.runId}.json`), "utf8"));
    expect(report.paths).toEqual([{ path: "Agent-Inbox/note.md", reasonCode: "review" }]);
    expect(report.reasonCodes).toEqual(["review"]);
    expect(JSON.stringify(report)).not.toContain("Sequential decisions");
  });

  it("maps identifier-shaped provider errors to a fixed report code", async () => {
    const fx = await fixture(); const provider = new FakeProvider();
    provider.propose = async () => { throw new Error("customer_secret_abc"); };
    const summary = await fx.service(provider).runToCompletion({ vault: "brain", requestedMode: "dry-run" });
    const text = await readFile(path.join(fx.root, "60_Tools", "61_Obsidian_MCP", "90_Auto_Organizer_Reports", `${summary.runId}.json`), "utf8");
    expect(text).toContain("processing_failed");
    expect(text).not.toContain("customer_secret_abc");
  });

  it("refuses an approved-directory symlink that escapes the vault", async () => {
    const fx = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-outside-")); roots.push(outside);
    await mkdir(path.join(outside, "escaped"));
    await rm(path.join(fx.root, "20_Study"), { recursive: true, force: true });
    try { await symlink(outside, path.join(fx.root, "20_Study"), "junction"); } catch { return; }
    const provider = new FakeProvider(); provider.draft.targetDirectory = "20_Study/escaped";
    await expect(fx.service(provider).propose({ vault: "brain", path: "Agent-Inbox/note.md" })).rejects.toThrow();
  });

  it("does not publish reports through a symlinked report parent", async () => {
    const fx = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-report-outside-")); roots.push(outside);
    await rm(path.join(fx.root, "60_Tools"), { recursive: true, force: true });
    try { await symlink(outside, path.join(fx.root, "60_Tools"), "junction"); } catch { return; }
    const summary = await fx.service(undefined, { mode: "disabled" }).runToCompletion({ vault: "brain" });
    expect(summary.status).toBe("failed");
    expect(await readFile(path.join(outside, "61_Obsidian_MCP", "90_Auto_Organizer_Reports", `${summary.runId}.json`), "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("removes and fails closed on a report parent replaced after binding", async () => {
    const fx = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-report-race-")); roots.push(outside);
    await mkdir(path.join(outside, "61_Obsidian_MCP", "90_Auto_Organizer_Reports"), { recursive: true });
    const summary = await fx.service(undefined, { mode: "disabled" }, now, async () => {
      await rm(path.join(fx.root, "60_Tools"), { recursive: true, force: true });
      await symlink(outside, path.join(fx.root, "60_Tools"), "junction");
    }).runToCompletion({ vault: "brain" });
    expect(summary.status).toBe("failed");
    expect(await readFile(path.join(outside, "61_Obsidian_MCP", "90_Auto_Organizer_Reports", `${summary.runId}.json`), "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("fails before publishing a final report when the bound parent is swapped after the last check", async () => {
    const fx = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-report-final-race-")); roots.push(outside);
    const reportDirectory = path.join(fx.root, "60_Tools", "61_Obsidian_MCP", "90_Auto_Organizer_Reports");
    const heldDirectory = `${reportDirectory}-held`;
    let finalNameObserved = false;
    const summary = await fx.service(undefined, { mode: "disabled" }, now, undefined, async (event) => {
      if (event === "after_parent_bound") {
        await rename(reportDirectory, heldDirectory);
        await symlink(outside, reportDirectory, "junction");
      } else {
        finalNameObserved = (await readdir(outside)).some((name) => name.endsWith(".json"));
      }
    }).runToCompletion({ vault: "brain" });

    expect(summary.status).toBe("failed");
    expect(finalNameObserved).toBe(false);
    expect((await readdir(outside)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("cleans the exact untrusted temporary object when its parent path is swapped before cleanup", async () => {
    const fx = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "brain-organizer-report-cleanup-race-")); roots.push(outside);
    const reportDirectory = path.join(fx.root, "60_Tools", "61_Obsidian_MCP", "90_Auto_Organizer_Reports");
    const heldDirectory = `${reportDirectory}-held`;
    let cleanupObserved = false;
    const summary = await fx.service(undefined, { mode: "disabled" }, now, undefined, async (event) => {
      if (event === "after_parent_bound") {
        await rename(reportDirectory, heldDirectory);
        await symlink(outside, reportDirectory, "junction");
      } else {
        cleanupObserved = true;
        await unlink(reportDirectory);
        await rename(heldDirectory, reportDirectory);
      }
    }).runToCompletion({ vault: "brain" });

    expect(cleanupObserved).toBe(true);
    expect(summary.status).toBe("failed");
    expect(await readdir(outside)).toEqual([]);
  });
});
