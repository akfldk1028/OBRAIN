import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type AuditAction =
  | "create_inbox_note" | "organizer_propose" | "organizer_apply"
  | "organizer_undo" | "organizer_run" | "organizer_audit";

export interface AuditEvent {
  action: AuditAction;
  outcome: "allowed" | "denied";
  vault: string;
  path?: string;
  reason?: string;
}

export class AuditLogger {
  constructor(private readonly file: string) {}

  async record(event: AuditEvent): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const safe = {
      timestamp: new Date().toISOString(),
      action: event.action,
      outcome: event.outcome,
      vault: event.vault,
      path: event.path,
      reason: event.reason?.slice(0, 200),
    };
    await appendFile(this.file, `${JSON.stringify(safe)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
