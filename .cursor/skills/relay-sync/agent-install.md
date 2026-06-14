# Relay agent hooks (automatic)

**Do not follow these manually.** Run:

```bash
relay init
```

That patches all agent files with a `<!-- BEGIN:relay-os -->` block and installs Cursor skill + rule.

Re-apply after Relay upgrade:

```bash
relay install
```

Agents: read `.relay/AGENT_BOOTSTRAP.md` every session.
