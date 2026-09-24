# opencode-synthesize

An OpenCode V2 plugin exposing a `synthesize` tool. It sends its sole `prompt`
argument to every configured worker model in parallel, then returns each worker's
final assistant response. Worker failures are reported with successful opinions.

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
  ]
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
