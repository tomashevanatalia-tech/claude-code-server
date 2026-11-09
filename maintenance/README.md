# IDE disk housekeeping

The utility operates only inside the explicitly named Railway volume. It does not
scan or delete project folders, Git worktrees, CLI logins, editor settings or
Claude/Codex conversation history.

Policies run once every 72 hours, without any model/API calls. The last successful
run is saved on the volume, so opening another window or restarting the container
does not trigger an additional early cleanup:

- Only extensions marked obsolete by the editor are eligible after seven days.
  Keep the two newest versions of each extension, selected editor/profile versions,
  and any version referenced by a running process or open file.
- Download caches: npm content/npx 512 MiB each; pip/pnpm 256 MiB each; uv 512 MiB;
  cached extension installers 256 MiB. Remove expired entries after 14 days or
  oldest eligible entries above budget. Keep the last 24 hours and files in use.
- Existing IDE logs are preserved by default. The utility's own diagnostic log
  rotates at 1 MiB with one backup. An operator can opt into IDE log pruning with
  `--prune-logs`; it retains 14 days and limits oversized individual logs.

Budgets are soft while downloads or processes are active. Playwright browsers,
installed Python libraries, npm global packages and unmarked extensions are kept.

```sh
python3 maintenance/ide_housekeeping.py --root /home/coder           # dry run
python3 maintenance/ide_housekeeping.py --root /home/coder --apply   # clean once
python3 maintenance/ide_housekeeping.py --root /home/coder --apply --loop
python3 -m unittest discover -s maintenance/tests -v
node --test maintenance/tests/extension.test.cjs
```

The small local `foxmetod.ide-housekeeping` workspace extension starts the utility
after the IDE opens a trusted workspace. Both extension and script live on the
persistent volume, so they survive a container replacement. The launcher checks
the exact script SHA-256, uses fixed process arguments without a shell, and a
volume lock permits only one cleanup loop. No scheduled AI calls or additional
Railway service is needed.

Set `IDE_HOUSEKEEPING_ENABLED=0` to prevent new launches. To stop an already-running
loop, first verify the PID in `.local/state/ide-housekeeping/lock` belongs to this
utility, then stop that process. Existing app/editor/agent processes are not stopped.
