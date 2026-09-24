# opencode-synthesize

OpenCode V2 plugin exposing a placeholder `synthesize` tool.

Add `opencode-synthesize` to the `plugins` array in your `opencode.jsonc` after publishing:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-synthesize"]
}
```

The tool requires one string argument, `prompt`, and currently returns a placeholder message.
