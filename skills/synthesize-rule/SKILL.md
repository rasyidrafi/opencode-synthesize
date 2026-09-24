---
name: synthesize-rule
description: Use when the main agent delegates repository work in phases and needs read-only synthesis of independent opinions to review each phase before proceeding.
---

# Synthesize Rule

## Who this is for

- **Main agent:** follow the workflow below.
- **Synthesizer agent:** follow your system instructions instead of this skill. Do not run this delegation workflow.
- **Any other agent:** ignore this skill.

## Core Workflow (main agent only)

Split delegated implementation work into clear, coherent phases or slices.

For each phase/slice:

```text
General (implementation)
  ↓
Synthesizer (read-only review)
  ↓
Confirmed in-scope findings?
  ├─ No  → Phase/Slice complete
  └─ Yes
       ↓
     General (same session)
       ↓
     Synthesizer (same session)
       ↓
     repeat
```

## Context Boundary

**Never assume a subagent knows what the main agent knows.** A new General or Synthesizer session has no access to the main agent's reasoning, earlier conversations, decisions, repository findings, or hidden assumptions unless these are included in its prompt.

Every new delegation MUST use a self-contained prompt. Include, when relevant:

```text
- Objective / desired outcome and the current phase or slice.
- Relevant repository paths, files, symbols, and existing behavior.
- Required behavior, constraints, and architectural decisions.
- Dependencies, acceptance criteria, and verification performed or required.
```

Do not use "implement as discussed" or "review the changes" without supplying the necessary context. In a continued session, refer to earlier context only when that context actually exists there.

## Session Rules

- One dedicated **General session** and one dedicated **Synthesizer session** per phase/slice.
- Reuse both session IDs for every fix/review iteration in that phase. Do not start a new session for every review.
- Start a new General + Synthesizer pair for a new phase/slice; never reuse either session across different phases.

```text
Same phase/slice = same General session + same Synthesizer session
```

When continuing General, provide confirmed findings, required fixes, and the verification to perform. When continuing Synthesizer, explain what changed and ask it to verify prior findings, identify any new confirmed in-scope issues, and check the required behavior. Give the new intent explicitly even though the session retains its prior context.

## Responsibilities

- **General:** implement, fix, refactor, edit files, and run necessary checks.
- **Synthesizer:** read-only review, critique, comparison, risk analysis, and recommendations. It may call `synthesize` for independent perspectives; it must evaluate and reconcile them itself. It must not edit files or run state-changing commands.
- After General finishes a phase, Synthesizer review is mandatory. Send actionable findings to the existing General session, then return the changed phase to the existing Synthesizer session. Repeat until no confirmed in-scope findings remain.

Keep confirmed in-scope issues separate from verification gaps, pre-existing or unrelated problems, and hypothetical concerns. Only actionable confirmed in-scope issues go back to General.

A phase is complete when its implementation and verification are done, Synthesizer has passed the phase, and no confirmed in-scope findings remain.
