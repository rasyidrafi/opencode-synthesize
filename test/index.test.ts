import { describe, expect, it, vi } from "vitest"
import plugin, { WORKER_PERMISSIONS } from "../src/index.js"

type CapturedTool = { execute: (input: unknown, context: unknown) => Promise<any> }

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function install(options: unknown, overrides: Record<string, unknown> = {}) {
  let captured: CapturedTool | undefined
  let sequence = 0
  const context = {
    options,
    location: { directory: "/plugin-location" },
    tool: {
      transform: async (callback: (editor: { add(tool: CapturedTool): void }) => void) => {
        callback({ add: (tool) => (captured = tool) })
      },
    },
    model: {
      list: vi.fn(async () => ({ data: [{ providerID: "alpha", id: "one", variants: [{ id: "fast" }] }] })),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) =>
        sessionID === "ses-parent" ? { location: { directory: "/calling-project" } } : { outcome: "succeeded" },
      ),
      create: vi.fn(async () => ({ id: `ses-worker-${++sequence}` })),
      prompt: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
      context: vi.fn(async ({ sessionID }: { sessionID: string }) => [
        { type: "assistant", content: [{ type: "text", text: `opinion from ${sessionID}` }] },
        { type: "idle", outcome: "succeeded" },
      ]),
      interrupt: vi.fn(async () => undefined),
    },
    ...overrides,
  }
  await plugin.setup(context as never)
  if (!captured) throw new Error("synthesize tool was not registered")
  return { tool: captured, context }
}

function toolContext(signal = new AbortController().signal) {
  return { sessionID: "ses-parent", signal }
}

describe("synthesize", () => {
  it("runs every worker in parallel with its model, variant, invoking location, and exact permissions", async () => {
    const waits: Array<ReturnType<typeof deferred<void>>> = []
    const { tool, context } = await install(
      {
        workers: [
          { id: "first", model: "alpha/one", variant: "fast" },
          { id: "second", model: "alpha/one" },
        ],
      },
      {
        session: {
          get: vi.fn(async ({ sessionID }: { sessionID: string }) =>
            sessionID === "ses-parent" ? { location: { directory: "/calling-project" } } : { outcome: "succeeded" },
          ),
          create: vi.fn(async ({ title }: { title: string }) => ({ id: `ses-${title.replace("synthesize: ", "")}` })),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => {
            const gate = deferred()
            waits.push(gate)
            return gate.promise
          }),
          context: vi.fn(async ({ sessionID }: { sessionID: string }) => [
            { type: "assistant", content: [{ type: "text", text: `final ${sessionID}` }] },
            { type: "idle", outcome: "succeeded" },
          ]),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )

    const resultPromise = tool.execute({ prompt: "evaluate this" }, toolContext())
    await vi.waitFor(() => expect(waits).toHaveLength(2))
    expect(context.session.create).toHaveBeenCalledTimes(2)
    expect(context.session.create.mock.calls.map(([input]: any[]) => input)).toEqual([
      {
        title: "synthesize: first",
        agent: "general",
        model: { providerID: "alpha", id: "one", variant: "fast" },
        location: { directory: "/calling-project" },
        permissions: WORKER_PERMISSIONS,
      },
      {
        title: "synthesize: second",
        agent: "general",
        model: { providerID: "alpha", id: "one" },
        location: { directory: "/calling-project" },
        permissions: WORKER_PERMISSIONS,
      },
    ])
    expect(context.session.prompt.mock.calls.map(([input]: any[]) => input.text)).toEqual(["evaluate this", "evaluate this"])

    waits.forEach((gate) => gate.resolve(undefined))
    const result = await resultPromise
    expect(result.content).toContain("final ses-first")
    expect(result.content).toContain("final ses-second")
    expect(result.metadata).toMatchObject({ partial: false, workerCount: 2, successfulWorkers: 2 })
  })

  it("defers models absent from a nonempty catalog to session creation", async () => {
    const { tool, context } = await install(
      { workers: [{ id: "bad", model: "alpha/missing", variant: "slow" }] },
      {
        session: {
          get: vi.fn(async () => ({ location: { directory: "/calling-project" } })),
          create: vi.fn(async () => {
            throw new Error("model is unavailable")
          }),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async () => []),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const result = await tool.execute({ prompt: "review" }, toolContext())
    expect(context.session.create).toHaveBeenCalledTimes(1)
    expect(result.content).toContain("Worker 1: model is unavailable")

    const variant = await install(
      { workers: [{ id: "bad", model: "alpha/one", variant: "slow" }] },
      {
        session: {
          get: vi.fn(async () => ({ location: { directory: "/calling-project" } })),
          create: vi.fn(async () => {
            throw new Error("variant is unavailable")
          }),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async () => []),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const variantResult = await variant.tool.execute({ prompt: "review" }, toolContext())
    expect(variant.context.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: { providerID: "alpha", id: "one", variant: "slow" } }),
    )
    expect(variantResult.content).toContain("Worker 1: variant is unavailable")
  })

  it("refuses to start workers when the invoking session location cannot be read", async () => {
    const { tool, context } = await install(
      { workers: [{ id: "safe", model: "alpha/one" }] },
      {
        session: {
          get: vi.fn(async () => {
            throw new Error("session unavailable")
          }),
          create: vi.fn(async () => ({ id: "ses-should-not-exist" })),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async () => []),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const result = await tool.execute({ prompt: "review" }, toolContext())
    expect(result.content).toContain("could not determine the invoking session location")
    expect(context.session.create).not.toHaveBeenCalled()
    expect(result.content).not.toContain("/plugin-location")
  })

  it("keeps successful opinions when another worker fails", async () => {
    const { tool } = await install(
      { workers: [{ id: "broken", model: "alpha/one" }, { id: "good", model: "alpha/one" }] },
      {
        session: {
          get: vi.fn(async ({ sessionID }: { sessionID: string }) =>
            sessionID === "ses-parent" ? { location: { directory: "/calling-project" } } : { outcome: "succeeded" },
          ),
          create: vi
            .fn()
            .mockResolvedValueOnce({ id: "ses-broken" })
            .mockResolvedValueOnce({ id: "ses-good" }),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "ses-broken") throw new Error("provider unavailable")
          }),
          context: vi.fn(async () => [
            { type: "assistant", content: [{ type: "text", text: "useful opinion" }] },
            { type: "idle", outcome: "succeeded" },
          ]),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const result = await tool.execute({ prompt: "review" }, toolContext())
    expect(result.content).toContain("useful opinion")
    expect(result.content).toContain("Worker 1: provider unavailable")
    expect(result.metadata).toMatchObject({ partial: true, successfulWorkers: 1 })
  })

  it("does not report stale text when the terminal outcome or final assistant has failed", async () => {
    const { tool } = await install(
      { workers: [{ id: "outcome", model: "alpha/one" }, { id: "assistant", model: "alpha/one" }] },
      {
        session: {
          get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "ses-parent") return { location: { directory: "/calling-project" } }
            return { outcome: sessionID === "ses-outcome" ? "failed" : "succeeded" }
          }),
          create: vi
            .fn()
            .mockResolvedValueOnce({ id: "ses-outcome" })
            .mockResolvedValueOnce({ id: "ses-assistant" }),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async ({ sessionID }: { sessionID: string }) =>
            sessionID === "ses-outcome"
              ? [
                  { type: "assistant", content: [{ type: "text", text: "stale outcome text" }] },
                  { type: "idle", outcome: "failed" },
                ]
              : [
                  {
                    type: "assistant",
                    content: [{ type: "text", text: "stale assistant text" }],
                    error: { message: "provider failed after text" },
                  },
                  { type: "idle", outcome: "succeeded" },
                ],
          ),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const result = await tool.execute({ prompt: "review" }, toolContext())
    expect(result.content).toContain("Worker 1: worker ended with failed outcome")
    expect(result.content).toContain("Worker 2: worker assistant error: provider failed after text")
    expect(result.content).not.toContain("stale outcome text")
    expect(result.content).not.toContain("stale assistant text")
    expect(result.metadata).toMatchObject({ partial: true, successfulWorkers: 0 })
  })

  it("does not fall back to an earlier assistant text when the final turn has only reasoning or tools", async () => {
    const { tool } = await install(
      { workers: [{ id: "final", model: "alpha/one" }] },
      {
        session: {
          get: vi.fn(async ({ sessionID }: { sessionID: string }) =>
            sessionID === "ses-parent" ? { location: { directory: "/calling-project" } } : { outcome: "succeeded" },
          ),
          create: vi.fn(async () => ({ id: "ses-final" })),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async () => [
            { type: "assistant", content: [{ type: "text", text: "I'll check that first." }] },
            {
              type: "assistant",
              content: [
                { type: "reasoning", text: "Checking the project." },
                { type: "tool", name: "read", state: { status: "completed" } },
              ],
            },
            { type: "idle", outcome: "succeeded" },
          ]),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const result = await tool.execute({ prompt: "review" }, toolContext())
    expect(result.content).toContain("Worker 1: worker completed without assistant text")
    expect(result.content).not.toContain("I'll check that first.")
    expect(result.metadata).toMatchObject({ partial: true, successfulWorkers: 0 })
  })

  it("interrupts every created worker without resuming when the tool is cancelled", async () => {
    const controller = new AbortController()
    const interrupted: unknown[] = []
    const { tool, context } = await install(
      { workers: [{ id: "one", model: "alpha/one" }, { id: "two", model: "alpha/one" }] },
      {
        session: {
          get: vi.fn(async () => ({ location: { directory: "/calling-project" } })),
          create: vi
            .fn()
            .mockResolvedValueOnce({ id: "ses-one" })
            .mockResolvedValueOnce({ id: "ses-two" }),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn((_input: unknown, requestOptions: { signal: AbortSignal }) =>
            new Promise((_, reject) => requestOptions.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
          ),
          context: vi.fn(async () => []),
          interrupt: vi.fn(async (input: unknown) => interrupted.push(input)),
        },
      },
    )
    const resultPromise = tool.execute({ prompt: "review" }, toolContext(controller.signal))
    await vi.waitFor(() => expect(context.session.wait).toHaveBeenCalledTimes(2))
    controller.abort()
    const result = await resultPromise
    await vi.waitFor(() => expect(interrupted).toEqual([
      { sessionID: "ses-one", resume: false },
      { sessionID: "ses-two", resume: false },
    ]))
    expect(result.metadata).toMatchObject({ partial: true, successfulWorkers: 0 })
    expect(result.content).toContain("Worker 1: cancelled")
    expect(result.content).toContain("Worker 2: cancelled")
  })

  it("interrupts again after a prompt is durably admitted during cancellation", async () => {
    const controller = new AbortController()
    const admitted = deferred<void>()
    const interrupted: unknown[] = []
    const { tool, context } = await install(
      { workers: [{ id: "race", model: "alpha/one" }] },
      {
        session: {
          get: vi.fn(async () => ({ location: { directory: "/calling-project" } })),
          create: vi.fn(async () => ({ id: "ses-race" })),
          prompt: vi.fn(async () => admitted.promise),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async () => []),
          interrupt: vi.fn(async (input: unknown) => interrupted.push(input)),
        },
      },
    )
    const resultPromise = tool.execute({ prompt: "review" }, toolContext(controller.signal))
    await vi.waitFor(() => expect(context.session.prompt).toHaveBeenCalledTimes(1))
    controller.abort()
    await vi.waitFor(() => expect(interrupted).toHaveLength(1))

    admitted.resolve(undefined)
    const result = await resultPromise
    await vi.waitFor(() => expect(interrupted).toEqual([
      { sessionID: "ses-race", resume: false },
      { sessionID: "ses-race", resume: false },
    ]))
    expect(context.session.wait).not.toHaveBeenCalled()
    expect(result.content).toContain("Worker 1: cancelled")
  })

  it("hides configured model identities and variants in opinions, errors, and metadata", async () => {
    const { tool } = await install(
      { workers: [
        { id: "alpha/secret-model", model: "alpha/secret-model", variant: "deep-mode" },
        { id: "deep-mode", model: "competitor/other-model" },
      ] },
      {
        session: {
          get: vi.fn(async ({ sessionID }: { sessionID: string }) =>
            sessionID === "ses-parent" ? { location: { directory: "/calling-project" } } : { outcome: "succeeded" },
          ),
          create: vi.fn().mockResolvedValueOnce({ id: "ses-one" }).mockRejectedValueOnce(
            new Error("competitor/other-model unavailable, try deep-mode"),
          ),
          prompt: vi.fn(async () => undefined),
          wait: vi.fn(async () => undefined),
          context: vi.fn(async () => [
            { type: "assistant", content: [{ type: "text", text: "alpha/secret-model (deep-mode) thinks competitor/other-model differs." }] },
            { type: "idle", outcome: "succeeded" },
          ]),
          interrupt: vi.fn(async () => undefined),
        },
      },
    )
    const result = await tool.execute({ prompt: "review" }, toolContext())
    const visible = JSON.stringify(result)
    for (const identity of ["alpha", "secret-model", "deep-mode", "competitor", "other-model"]) {
      expect(visible).not.toContain(identity)
    }
    expect(result.content).toContain("## Worker 1")
    expect(result.content).toContain("Worker 2: [redacted] unavailable")
    expect(result.metadata.workers).toEqual([
      { alias: "Worker 1", status: "ok" },
      { alias: "Worker 2", status: "failed", error: "[redacted] unavailable, try [redacted]" },
    ])
  })
})
