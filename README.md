# Pi extensions

This repository holds Pi extensions and their self-contained validation records.

## Background compaction

Implementation, `install.sh`, tests, and effectiveness artifacts are all under [`background-compaction/`](background-compaction/).

Run validation from this repository:

```sh
npm test
```

Install or update into Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

```sh
./background-compaction/install.sh
```

The installer copies only runtime files to `extensions/background-compaction`, updates the Pi settings entry, and backs up the previous settings/extension under the agent directory's `backups/background-compaction/`. Use `./background-compaction/install.sh --uninstall` to remove the settings entry and move the installed copy into a backup.
