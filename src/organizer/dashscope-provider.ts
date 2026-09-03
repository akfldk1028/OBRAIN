import type { loadOrganizerEnvironment } from "./config.js";
import {
  buildProviderMessages,
  proposalDraftSchema,
  type OrganizerContext,
  type OrganizerProvider,
} from "./provider.js";
import type { ProposalDraft } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 25;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type OrganizerEnvironment = ReturnType<typeof loadOrganizerEnvironment>;

function retryDelay(attempt: number): Promise<void> {
  const delayMs = RETRY_DELAY_MS * (attempt + 1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, delayMs);
  });
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function proposalContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

export class DashScopeProvider implements OrganizerProvider {
  public constructor(private readonly environment: OrganizerEnvironment) {}

  public async propose(context: OrganizerContext): Promise<ProposalDraft> {
    if (this.environment.provider !== "dashscope") {
      throw new Error("DashScope provider is not configured");
    }

    const messages = buildProviderMessages(context);
    const body = JSON.stringify({
      model: this.environment.model,
      temperature: 0,
      messages,
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(`${this.environment.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.environment.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: timeoutSignal,
        });
      } catch (error) {
        if (isAbortError(error, timeoutSignal)) {
          throw new Error("Organizer provider request timed out");
        }
        throw new Error("Organizer provider request failed");
      }

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          await retryDelay(attempt);
          continue;
        }
        throw new Error(`Organizer provider request failed with status ${response.status}`);
      }

      let responsePayload: unknown;
      try {
        responsePayload = await response.json();
      } catch {
        throw new Error("Organizer provider returned invalid response");
      }

      const content = proposalContent(responsePayload);
      if (content === undefined) {
        throw new Error("Organizer provider returned invalid response");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error("Organizer provider returned invalid JSON");
      }

      try {
        return proposalDraftSchema.parse(parsed);
      } catch {
        throw new Error("Organizer provider returned invalid proposal");
      }
    }

    throw new Error("Organizer provider request failed");
  }
}
