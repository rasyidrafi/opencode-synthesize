import { Plugin } from "@opencode/plugin"
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import { workerPrompt } from "./prompt.js"

type Worker = { id: string; model: string; variant?: string }
type WorkerResult =
  | { worker: Worker; ok: true; output: string; sessionID: string }
  | { worker: Worker; ok: false; error: string; sessionID?: string }

/** Broad deny first (OpenCode is last-match-wins) also prevents synthesize recursion. */
export const WORKER_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "skill", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "allow" },
] as const

export function parseWorkers(options: unknown): Worker[] | string {
  if (!isRecord(options) || !Array.isArray(options.workers) || options.workers.length === 0) {
    return "options.workers must be a non-empty array"
  }
  const ids = new Set<string>()
  return options.workers.map((value, index) => {
    if (!isRecord(value)) throw new Error(`options.workers[${index}] must be an object`)
    const id = value.id === undefined ? `worker-${index + 1}` : value.id
    if (typeof id !== "string" || !id.trim()) throw new Error(`options.workers[${index}].id must be a non-empty string`)
    if (ids.has(id)) throw new Error(`options.workers contains duplicate id ${JSON.stringify(id)}`)
    ids.add(id)
    if (typeof value.model !== "string" || !isModelReference(value.model)) {
      throw new Error(`options.workers[${index}].model must be provider/model`)
    }
    if (value.variant !== undefined && (typeof value.variant !== "string" || !value.variant.trim())) {
      throw new Error(`options.workers[${index}].variant must be a non-empty string when provided`)
    }
    return { id, model: value.model, ...(value.variant === undefined ? {} : { variant: value.variant }) }
  })
}

export default Plugin.define({
  id: "synthesize",
  async setup(ctx) {
    let workers: Worker[] | string
    try {
      workers = parseWorkers(ctx.options)
    } catch (error) {
      workers = errorMessage(error)
    }
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "synthesize",
        description:
          "Ask configured worker models for independent opinions in parallel. Workers may inspect and change the project with shell, read, skills, and external-directory access. Returns all successful opinions and any worker failures.",
        input: {
          type: "object",
          properties: { prompt: { type: "string", minLength: 1 } },
          required: ["prompt"],
          additionalProperties: false,
        },
        execute: async (input, toolContext) => {
          const prompt = isRecord(input) && typeof input.prompt === "string" ? input.prompt : ""
          if (!prompt.trim()) return configurationResult("prompt must be a non-empty string")
          if (typeof workers === "string") return configurationResult(workers)

          const location = await invocationLocation(ctx, toolContext.sessionID, toolContext.signal)
          if (!location) {
            return configurationResult("could not determine the invoking session location; no worker sessions were created")
          }
          return formatResult(
            await Promise.all(workers.map((worker) => runWorker(ctx, worker, prompt, location, toolContext.signal))),
            workers,
          )
        },
      })
    })
  },
})

async function invocationLocation(ctx: PluginContext, sessionID: string, signal: AbortSignal) {
  try {
    const location = (await ctx.session.get({ sessionID }, { signal })).location
    return location && typeof location.directory === "string" ? location : undefined
  } catch {
    // Never fall back to the plugin checkout: workers can mutate through shell.
    return undefined
  }
}

async function runWorker(
  ctx: PluginContext,
  worker: Worker,
  prompt: string,
  location: { directory: string },
  signal: AbortSignal,
): Promise<WorkerResult> {
  if (signal.aborted) return failure(worker, "cancelled")
  let sessionID: string | undefined
  let cancel: (() => void) | undefined
  try {
    // Do not abort creation: if the server creates a session just as the caller cancels,
    // retaining its ID lets us interrupt it below rather than orphaning active work.
    const session = await ctx.session.create({
      title: `synthesize: ${worker.id}`,
      agent: "general",
      model: toModelRef(worker),
      location,
      permissions: WORKER_PERMISSIONS,
    })
    const createdSessionID = session.id
    sessionID = createdSessionID
    cancel = () => {
      // Do not pass the already-aborted signal; current V2 calls the no-resume flag `resume`.
      void ctx.session.interrupt({ sessionID: createdSessionID, resume: false }).catch(() => undefined)
    }
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()

    // Prompt admission is durable. Do not abort this request: an abort can race with
    // admission, in which case the first interrupt is an idle no-op. Once admission
    // returns, send a second interrupt if necessary.
    await ctx.session.prompt({ sessionID: createdSessionID, text: workerPrompt(prompt) })
    if (signal.aborted) {
      cancel()
      return failure(worker, "cancelled", createdSessionID)
    }
    await ctx.session.wait({ sessionID: createdSessionID }, { signal })
    const [terminalSession, messages] = await Promise.all([
      ctx.session.get({ sessionID: createdSessionID }, { signal }),
      ctx.session.context({ sessionID: createdSessionID }, { signal }),
    ])
    if (signal.aborted) return failure(worker, "cancelled", createdSessionID)
    const terminalError = terminalWorkerError(terminalSession, messages)
    if (terminalError) return failure(worker, terminalError, createdSessionID)
    const output = finalAssistantText(messages)
    if (!output) return failure(worker, "worker completed without assistant text", createdSessionID)
    return { worker, ok: true, output, sessionID: createdSessionID }
  } catch (error) {
    return failure(worker, signal.aborted ? "cancelled" : errorMessage(error), sessionID)
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel)
  }
}

function toModelRef(worker: Worker) {
  const slash = worker.model.indexOf("/")
  return {
    providerID: worker.model.slice(0, slash),
    id: worker.model.slice(slash + 1),
    ...(worker.variant === undefined ? {} : { variant: worker.variant }),
  }
}

function finalAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part): part is Record<string, unknown> => isRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim()
    // This is the final assistant message, even when it contains only reasoning
    // or tool calls. Never fall back to an earlier placeholder response.
    return text || undefined
  }
}

function terminalWorkerError(session: unknown, messages: readonly unknown[]): string | undefined {
  const outcome = sessionOutcome(session) ?? idleOutcome(messages)
  if (outcome !== "succeeded") return `worker ended with ${outcome ?? "unknown"} outcome`

  const assistantError = finalAssistantError(messages)
  return assistantError ? `worker assistant error: ${assistantError}` : undefined
}

function sessionOutcome(session: unknown): string | undefined {
  return isRecord(session) && typeof session.outcome === "string" ? session.outcome : undefined
}

function idleOutcome(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isRecord(message) && message.type === "idle" && typeof message.outcome === "string") return message.outcome
  }
}

function finalAssistantError(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.type !== "assistant") continue
    if (isRecord(message.error) && typeof message.error.message === "string") return message.error.message
    return undefined
  }
}

function formatResult(results: readonly WorkerResult[], workers: readonly Worker[]) {
  const failed = results.filter((result) => !result.ok)
  const redact = (text: string) => redactIdentities(text, workers)
  return {
    content: [
      "# Independent worker opinions",
      ...results.flatMap((result, index) =>
        result.ok
          ? [`\n## ${workerAlias(index)}`, redact(result.output)]
          : [],
      ),
      ...(failed.length ? ["\n## Worker failures", ...results.flatMap((result, index) =>
        result.ok ? [] : [`- ${workerAlias(index)}: ${redact(result.error)}`],
      )] : []),
    ].join("\n"),
    metadata: {
      partial: failed.length > 0,
      workerCount: results.length,
      successfulWorkers: results.length - failed.length,
      workers: results.map((result, index) => ({
        alias: workerAlias(index),
        status: result.ok ? "ok" : "failed",
        ...(result.ok ? {} : { error: redact(result.error) }),
      })),
    },
  }
}

function workerAlias(index: number): string {
  return `Worker ${index + 1}`
}

function redactIdentities(text: string, workers: readonly Worker[]): string {
  const identities = new Set<string>()
  for (const worker of workers) {
    const slash = worker.model.indexOf("/")
    identities.add(worker.model)
    identities.add(worker.model.slice(0, slash))
    identities.add(worker.model.slice(slash + 1))
    if (worker.variant) identities.add(worker.variant)
  }
  const escaped = [...identities].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return text.replace(new RegExp(escaped.join("|"), "gi"), "[redacted]")
}

function configurationResult(error: string) {
  return {
    content: `Synthesize configuration error: ${error}`,
    metadata: { partial: true, workerCount: 0, successfulWorkers: 0, error },
  }
}

function failure(worker: Worker, error: string, sessionID?: string): WorkerResult {
  return { worker, ok: false, error, ...(sessionID === undefined ? {} : { sessionID }) }
}
function isModelReference(value: string) {
  const slash = value.indexOf("/")
  return slash > 0 && slash < value.length - 1
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "unexpected worker error"
}
