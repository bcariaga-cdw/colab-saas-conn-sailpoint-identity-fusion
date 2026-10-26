---
name: harness-proxy
description: Delegate sub-tasks across AI coding agent harnesses inside isolated Git worktrees.
argument-hint: "run [--agent <name>] '<prompt>'"
disable-model-invocation: true
---

# harness-proxy

Delegate tasks to isolated agent harnesses. The CLI binary autonomously manages task classification, quota balancing, model selection, git worktrees, tier failover, and auto-merging.

## Dispatch Workflow

1. **Match subagent**:
   Check `.agents/agents/*.md` (or `.claude/agents/*.md`). Read each candidate's frontmatter `description`:
   - When a specialized subagent fits the task domain, pass `--agent <name>`.
   - When no specialized subagent matches, omit `--agent`.

2. **Execute directly**:
   Invoke `harness-proxy run` as your immediate action:
   ```bash
   # General task
   harness-proxy run "<task description with clear acceptance criteria>"

   # Domain-specialized task
   harness-proxy run --agent codebase-advisor "<task description with clear acceptance criteria>"
   ```

3. **Report configuration**:
   When reporting to the user, include the dispatch details emitted by `harness-proxy` (the selected harness, model, effort, and tier).
