# Contributing

**The world model gets better every time someone chips in.** You don't need to write code. You can contribute by running the harvester against public repos and sharing the results.

## How to contribute patterns

The easiest way: run `seed-harvest` against repos you care about.

```bash
# Clone this repo
git clone https://github.com/vystartasv/hermes-harness
cd hermes-harness

# Harvest public repos (or point it at your own)
bun run src/seed.ts harvest

# Export the model
bun run src/seed.ts export

# Share the output
# → ~/.hermes-harness/seed-world-model.publish.json
```

Open a PR with your exported model. The maintainer will merge it into the seed.

## What makes a good seed repo

Repos with:
- **500+ commits** (enough history for patterns)
- **Conventional commits** (`fix:`, `feat:`, `revert:`) — clearer signal
- **Active issue/PR lifecycle** — more reverts = more patterns
- **Permissive license** (MIT, Apache, BSD) — for redistribution

Repos to avoid:
- Personal dotfiles, config repos (no lifecycle data)
- Monorepos with auto-merge bots (noise, not signal)
- Private/proprietary code (we can't redistribute)

## How to contribute code

PRs are welcome for:

- **New miners** — Slack channel miner, calendar miner, browser history miner
- **Better embeddings** — improve the 128-dim word-count vectorizer
- **Query UX** — better CLI output, web interface
- **Integrations** — GitHub Actions, VS Code extension, MCP server

## Code structure

```
src/
├── config.ts         # Centralized paths (override via HARNESS_DATA_DIR)
├── harness.ts        # Shared utilities (LLM calls, embeddings)
├── cli.ts            # CLI entry point
├── seed.ts           # Public repo harvester (world creator)
├── world-model.ts    # Model training + prediction
├── repo-query.ts     # Cross-repo search
├── git-miner.ts      # Private git history miner
├── ticket-miner.ts   # ADO ticket lifecycle miner
├── post-session.ts   # Hermes session miner
├── issue-scanner.ts  # GitHub issue scanner
├── pr-creator.ts     # Auto-PR from fixes
└── self-improve.ts   # Full automation loop
```

## License

MIT
