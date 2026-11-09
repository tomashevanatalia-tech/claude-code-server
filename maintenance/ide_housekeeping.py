#!/usr/bin/env python3
"""Bound IDE caches and remove obsolete extensions, never project or login data."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import tempfile
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

MIB = 1024**2
DAY = 86400
DEFAULT_INTERVAL = 3 * DAY


def remaining_delay(completed, now: float, interval: int) -> float:
    if type(completed) not in (int, float) or not 0 <= completed <= now:
        return 0
    return max(0, interval - (now - completed))


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def obsolete_entries(path: Path) -> dict:
    value = read_json(path / ".obsolete", {})
    return value if isinstance(value, dict) else {}


def process_paths(proc: Path = Path("/proc")) -> set[Path]:
    """Read only paths; command arguments and credentials are never logged."""
    paths = set()
    for process in proc.glob("[0-9]*"):
        for link in [process / "exe", process / "cwd", *process.glob("fd/*")]:
            try:
                target = os.readlink(link).removesuffix(" (deleted)")
                if target.startswith("/"):
                    paths.add(Path(target).resolve())
            except OSError:
                continue
        try:
            for arg in (process / "cmdline").read_bytes().split(b"\0"):
                value = os.fsdecode(arg).split("=", 1)[-1]
                if value.startswith("/"):
                    paths.add(Path(value).resolve())
        except OSError:
            continue
    return paths


class Cleaner:
    def __init__(self, root: Path, *, now=None, protected=None, prune_logs=False):
        self.root = root.resolve(strict=True)
        if not self.root.is_dir() or self.root == Path(self.root.anchor):
            raise ValueError("An explicit mounted-volume directory is required")
        self.device = self.root.stat().st_dev
        self.now = time.time() if now is None else now
        self.prune_logs = prune_logs
        self.scan_processes = protected is None
        self.protected = process_paths() if self.scan_processes else set(protected)
        self.operations = []
        self.seen = set()

    def safe(self, path: Path) -> bool:
        try:
            return (
                not path.is_symlink()
                and path.resolve(strict=True).is_relative_to(self.root)
                and path.resolve() != self.root
                and path.stat().st_dev == self.device
            )
        except OSError:
            return False

    def busy(self, path: Path) -> bool:
        canonical = path.resolve()
        return any(
            p == canonical or p.is_relative_to(canonical) for p in self.protected
        )

    def size(self, path: Path) -> int:
        if not self.safe(path):
            return 0
        if path.is_file():
            return path.stat().st_size
        total = 0
        for folder, dirs, files in os.walk(path, followlinks=False):
            base = Path(folder)
            dirs[:] = [d for d in dirs if self.safe(base / d)]
            for name in files:
                item = base / name
                if self.safe(item) and item.is_file():
                    total += item.stat().st_size
        return total

    def removable(self, path: Path) -> bool:
        if not self.safe(path) or self.busy(path):
            return False
        if path.is_dir():
            for folder, dirs, _files in os.walk(path, followlinks=False):
                for name in dirs:
                    child = Path(folder) / name
                    if child.is_symlink():
                        continue
                    if child.stat().st_dev != self.device:
                        return False
                if (Path(folder) / ".git").exists():
                    return False
        return True

    def plan_delete(self, path: Path, reason: str, size=None) -> bool:
        if not self.removable(path) or path.resolve() in self.seen:
            return False
        self.seen.add(path.resolve())
        self.operations.append(
            {
                "action": "delete",
                "path": str(path.resolve()),
                "bytes": self.size(path) if size is None else size,
                "reason": reason,
            }
        )
        return True

    def cache(self, path: Path, *, budget: int, ttl=14 * DAY, grace=DAY):
        if not self.safe(path) or not path.is_dir():
            return
        entries = []
        for child in path.iterdir():
            if self.safe(child):
                entries.append((child.stat().st_mtime, child, self.size(child)))
        total = sum(size for _mtime, _child, size in entries)
        for mtime, child, size in sorted(entries, key=lambda row: row[0]):
            age = self.now - mtime
            if (
                age >= grace
                and (age >= ttl or total > budget)
                and self.plan_delete(child, "expired/over-budget download cache", size)
            ):
                total -= size

    def extensions(self, path: Path):
        if not self.safe(path) or not path.is_dir():
            return
        obsolete = obsolete_entries(path)
        groups = {}
        for child in path.iterdir():
            if not self.safe(child) or not child.is_dir():
                continue
            manifest = read_json(child / "package.json", {})
            if not isinstance(manifest, dict):
                continue
            identity = (manifest.get("publisher"), manifest.get("name"))
            version = manifest.get("version", "")
            if not all(isinstance(v, str) and v for v in (*identity, version)):
                continue
            identity = tuple(value.lower() for value in identity)
            key = tuple(int(v) for v in re.findall(r"\d+", version))
            groups.setdefault(identity, []).append((key, child))
        keep = set()
        for versions in groups.values():
            # Keep the newest two versions, including all platform variants.
            newest = set(sorted({version for version, _p in versions})[-2:])
            keep.update(p.resolve() for version, p in versions if version in newest)
        # The editor's selected versions are also protected, even when older.
        selections = [path / "extensions.json"]
        selections += list(
            (path.parent / "User" / "profiles").glob("*/extensions.json")
        )
        for selection in selections:
            values = read_json(selection, [])
            if not isinstance(values, list):
                continue
            for value in values:
                if not isinstance(value, dict):
                    continue
                location = value.get("relativeLocation")
                if isinstance(location, str) and Path(location).name == location:
                    keep.add((path / location).resolve())
                location = value.get("location", {})
                if isinstance(location, dict) and isinstance(location.get("path"), str):
                    keep.add(Path(location["path"]).resolve())
        for name, marked in obsolete.items():
            if (
                marked is not True
                or not isinstance(name, str)
                or Path(name).name != name
            ):
                continue
            child = path / name
            if not self.safe(child) or child.resolve() in keep:
                continue
            if self.now - child.stat().st_mtime < 7 * DAY:
                continue
            if obsolete_entries(path).get(name) is not True:
                continue
            self.plan_delete(
                child, "editor-marked obsolete extension; active/newest versions kept"
            )

    def logs(self, path: Path):
        if not self.safe(path) or not path.is_dir():
            return
        for folder, dirs, files in os.walk(path, followlinks=False):
            base = Path(folder)
            dirs[:] = [name for name in dirs if self.safe(base / name)]
            for name in files:
                child = base / name
                if not self.safe(child) or not child.is_file():
                    continue
                info = child.stat()
                if self.now - info.st_mtime >= 14 * DAY and not self.busy(child):
                    self.plan_delete(child, "IDE log older than 14 days", info.st_size)
                elif info.st_size > 16 * MIB and child.suffix == ".log":
                    self.operations.append(
                        {
                            "action": "truncate",
                            "path": str(child.resolve()),
                            "bytes": info.st_size - 2 * MIB,
                            "keep": 2 * MIB,
                            "reason": "retain last 2 MiB of oversized IDE log",
                        }
                    )

    def plan(self):
        self.operations = []
        self.seen = set()
        profiles = [self.root, self.root / "clauder-home", Path.home()]
        handled = set()
        for profile in profiles:
            for relative, budget in [
                (".npm/_cacache", 512 * MIB),
                (".npm/_npx", 512 * MIB),
                (".cache/pip", 256 * MIB),
                (".cache/pnpm", 256 * MIB),
                (".cache/uv", 512 * MIB),
                (".local/share/code-server/CachedExtensionVSIXs", 256 * MIB),
            ]:
                path = profile / relative
                canonical = path.resolve()
                if canonical not in handled:
                    handled.add(canonical)
                    self.cache(path, budget=budget)
            for relative, method in [
                (".local/share/code-server/extensions", self.extensions),
                *(
                    [(".local/share/code-server/logs", self.logs)]
                    if self.prune_logs
                    else []
                ),
            ]:
                path = profile / relative
                canonical = path.resolve()
                if canonical not in handled:
                    handled.add(canonical)
                    method(path)
        return self.operations

    def apply(self):
        if self.scan_processes:
            self.protected.update(process_paths())
        freed = 0
        errors = []
        for operation in self.operations:
            path = Path(operation["path"])
            try:
                if operation["action"] == "delete":
                    if not self.removable(path):
                        continue
                    if (
                        "obsolete extension" in operation["reason"]
                        and obsolete_entries(path.parent).get(path.name) is not True
                    ):
                        continue
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()
                else:
                    if not self.safe(path) or not path.is_file():
                        continue
                    # Truncate in place: open append-only log writers keep their inode.
                    keep = operation["keep"]
                    with path.open("r+b") as stream:
                        if os.fstat(stream.fileno()).st_size <= 16 * MIB:
                            continue
                        stream.seek(-keep, os.SEEK_END)
                        tail = stream.read(keep)
                        stream.seek(0)
                        stream.write(tail)
                        stream.truncate(len(tail))
                freed += operation["bytes"]
            except OSError as error:
                errors.append({"path": str(path), "error": type(error).__name__})
        return {"estimated_freed_bytes": freed, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    parser.add_argument(
        "--prune-logs",
        action="store_true",
        help="Explicitly opt into IDE log deletion/rotation",
    )
    args = parser.parse_args()
    if args.loop and not args.apply:
        parser.error("--loop requires --apply")
    if args.interval < 300:
        parser.error("minimum interval is 300 seconds")
    args.root = Cleaner(args.root, protected=set()).root
    # One process per volume; a second startup/terminal cannot duplicate the loop.
    lock = None
    state = args.root / ".local/state/ide-housekeeping"
    if args.apply:
        import fcntl

        state = args.root.resolve(strict=True) / ".local/state/ide-housekeeping"
        if (
            not state.resolve().is_relative_to(args.root)
            or (state / "lock").is_symlink()
        ):
            raise ValueError("Unsafe housekeeping state path")
        state.mkdir(parents=True, exist_ok=True)
        lock = (state / "lock").open("a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()
    logger = None
    if args.loop:
        logfile = state / "run.log"
        if logfile.is_symlink():
            raise ValueError("Unsafe housekeeping log path")
        logger = logging.getLogger("ide-housekeeping")
        logger.setLevel(logging.INFO)
        logger.addHandler(
            RotatingFileHandler(logfile, maxBytes=MIB, backupCount=1, encoding="utf-8")
        )

    def emit(report):
        if logger:
            report = dict(report)
            operations = report.pop("operations", [])
            report["operation_count"] = len(operations)
            report["errors"] = report.get("errors", [])[:10]
            logger.info(json.dumps(report, ensure_ascii=False))
        else:
            print(json.dumps(report, ensure_ascii=False), flush=True)

    while True:
        if args.loop:
            previous = read_json(state / "last-run.json", {})
            completed = (
                previous.get("completed_at") if isinstance(previous, dict) else None
            )
            delay = remaining_delay(completed, time.time(), args.interval)
            if delay:
                time.sleep(delay)
        try:
            cleaner = Cleaner(args.root, prune_logs=args.prune_logs)
            cleaner.plan()
            before = shutil.disk_usage(cleaner.root)
            report = {
                "component": "ide-housekeeping",
                "time": int(time.time()),
                "mode": "apply" if args.apply else "dry-run",
                "operations": cleaner.operations,
            }
            if args.apply:
                report.update(cleaner.apply())
                report["free_bytes_change"] = (
                    shutil.disk_usage(cleaner.root).free - before.free
                )
                if not report["errors"]:
                    with tempfile.NamedTemporaryFile(
                        mode="w", dir=state, delete=False, encoding="utf-8"
                    ) as saved:
                        json.dump({"completed_at": time.time()}, saved)
                    os.replace(saved.name, state / "last-run.json")
            emit(report)
        except (OSError, ValueError) as error:
            emit({"component": "ide-housekeeping", "error": type(error).__name__})
            if not args.loop:
                raise
        if not args.loop:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
