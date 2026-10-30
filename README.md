# hermes-harness

Search repository history for recurring fixes and failure patterns.

```sh
npm install -g hermes-harness
HARNESS_REPOS="$PWD" hermes-harness mine-git
hermes-harness repo-query "build fails on CI"
```

Run the example from inside a local Git repository. `mine-git` builds the local model that `repo-query` searches. Requires Bun. Set `HARNESS_REPOS` to one or more local repository paths, separated by your platform's path separator. Set `HARNESS_TICKET_DIRS` for ticket sources and `HARNESS_DATA_DIR` to choose where generated data is stored. Set `HARNESS_GITHUB_REPOS` to a comma-separated list of `owner/repo` values to enable issue scanning.

Queries use local data. Review generated results before sharing; they can contain repository names, commit text, or local paths.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance. Licensed under MIT.
