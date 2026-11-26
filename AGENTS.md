# herdr-usage-status

Source of truth for the `usage-status` mod: a single gauge icon in Herdr's status bar. Clicking it opens a compact panel with each subscription's limits.

## Optional integration

If the `mod-manager` mod (`herdr-mod-manager` repo) is installed, the bar shows a puzzle icon to the left of the gauge that opens the **Mods** screen (`mod.open mod-manager`). Detection checks `mods/mod-manager/main.js` every 15 s; without it the icon does not appear. The icon displays how many mod updates are available by reading `mods-disabled/.mod-manager-updates.json`; if that file is older than a day, the bar fetches `https://assets.herdr.dev/mods/index.json` and rewrites it (at most one attempt per hour), using `.mod-manager-sources.json`. It only counts mods whose folder changed: when the repo commit changed, it queries the folder hash on GitHub (`contents/<path>/mods?ref=<commit>`) and compares it with the recorded `tree`. When offline or rate-limited, it does not count. It does not write sources (owned by `mod-manager`). The format belongs to `mod-manager`: if changed there, update it here too.

## Rule: always update Herdr's live folder

Herdr loads mods from `~/.config/herdr-app/mods/<name>`. After **any** change here:

```sh
./sync.sh
```

The script copies `mods/usage-status` to the live folder and runs `herdr-app check`. Do not edit the live folder directly.

## Layout wiring

The personal layout `~/.config/herdr-app/layouts/werlang.json` uses:

```json
{
  "id": "status",
  "type": "block",
  "content": { "mod": "usage-status" },
  "size": { "px": 28 }
}
```

Keep the folder name `usage-status`: `main.js` references `mods/usage-status/...` (helpers and SVGs) by absolute path from `~/.config/herdr-app`.

## Data and credentials

The helpers read local credentials (Claude Keychain, `~/.codex/auth.json`) and call local endpoints/CLIs. No credentials are stored in the repository. `.cache-*.json` files are local and listed in `.gitignore`.

Providers without data are hidden in the panel (Codex, for example, only appears when a valid session exists).

## Skill

The `herdr-publish` skill is in `.agents/skills/herdr-publish/SKILL.md`. It covers validation, sync, `RECIPE.md`/`preview.png`, and publishing to `herdr.dev/mods` with the `herdr-mod` topic.
