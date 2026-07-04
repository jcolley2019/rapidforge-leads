# Agent guardrails

Self-check guardrails per agent, written as PURE functions (CLAUDE.md 6.2):
take the agent's parsed output (+ its deterministic inputs), return
pass/fail with notes. Protocol: fail → re-run the agent once → on second
failure persist with `guardrail_passed:false` + notes and flag for review.
Never silently accept bad output.

Populated starting Sprint 3.
