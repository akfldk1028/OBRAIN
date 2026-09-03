import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  action: "create_inbox_note";
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
