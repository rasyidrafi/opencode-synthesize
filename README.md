# opencode-synthesize

An OpenCode V2 plugin exposing a `synthesize` tool. It sends its sole `prompt`
argument to every configured worker model in parallel, then returns each worker's
final assistant response. Worker failures are reported with successful opinions.
The plugin wraps the request in a Markdown answer format covering conclusion,
analysis, evidence, risks, and recommendation where relevant. It returns each worker's
response as text, without parsing or rewriting its structure.
For repeated calls from the same calling session, each successful worker
continues its prior session with the new prompt. The mapping is stored durably
by the plugin, so the tool still takes only `prompt` and does not expose worker
session IDs. A new calling session gets new workers; changed models/variants,
missing sessions, and failed workers are replaced on the next call. Overlapping
calls from one calling session are queued, while workers within each call run
in parallel.

## Configure

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-synthesize",
      "options": {
        "workers": [
          { "id": "architect", "model": "anthropic/claude-sonnet-4-6" },
          { "id": "skeptic", "model": "openai/gpt-5.2", "variant": "high" }
        ]
      }
    }
  ],
  "agents": {
    "synthesizer": { "mode": "subagent" }
  }
}
```

`workers` is a non-empty array. `id` is optional (default: `worker-<number>`),
and `model` must be `provider/model`. Array length is the parallel worker count.
The V2 model catalog is advisory because its snapshot can predate provider
settlement. Models and variants are sent to `session.create` for authoritative
server resolution and are reported as that worker's error if unavailable.

Tool output uses neutral labels (`Worker 1`, `Worker 2`, …) instead of configured
IDs, model names, or variants. Configured model and variant identifiers are
redacted from worker responses and errors, including tool metadata, before the
calling agent sees them. The actual worker sessions still retain their model
selection in OpenCode.

For local testing, set `package` to this repository's absolute directory path
instead of `opencode-synthesize`. The root `index.ts` entrypoint supports V2's
local-directory plugin loader; the published package exports `src/index.ts`.
If the calling agent uses deny-all permissions, it also needs permission to
invoke `synthesize`; worker permissions do not grant access to the caller.
When an agent named `synthesizer` exists, the plugin updates it on load: it
sets its mode to `subagent`, provides a read-only use-when description,
keeps any existing system instructions, adds read-only synthesis guidance, and
sets deny-all permissions with only `shell`, `read`, `skill`,
`external_directory`, and `synthesize` allowed. If that agent is absent, the
plugin leaves agents unchanged. The tool remains registered globally; other
agents' existing permissions still determine whether they can call it.

The plugin also registers the `synthesize-rule` skill from
`skills/synthesize-rule/SKILL.md` in OpenCode's skill catalog. For the main
agent, it mirrors the General → review → fix loop using `synthesizer` for
read-only review and reusing the same subagent sessions within each phase.
For `synthesizer`, it defers to the agent's system instructions; other agents
ignore the skill. This is a
runtime registration; it does not copy files into the user's global config.

## Worker access and limits

Each worker is a separate `general` session at the invoking session's location.
If that location cannot be read, the tool fails without creating workers rather
than risk running shell commands in the plugin checkout.
Its permissions are ordered: deny all, then allow `shell`, `read`, `skill`, and
`external_directory` for `*`. Shell access therefore intentionally permits
mutations. `grep`, `glob`, and `synthesize` are not allowed, preventing worker
recursion.

On cancellation, worker sessions are interrupted without resuming queued work.
The plugin waits for queued prompts to finish and reads final assistant text from
session context; it does not use transient generation. Worker sessions remain in
OpenCode and may modify the project through their permitted shell access.
