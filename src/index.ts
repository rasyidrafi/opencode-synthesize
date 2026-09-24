import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "synthesize",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "synthesize",
        description: "Get independent opinions from configured worker models on a prompt in parallel. Use this when multiple perspectives would help evaluate an approach or decision. Returns structured opinions for the calling agent to synthesize.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string" },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        execute: async (_input) => ({ content: "Synthesize is not implemented yet." }),
      })
    })
  },
})
