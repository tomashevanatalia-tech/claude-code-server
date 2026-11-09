"""Regression tests for cleanup scope, active processes, retention and reruns."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "ide_housekeeping.py"
SPEC = importlib.util.spec_from_file_location("ide_housekeeping", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
Cleaner, DAY, MIB = MODULE.Cleaner, MODULE.DAY, MODULE.MIB


class HousekeepingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = time.time()

    def tearDown(self):
        self.temp.cleanup()

    def cleaner(self, **kwargs):
        return Cleaner(self.root, now=self.now, protected=set(), **kwargs)

    def file(self, relative, size=100, age=30 * DAY):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as stream:
            stream.truncate(size)
        os.utime(path, (self.now - age, self.now - age))
        return path

    def extension(self, version, *, obsolete=True, age=30 * DAY):
        base = self.root / "clauder-home/.local/share/code-server/extensions"
        path = base / f"vendor.tool-{version}"
        path.mkdir(parents=True)
        (path / "package.json").write_text(
            json.dumps({"publisher": "vendor", "name": "tool", "version": version})
        )
        (path / "tool.bin").write_bytes(b"x" * 100)
        marks = MODULE.obsolete_entries(base)
        if obsolete:
            marks[path.name] = True
        (base / ".obsolete").write_text(json.dumps(marks))
        os.utime(path, (self.now - age, self.now - age))
        return path

    def three_extensions(self):
        return [self.extension(version) for version in ("1.0.0", "1.1.0", "1.2.0")]

    def test_only_obsolete_versions_removed_with_two_newest_preserved(self):
        old, previous, latest = self.three_extensions()
        cleaner = self.cleaner()
        cleaner.plan()
        self.assertEqual([Path(op["path"]) for op in cleaner.operations], [old])
        cleaner.apply()
        self.assertFalse(old.exists())
        self.assertTrue(previous.exists() and latest.exists())

    def test_active_older_extension_kept(self):
        old, *_ = self.three_extensions()
        cleaner = self.cleaner()
        cleaner.protected.add(old / "tool.bin")
        self.assertEqual(cleaner.plan(), [])

    def test_editor_selected_older_extension_kept(self):
        old, *_ = self.three_extensions()
        (old.parent / "extensions.json").write_text(
            json.dumps([{"relativeLocation": old.name}])
        )
        self.assertEqual(self.cleaner().plan(), [])

    def test_profile_selected_older_extension_kept(self):
        old, *_ = self.three_extensions()
        selection = old.parent.parent / "User/profiles/custom/extensions.json"
        selection.parent.mkdir(parents=True)
        selection.write_text(json.dumps([{"location": {"path": str(old)}}]))
        self.assertEqual(self.cleaner().plan(), [])

    def test_recent_obsolete_extension_kept(self):
        old, *_ = self.three_extensions()
        os.utime(old, (self.now, self.now))
        self.assertEqual(self.cleaner().plan(), [])

    def test_unmarked_older_extension_is_never_removed(self):
        old, *_ = self.three_extensions()
        (old.parent / ".obsolete").write_text("{}")
        self.assertEqual(self.cleaner().plan(), [])

    def test_malformed_obsolete_metadata_is_fail_closed(self):
        old, *_ = self.three_extensions()
        for value in ("[]", "not-json", "null"):
            (old.parent / ".obsolete").write_text(value)
            self.assertEqual(self.cleaner().plan(), [])

    def test_unmarked_between_plan_and_apply_is_kept(self):
        old, *_ = self.three_extensions()
        cleaner = self.cleaner()
        cleaner.plan()
        (old.parent / ".obsolete").write_text("{}")
        cleaner.apply()
        self.assertTrue(old.exists())

    def test_process_started_after_plan_is_protected(self):
        old, *_ = self.three_extensions()
        cleaner = self.cleaner()
        cleaner.plan()
        cleaner.protected.add(old / "tool.bin")
        cleaner.apply()
        self.assertTrue(old.exists())

    def test_obsolete_metadata_cannot_escape_extension_directory(self):
        old, *_ = self.three_extensions()
        protected = self.file("important.txt")
        (old.parent / ".obsolete").write_text(
            json.dumps({"../../../../../../important.txt": True})
        )
        self.assertEqual(self.cleaner().plan(), [])
        self.assertTrue(protected.exists())

    def test_cache_budget_removes_oldest_eligible_entry(self):
        old = self.file("cache/old", age=3 * DAY)
        newer = self.file("cache/newer", age=2 * DAY)
        cleaner = self.cleaner()
        cleaner.cache(self.root / "cache", budget=100)
        cleaner.apply()
        self.assertFalse(old.exists())
        self.assertTrue(newer.exists())

    def test_cache_grace_period_protects_download_in_progress(self):
        recent = self.file("cache/current", age=3600)
        cleaner = self.cleaner()
        cleaner.cache(recent.parent, budget=0)
        cleaner.apply()
        self.assertTrue(recent.exists())

    def test_expired_cache_removed_even_below_budget(self):
        expired = self.file("cache/old")
        cleaner = self.cleaner()
        cleaner.cache(expired.parent, budget=1000)
        cleaner.apply()
        self.assertFalse(expired.exists())

    def test_active_npx_package_kept(self):
        active = self.file(".npm/_npx/hash/node_modules/tool/index.js")
        os.utime(self.root / ".npm/_npx/hash", (self.now - 30 * DAY,) * 2)
        cleaner = self.cleaner()
        cleaner.protected.add(active)
        cleaner.plan()
        cleaner.apply()
        self.assertTrue(active.exists())

    def test_projects_credentials_history_and_settings_are_untouched(self):
        items = [
            self.file(name)
            for name in (
                "workspace/project/main.py",
                "-onboardix-/.git/config",
                ".ssh/id_ed25519",
                ".claude/.credentials.json",
                ".claude/projects/session.jsonl",
                ".codex/auth.json",
                "clauder-home/.claude/history.jsonl",
                "clauder-home/.codex/sessions/session.jsonl",
                "clauder-home/.local/share/code-server/User/settings.json",
            )
        ]
        disposable = self.file(".npm/_cacache/old-package")
        cleaner = self.cleaner()
        cleaner.plan()
        cleaner.apply()
        self.assertFalse(disposable.exists())
        self.assertTrue(all(path.exists() for path in items))

    def test_git_repository_in_cache_is_not_removed(self):
        git = self.file(".npm/_npx/project/.git/config")
        os.utime(self.root / ".npm/_npx/project", (self.now - 30 * DAY,) * 2)
        cleaner = self.cleaner()
        cleaner.plan()
        cleaner.apply()
        self.assertTrue(git.exists())

    def test_log_retention_does_not_touch_active_old_log(self):
        old = self.file(".local/share/code-server/logs/old/old.log")
        active = self.file(".local/share/code-server/logs/old/active.log")
        cleaner = self.cleaner(prune_logs=True)
        cleaner.protected.add(active)
        cleaner.plan()
        cleaner.apply()
        self.assertFalse(old.exists())
        self.assertTrue(active.exists())

    def test_oversized_log_keeps_tail_and_inode(self):
        log = self.file(
            ".local/share/code-server/logs/current/main.log", size=17 * MIB, age=0
        )
        with log.open("r+b") as stream:
            stream.seek(-7, os.SEEK_END)
            stream.write(b"the-end")
        before = log.stat().st_ino
        cleaner = self.cleaner(prune_logs=True)
        cleaner.protected.add(log)
        cleaner.plan()
        cleaner.apply()
        self.assertEqual(log.stat().st_size, 2 * MIB)
        self.assertEqual(log.stat().st_ino, before)
        self.assertTrue(log.read_bytes().endswith(b"the-end"))

    def test_symlink_cache_and_external_target_are_untouched(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside)
            secret = target / "keep.txt"
            secret.write_text("keep")
            parent = self.root / ".npm"
            parent.mkdir()
            try:
                (parent / "_cacache").symlink_to(target, target_is_directory=True)
            except OSError:
                self.skipTest("Host does not permit test symlinks")
            cleaner = self.cleaner()
            cleaner.plan()
            cleaner.apply()
            self.assertTrue(secret.exists())

    def test_second_run_is_idempotent(self):
        self.file(".npm/_cacache/expired")
        cleaner = self.cleaner()
        cleaner.plan()
        cleaner.apply()
        self.assertEqual(self.cleaner().plan(), [])

    def test_existing_logs_are_preserved_by_default(self):
        log = self.file(".local/share/code-server/logs/old/history.log")
        cleaner = self.cleaner()
        cleaner.plan()
        cleaner.apply()
        self.assertTrue(log.exists())

    def test_default_interval_is_three_days(self):
        self.assertEqual(MODULE.DEFAULT_INTERVAL, 3 * DAY)

    def test_restart_keeps_remaining_schedule_delay(self):
        self.assertEqual(
            MODULE.remaining_delay(self.now - 2 * DAY, self.now, 3 * DAY), DAY
        )
        self.assertEqual(
            MODULE.remaining_delay(self.now - 4 * DAY, self.now, 3 * DAY), 0
        )

    def test_invalid_saved_schedule_is_ignored(self):
        for invalid in (None, "bad", True, self.now + DAY, -1, float("nan")):
            self.assertEqual(MODULE.remaining_delay(invalid, self.now, 3 * DAY), 0)

    @unittest.skipUnless(sys.platform == "linux", "Requires Linux advisory locks")
    def test_loop_honors_saved_schedule_and_rejects_duplicate_process(self):
        state = self.root / ".local/state/ide-housekeeping"
        state.mkdir(parents=True)
        (state / "last-run.json").write_text(json.dumps({"completed_at": time.time()}))
        retained = self.file(".npm/_cacache/expired")
        command = [
            sys.executable,
            str(SCRIPT),
            "--root",
            str(self.root),
            "--apply",
            "--loop",
            "--interval",
            "300",
        ]
        child = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        try:
            for _ in range(60):
                if (state / "lock").exists() and (state / "lock").read_text():
                    break
                time.sleep(0.05)
            self.assertEqual(int((state / "lock").read_text()), child.pid)
            self.assertIsNone(child.poll())
            duplicate = subprocess.run(
                command, capture_output=True, timeout=5, check=True
            )
            self.assertEqual(duplicate.stdout, b"")
            self.assertTrue(
                retained.exists(),
                "Restart must not run cleanup before its saved due time",
            )
        finally:
            child.terminate()
            child.communicate(timeout=5)

    def test_filesystem_root_is_rejected(self):
        with self.assertRaises(ValueError):
            Cleaner(Path(self.root.anchor), protected=set())

    def test_cli_dry_run_does_not_delete(self):
        item = self.file(".npm/_cacache/old")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root)],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout)["mode"], "dry-run")
        self.assertTrue(item.exists())


if __name__ == "__main__":
    unittest.main()
