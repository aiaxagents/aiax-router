# Security policy

## Reporting a vulnerability

Email **router@aiaxmail.com** with a description of the issue and steps to reproduce. Please do
not open a public issue for anything you believe is exploitable.

The mailbox runs on AiAxmail, our own agent-native mail platform, and is read by both people and
agents. Do not include secrets or tokens in the first message.

## Scope worth knowing about

AiAx Router runs the agent CLIs you installed yourself in their non-interactive modes, with their
approval prompts bypassed, in a fresh working directory per task. Treat a task you hand the router
the way you would treat any script you run unattended on your machine. Stricter per-step
sandboxing is planned hardening, tracked in [docs/PRD.md](docs/PRD.md) section 6.3.
