# my-pi

Personal [pi](https://pi.dev) extensions.

| Extension | What it does |
|---|---|
| `usage-limits` | Shows subscription usage limits for the active provider in the footer (`limits 5h 42% · W 18%`). Supports `openai-codex`, `claude-code`, and `opencode-go`. `/limits` refreshes and shows reset times. |
| `orchestrator` | Orchestrator mode, on by default: the main model plans and reviews, and a `subagent` model implements. `/orchestrator` opens a picker to disable it or change the subagent model. |
| `herdr-subagent` | A `subagent` tool that runs child pi processes in herdr panes. |

`orchestrator` delegates through a `subagent` tool, such as the one `herdr-subagent` provides.

## Install

Everything:

```bash
pi install git:github.com/Narwhai/my-pi
```

Only some extensions: install the package, then narrow it in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/Narwhai/my-pi",
      "extensions": ["extensions/usage-limits.ts"]
    }
  ]
}
```

Or toggle individual extensions with `pi config`.

## Extension notes

### usage-limits

Status shows only when the active model's provider has a fetcher.

- `openai-codex`: uses pi's stored ChatGPT login.
- `claude-code`: reads the Claude CLI token from `${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json`. It never refreshes the token itself; an expired token shows `limits: claude token expired` until the Claude CLI refreshes it.
- `opencode-go`: uses pi's stored OpenCode Go key.

These are unofficial endpoints and may change.

### orchestrator

- `/orchestrator`: picker to enable or disable the mode, or choose the session subagent model.
- `/orchestrator on | off | status`
- `/orchestrator model [provider/id]`, `/orchestrator model reset`: session subagent model.
- `/orchestrator default [provider/id]`: global default, stored in `~/.pi/agent/orchestrator.json`.

## Development

```bash
git clone https://github.com/Narwhai/my-pi && cd my-pi
npm install
npm run link-pi-types   # symlinks .pi-types to your installed pi for type resolution
npm run typecheck
pi install .            # load from the local checkout; /reload after edits
```

The pi packages (`@earendil-works/*`, `typebox`) are supplied by pi at runtime, so they are peer dependencies and are not installed here (`.npmrc` sets `legacy-peer-deps`). Type checking resolves them through the `.pi-types` symlink.

## License

MIT
