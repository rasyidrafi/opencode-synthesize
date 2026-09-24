export function workerPrompt(prompt: string): string {
  return `Answer the request in Markdown. Structure the response with relevant sections:
## Conclusion
Give a direct, concrete answer.
## Analysis
Explain the reasoning and important trade-offs.
## Evidence
Include observations, examples, or checks; distinguish verified facts from assumptions.
## Risks and Uncertainty
Identify limitations, failure modes, and unknowns.
## Recommendation
State the recommended approach and practical next steps.

Omit sections that do not apply rather than filling them with boilerplate.

<request>
${prompt}
</request>`
}
