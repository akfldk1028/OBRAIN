import { describe, expect, it, vi } from "vitest";
import { cleanupFailedRuntimeConstruction } from "../src/runtime.js";

describe("runtime construction cleanup", () => {
  it("closes knowledge even when organizer-store close throws and aggregates every failure", async () => {
    const primary = new Error("construction failed");
    const storeFailure = new Error("store close failed");
    const knowledgeFailure = new Error("knowledge close failed");
    const store = { close: vi.fn(() => { throw storeFailure; }) };
    const knowledge = { close: vi.fn(async () => { throw knowledgeFailure; }) };

    const rejected = cleanupFailedRuntimeConstruction(primary, { store, knowledge });

    await expect(rejected).rejects.toBeInstanceOf(AggregateError);
    const aggregate = await rejected.catch((error: unknown) => error) as AggregateError;
    expect(aggregate.errors).toEqual([primary, storeFailure, knowledgeFailure]);
    expect(store.close).toHaveBeenCalledOnce();
    expect(knowledge.close).toHaveBeenCalledOnce();
  });
});
