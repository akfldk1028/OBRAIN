import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOrganizerEnvironment } from "../src/organizer/config.js";
import { DashScopeProvider } from "../src/organizer/dashscope-provider.js";

const context = {
  policyVersion: "1.0.0",
  approvedDirectories: ["20_Study/22_RL", "98_DK/98_Unsorted"],
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DashScopeProvider", () => {
  it("sends the synthetic authorization only with the bounded outbound request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }),
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
    expect(JSON.parse(request.body)).toMatchObject({ model: "qwen-plus", temperature: 0 });
  });

  it("keeps authorization and response bodies out of deterministic HTTP errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "test-only-provider-key" }),
    });
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
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }),
      });
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "```json\\n{}\\n```" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DashScopeProvider(environment).propose(context)).rejects.toThrow("Organizer provider returned invalid JSON");
  });

  it("rejects oversized context before making an HTTP request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oversizedContext = { ...context, note: { ...context.note, content: "x".repeat(262_145) } };

    await expect(new DashScopeProvider(environment).propose(oversizedContext)).rejects.toThrow(
      "Organizer provider context is too large",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
