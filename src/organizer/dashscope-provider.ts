import { z } from "zod";
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
const FIXED_RETRY_DELAY_MS = 25;
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_OUTPUT_TOKENS = 2_048;
const RESPONSE_CLEANUP_TIMEOUT_MS = 250;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type OrganizerEnvironment = ReturnType<typeof loadOrganizerEnvironment>;

export interface DashScopeProviderOptions {
  maxContextBytes?: number;
  maxResponseBytes?: number;
}

const optionsSchema = z.object({
  maxContextBytes: z.number().int().min(1).max(1_048_576).default(262_144),
  maxResponseBytes: z.number().int().min(1).max(262_144).default(262_144),
}).strict();

function retryDelay(response: Response, attempt: number): Promise<void> {
  const retryAfter = response.headers.get("Retry-After");
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  const delayMs = seconds !== undefined && seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS
    ? seconds * 1_000
    // Fixed bounded backoff is intentional: no random jitter is used in this single-worker adapter.
    : FIXED_RETRY_DELAY_MS * (attempt + 1);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, delayMs);
  });
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, requestSignal: AbortSignal): Promise<void> {
  if (!body) return;
  const cleanupSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(RESPONSE_CLEANUP_TIMEOUT_MS)]);
  try {
    await awaitWithAbort(body.cancel(), cleanupSignal);
  } catch {
    if (cleanupSignal.aborted) throw new Error("Organizer provider request timed out");
    // The body is already unusable; no content is surfaced from this cleanup path.
  }
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return awaitWithAbort(reader.read(), signal);
}

async function readResponseText(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("Organizer provider returned invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Organizer provider response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      throw new Error("Organizer provider request timed out");
    }
    if (error instanceof Error && error.message === "Organizer provider response is too large") throw error;
    throw new Error("Organizer provider returned invalid response");
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
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
  private readonly options: Required<DashScopeProviderOptions>;

  public constructor(
    private readonly environment: OrganizerEnvironment,
    options: DashScopeProviderOptions = {},
  ) {
    const parsedOptions = optionsSchema.safeParse(options);
    if (!parsedOptions.success) throw new Error("Organizer provider invalid options");
    this.options = parsedOptions.data;
  }

  public async propose(context: OrganizerContext): Promise<ProposalDraft> {
    if (this.environment.provider !== "dashscope") {
      throw new Error("DashScope provider is not configured");
    }

    const body = JSON.stringify({
      model: this.environment.model,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: buildProviderMessages(context),
    });
    if (Buffer.byteLength(body, "utf8") > this.options.maxContextBytes) {
      throw new Error("Organizer provider context is too large");
    }

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
        if (timeoutSignal.aborted) {
          throw new Error("Organizer provider request timed out");
        }
        throw new Error("Organizer provider request failed");
      }

      if (!response.ok) {
        const retry = RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES;
        await cancelBody(response.body, timeoutSignal);
        if (retry) {
          await retryDelay(response, attempt);
          continue;
        }
        throw new Error(`Organizer provider request failed with status ${response.status}`);
      }

      const responseText = await readResponseText(response, timeoutSignal, this.options.maxResponseBytes);
      let responsePayload: unknown;
      try {
        responsePayload = JSON.parse(responseText);
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
