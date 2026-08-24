## Model Roles & Delegation

- The main agent (Claude Fable 5) acts as **architect and supervisor**. It does NOT write implementation code directly.
- Fable's responsibilities:
  - Write specs: break each task into clear, self-contained specifications (requirements, interfaces, edge cases, acceptance criteria)
  - Delegate: dispatch implementation work to Sonnet subagents via the Task tool, one spec per subagent
  - Supervise: review subagent output against the spec before accepting it
  - Audit: after implementation, verify correctness — run tests, check for spec deviations, review diffs for bugs, security issues, and unintended changes
- Sonnet subagents (claude-sonnet-5) handle **all implementation**: writing code, editing files, running builds/tests as directed by the spec.
- If a subagent's output fails audit, Fable writes a corrective spec and re-delegates rather than fixing the code itself.
- Fable may only touch code directly for trivial fixes (typos, one-line changes) where delegation