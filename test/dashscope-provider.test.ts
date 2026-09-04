import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOrganizerEnvironment } from "../src/organizer/config.js";
import { DashScopeProvider } from "../src/organizer/dashscope-provider.js";

const context = {
  policyVersion: "1.0.0",
  approvedDirectories: ["20_Study/22_RL", "98_DK/98_Unsorted"],
  policyContext: [{ kind: "root_guide" as const, path: "000_AI_WORK_GUIDE.md", summary: "Global policy." }],
  candidateNotes: ["20_Study/22_RL/MDP.md"],
  note: { path: "Agent-Inbox/new.md", content: "A note about reinforcement learning." },
};

const validProposal = {
  targetDirectory: "20_Study/22_RL",
  title: "Markov decision processes",
  type: "study",
  status: "active",
  tags: ["reinforcement-learning"],
  summary: "A framework for sequential decisions.",
  relatedNotePaths: ["20_Study/22_RL/MDP.md"],
  confidence: 0.91,
  reason: "The note discusses reinforcement learning concepts.",
};

const environment = loadOrganizerEnvironment({
  ORGANIZER_PROVIDER: "dashscope",
  DASHSCOPE_API_KEY: "test-only-provider-key",
  DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  DASHSCOPE_MODEL: "qwen-plus",
});

function streamFromText(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });
}

function responseWithJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: streamFromText(JSON.stringify(payload)),
  } as Response;
}

function errorResponse(status: number, cancel = vi.fn(), retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : undefined),
    body: { cancel } as unknown as ReadableStream<Uint8Array>,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DashScopeProvider", () => {
  it("sends the synthetic authorization only with the bounded outbound request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ...responseWithJson({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).resolves.toEqual(validProposal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(request).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer test-only-provider-key", "Content-Type": "application/json" },
    });
    expect(JSON.parse(request.body)).toMatchObject({ model: "qwen-plus", temperature: 0, max_tokens: 2048 });
  });

  it("keeps authorization and response bodies out of deterministic HTTP errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(503));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow(
      "Organizer provider request failed with status 503",
    );

    const error = await new DashScopeProvider(environment).propose(context).catch((reason: unknown) => String(reason));
    expect(error).not.toContain("test-only-provider-key");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("retries only transient HTTP statuses and returns the later valid proposal", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(responseWithJson({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).resolves.toEqual(validProposal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the request on timeout without retaining request credentials in the error", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.fn(async (_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      controller.abort();
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow("Organizer provider request timed out");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("rejects Markdown-fenced JSON instead of salvaging it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseWithJson({ choices: [{ message: { content: "```json\\n{}\\n```" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow("Organizer provider returned invalid JSON");
  });

  it("rejects final serialized requests that exceed the configured context limit before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rawContent = "</untrusted_note>".repeat(50);
    expect(Buffer.byteLength(rawContent, "utf8")).toBeLessThan(2_048);
    const oversizedContext = { ...context, note: { ...context.note, content: rawContent } };

    await expect(new DashScopeProvider(environment, { maxContextBytes: 2_048 }).propose(oversizedContext)).rejects.toThrow(
      "Organizer provider context is too large",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels retryable response bodies before retrying", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(429, cancel))
      .mockResolvedValueOnce(responseWithJson({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).resolves.toEqual(validProposal);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses exactly three attempts for retryable status exhaustion", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(500, cancel));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow(
      "Organizer provider request failed with status 500",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("cancels a non-retryable response body before returning its redacted status", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(400, cancel));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow(
      "Organizer provider request failed with status 400",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns a timeout when terminal response cleanup exceeds its bounded deadline", async () => {
    const requestController = new AbortController();
    const cleanupController = new AbortController();
    vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(requestController.signal)
      .mockReturnValueOnce(cleanupController.signal);
    let cancelStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => { cancelStarted = resolve; });
    const cancel = vi.fn(() => {
      cancelStarted();
      return new Promise<void>(() => undefined);
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(400, cancel)));

    const pending = new DashScopeProvider(environment).propose(context);
    await cancellationStarted;
    cleanupController.abort();

    await expect(pending).rejects.toThrow("Organizer provider request timed out");
  });

  it("does not treat an unrelated AbortError as a provider timeout", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("test-only-provider-key", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow(
      "Organizer provider request failed",
    );
  });

  it.each([
    ["no choices", {}],
    ["non-string first choice", { choices: [{ message: { content: 7 } }] }],
  ])("rejects a %s response shape", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseWithJson(payload)));

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow(
      "Organizer provider returned invalid response",
    );
  });

  it("rejects a successful response without a readable body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: null }));

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow(
      "Organizer provider returned invalid response",
    );
  });

  it("rejects an oversized streamed response before JSON parsing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: streamFromText("x".repeat(65)),
    }));

    await expect(new DashScopeProvider(environment, { maxResponseBytes: 64 }).propose(context)).rejects.toThrow(
      "Organizer provider response is too large",
    );
  });

  it("reports a timeout when aborting during streamed response reading", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let readStarted!: () => void;
    const readingStarted = new Promise<void>((resolve) => { readStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        readStarted();
        return new Promise<void>(() => undefined);
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body }));

    const pending = new DashScopeProvider(environment).propose(context);
    await readingStarted;
    controller.abort();

    await expect(pending).rejects.toThrow("Organizer provider request timed out");
  });
});
