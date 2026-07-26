#!/usr/bin/env python3
"""Install or uninstall LeanFlow without modifying OMP itself."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat as stat_module
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

PACKAGE = "leanflow"
METADATA_NAME = "leanflow-install.json"
SCHEMA_VERSION = 1

# Source-relative path -> install-relative path -> kind.
# Source files live at the leanflow package root; install targets live under
# <base>/commands, <base>/agents, <base>/skills/leanflow.
EXPECTED_KINDS = {
    "commands/flow.md": "file",
    "agents/scout.md": "file",
    "agents/gate.md": "file",
    "skills/leanflow/SKILL.md": "file",
    "extensions/leanflow-bootstrap.ts": "file",
}
EXPECTED_KINDS_BY_VERSION = {1: EXPECTED_KINDS, SCHEMA_VERSION: EXPECTED_KINDS}


class InstallError(Exception):
    pass


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(str(path), "rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for entry in sorted(path.rglob("*")):
        rel = entry.relative_to(path).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        if entry.is_file() and not entry.is_symlink():
            digest.update(sha256_file(entry).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def content_digest(path: Path, kind: str) -> str:
    return sha256_tree(path) if kind == "directory" else sha256_file(path)


def source_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_user_root() -> Path:
    override = os.environ.get("PI_CODING_AGENT_DIR")
    if override:
        return Path(override).expanduser().resolve(strict=False)
    try:
        completed = subprocess.run(
            ["omp", "config", "path"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        completed = None
    if completed is not None and completed.returncode == 0 and completed.stdout.strip():
        return Path(completed.stdout.strip()).expanduser().resolve(strict=False)
    return (Path.home() / ".omp" / "agent").resolve(strict=False)


def resolve_base(scope: str, project_root: Optional[str]) -> Path:
    if scope == "user":
        if project_root is not None:
            raise InstallError("--project-root is valid only with --scope project")
        return resolve_user_root()
    root = Path(project_root).expanduser() if project_root else Path.cwd()
    root = root.resolve(strict=False)
    return root / ".omp"


def package_sources(root: Path) -> List[Tuple[str, Path, str]]:
    """Map install-relative paths to source files at the leanflow package root."""
    entries: List[Tuple[str, Path, str]] = []
    for relative, kind in EXPECTED_KINDS.items():
        source = root / relative
        if kind == "directory" and not source.is_dir():
            raise InstallError("missing source directory: %s" % source)
        if kind == "file" and not source.is_file():
            raise InstallError("missing source file: %s" % source)
        validate_relative(relative)
        entries.append((relative, source, kind))
    return entries


def validate_relative(relative: str) -> PurePosixPath:
    path = PurePosixPath(relative)
    if not relative or relative.startswith("/") or "\\" in relative or any(
        part in ("", ".", "..") for part in path.parts
    ):
        raise InstallError("unsafe metadata path: %s" % relative)
    if str(path) != relative:
        raise InstallError("non-normalized metadata path: %s" % relative)
    return path


def target_for(base: Path, relative: str) -> Path:
    path = validate_relative(relative)
    target = base.joinpath(*path.parts)
    resolved_parent = target.parent.resolve(strict=False)
    resolved_base = base.resolve(strict=False)
    if os.path.commonpath((str(resolved_base), str(resolved_parent))) != str(resolved_base):
        raise InstallError("target escapes installation root: %s" % relative)
    return target


def target_state(target: Path) -> str:
    if target.is_symlink():
        return "symlink"
    if target.is_dir():
        return "directory"
    if target.exists():
        return "file"
    return "absent"


def remove_target(target: Path) -> None:
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(str(target))


def snapshot_from_stat(info: os.stat_result, link_target: Optional[str] = None) -> str:
    if stat_module.S_ISLNK(info.st_mode):
        kind = "symlink"
    elif stat_module.S_ISDIR(info.st_mode):
        kind = "directory"
    elif stat_module.S_ISREG(info.st_mode):
        kind = "file"
    else:
        kind = "other"
    value: Dict[str, Any] = {
        "change_time_ns": info.st_ctime_ns,
        "device": info.st_dev,
        "inode": info.st_ino,
        "kind": kind,
        "mode": info.st_mode,
        "modify_time_ns": info.st_mtime_ns,
        "size": info.st_size,
    }
    if link_target is not None:
        value["link_target"] = link_target
    return stable_json(value)


def target_snapshot(target: Path) -> Optional[str]:
    try:
        info = os.lstat(str(target))
    except (FileNotFoundError, NotADirectoryError):
        return None
    link_target = os.readlink(str(target)) if stat_module.S_ISLNK(info.st_mode) else None
    return snapshot_from_stat(info, link_target)


def open_parent_fd(
    root_fd: int,
    relative: str,
    create: bool = False,
    created: Optional[List[str]] = None,
) -> Tuple[int, str]:
    parts = validate_relative(relative).parts
    current_fd = os.dup(root_fd)
    traversed: List[str] = []
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        for component in parts[:-1]:
            traversed.append(component)
            try:
                next_fd = os.open(component, flags, dir_fd=current_fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o755, dir_fd=current_fd)
                if created is not None:
                    created.append("/".join(traversed))
                next_fd = os.open(component, flags, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd, parts[-1]
    except Exception:
        os.close(current_fd)
        raise


def relative_snapshot(root_fd: int, relative: str) -> Optional[str]:
    parent_fd, leaf = open_parent_fd(root_fd, relative)
    try:
        try:
            info = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        link_target = (
            os.readlink(leaf, dir_fd=parent_fd)
            if stat_module.S_ISLNK(info.st_mode)
            else None
        )
        return snapshot_from_stat(info, link_target)
    finally:
        os.close(parent_fd)


def relative_replace(
    source_root_fd: int,
    source_relative: str,
    destination_root_fd: int,
    destination_relative: str,
    create_destination: bool = False,
    created: Optional[List[str]] = None,
) -> None:
    source_parent_fd, source_leaf = open_parent_fd(source_root_fd, source_relative)
    try:
        destination_parent_fd, destination_leaf = open_parent_fd(
            destination_root_fd,
            destination_relative,
            create=create_destination,
            created=created,
        )
        try:
            os.replace(
                source_leaf,
                destination_leaf,
                src_dir_fd=source_parent_fd,
                dst_dir_fd=destination_parent_fd,
            )
        finally:
            os.close(destination_parent_fd)
    finally:
        os.close(source_parent_fd)


def relative_rmdir(root_fd: int, relative: str) -> None:
    parent_fd, leaf = open_parent_fd(root_fd, relative)
    try:
        os.rmdir(leaf, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)


def _is_source_overlap(target: Path, source: Path, base: Path) -> bool:
    """True only when the install *base* itself lives inside the source package.

    A symlink target that resolves to its source file is the correct, intended
    state for symlink-mode installs — not an overlap. The real conflict is when
    the whole install directory (base) is nested inside the source package tree
    (e.g. installing leanflow into leanflow/.omp/), because every operation
    then mutates the package being read. ``--force`` must be allowed to replace
    a correctly-pointing symlink in place.
    """
    try:
        base_resolved = base.resolve(strict=False)
        source_root = source.resolve(strict=True).parent
        # Walk up: if base is inside the source package, the package root is an
        # ancestor of base. Compare via os.path.commonpath to avoid prefix-only
        # false positives (e.g. /foo/lean vs /foo/leanflow).
        import os.path as _osp
        common = _osp.commonpath([str(base_resolved), str(source_root)])
        return common == str(source_root)
    except (OSError, ValueError):
        # cross-device or non-resolvable path — fall back to the legacy check
        return target.exists() and target.resolve(strict=False) == source.resolve(strict=True)


def planned_entries(
    sources: Sequence[Tuple[str, Path, str]], base: Path, mode: str
) -> List[Dict[str, Any]]:
    planned: List[Dict[str, Any]] = []
    for relative, source, kind in sources:
        target = target_for(base, relative)
        entry: Dict[str, Any] = {
            "digest": content_digest(source, kind),
            "kind": kind,
            "path": relative,
            "snapshot": target_snapshot(target),
            "state": target_state(target),
        }
        entry["source_overlap"] = _is_source_overlap(target, source, base)
        if mode == "symlink":
            entry["link_target"] = str(source.resolve(strict=True))
        planned.append(entry)
    return planned


def metadata_path(base: Path) -> Path:
    return base / METADATA_NAME


def read_metadata(base: Path) -> Mapping[str, Any]:
    path = metadata_path(base)
    if not path.exists():
        raise InstallError("no LeanFlow installation metadata at %s" % base)
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise InstallError("invalid LeanFlow install metadata: %s" % exc) from exc
    if not isinstance(data, dict) or data.get("package") != PACKAGE:
        raise InstallError("metadata at %s is not a LeanFlow install record" % base)
    schema_version = data.get("schema_version")
    if schema_version not in EXPECTED_KINDS_BY_VERSION:
        raise InstallError("unknown LeanFlow metadata schema_version: %s" % schema_version)
    return data


def install_metadata(scope: str, mode: str, entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    stored: List[Dict[str, Any]] = []
    for entry in entries:
        stored_entry = {
            "digest": entry["digest"],
            "kind": entry["kind"],
            "path": entry["path"],
        }
        if mode == "symlink":
            stored_entry["link_target"] = entry["link_target"]
        stored.append(stored_entry)
    return {
        "entries": stored,
        "mode": mode,
        "package": PACKAGE,
        "schema_version": SCHEMA_VERSION,
        "scope": scope,
    }


def write_metadata_atomic(base: Path, metadata: Mapping[str, Any]) -> None:
    base.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".%s." % METADATA_NAME, dir=str(base))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(stable_json(metadata) + "\n")
        os.replace(temporary, metadata_path(base))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def ancestor_conflicts(base: Path, entries: Sequence[Mapping[str, Any]]) -> List[str]:
    conflicts = set()
    for entry in entries:
        current = target_for(base, entry["path"]).parent
        base_str = str(base.resolve(strict=False))
        while current != base and str(current).startswith(base_str + os.sep):
            if current.exists() and not current.is_dir():
                conflicts.add(str(current.relative_to(base)))
                break
            current = current.parent
    return sorted(conflicts)


def materialize(source: Path, kind: str, target: Path, mode: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode == "symlink":
        target.symlink_to(source.resolve(strict=True), target_is_directory=(kind == "directory"))
    elif kind == "directory":
        shutil.copytree(str(source), str(target), symlinks=True)
    else:
        shutil.copy2(str(source), str(target))


def create_target_parents(
    base_fd: int,
    entries: Sequence[Mapping[str, Any]],
    created: List[str],
) -> None:
    for entry in entries:
        parent_fd, _ = open_parent_fd(
            base_fd, entry["path"], create=True, created=created
        )
        os.close(parent_fd)


def install(root: Path, base: Path, scope: str, mode: str, force: bool, apply: bool) -> Mapping[str, Any]:
    sources = package_sources(root)
    entries = planned_entries(sources, base, mode)
    conflicts = [entry["path"] for entry in entries if entry["state"] != "absent"]
    metadata_snapshot = target_snapshot(metadata_path(base))
    if metadata_snapshot is not None:
        conflicts.append(METADATA_NAME)
    blocked_ancestors = ancestor_conflicts(base, entries)
    result: Dict[str, Any] = {
        "action": "apply" if apply else "dry-run",
        "ancestor_conflicts": blocked_ancestors,
        "base": str(base),
        "conflicts": sorted(conflicts),
        "entries": entries,
        "force": force,
        "mode": mode,
        "scope": scope,
    }
    overlaps = [entry["path"] for entry in entries if entry["source_overlap"]]
    if overlaps:
        result["ok"] = False
        result["error"] = "installation target overlaps package source"
        result["overlaps"] = overlaps
        return result
    if blocked_ancestors:
        result["ok"] = False
        result["error"] = "blocking ancestor collisions cannot be replaced"
        return result
    if conflicts and not force:
        result["ok"] = False
        result["error"] = "existing targets require --force"
        return result
    result["ok"] = True
    if not apply:
        return result

    base_existed = base.exists()
    base.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".leanflow-stage-", dir=str(base)))
    backup = Path(tempfile.mkdtemp(prefix=".leanflow-backup-", dir=str(base)))
    backed_up: List[str] = []
    metadata_backed_up = False
    created_parents: List[str] = []
    promoted: List[str] = []
    metadata_promoted = False
    preserve_backup = False
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    base_fd = os.open(str(base), directory_flags)
    stage_fd = os.open(str(stage), directory_flags)
    backup_fd = os.open(str(backup), directory_flags)
    try:
        for entry, (_, source, kind) in zip(entries, sources):
            materialize(source, kind, stage / entry["path"], mode)
        write_metadata_atomic(stage, install_metadata(scope, mode, entries))

        create_target_parents(base_fd, entries, created_parents)
        for entry in entries:
            if relative_snapshot(base_fd, entry["path"]) != entry["snapshot"]:
                raise InstallError(
                    "installation target changed after preflight: %s"
                    % entry["path"]
                )
        if relative_snapshot(base_fd, METADATA_NAME) != metadata_snapshot:
            raise InstallError("installation metadata target changed after preflight")

        for entry in entries:
            if entry["state"] != "absent":
                relative_replace(
                    base_fd,
                    entry["path"],
                    backup_fd,
                    entry["path"],
                    create_destination=True,
                )
                backed_up.append(entry["path"])
        if metadata_snapshot is not None:
            relative_replace(base_fd, METADATA_NAME, backup_fd, METADATA_NAME)
            metadata_backed_up = True

        for entry in entries:
            relative_replace(
                stage_fd,
                entry["path"],
                base_fd,
                entry["path"],
            )
            promoted.append(entry["path"])
        relative_replace(stage_fd, METADATA_NAME, base_fd, METADATA_NAME)
        metadata_promoted = True
    except Exception as exc:
        rollback_errors: List[str] = []
        for relative in reversed(promoted):
            try:
                relative_replace(
                    base_fd,
                    relative,
                    stage_fd,
                    "rollback/" + relative,
                    create_destination=True,
                )
            except OSError as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        if metadata_promoted:
            try:
                relative_replace(
                    base_fd,
                    METADATA_NAME,
                    stage_fd,
                    "rollback-" + METADATA_NAME,
                )
            except OSError as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        for relative in reversed(backed_up):
            try:
                relative_replace(
                    backup_fd,
                    relative,
                    base_fd,
                    relative,
                    create_destination=True,
                )
            except OSError as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        if metadata_backed_up:
            try:
                relative_replace(
                    backup_fd, METADATA_NAME, base_fd, METADATA_NAME
                )
            except OSError as rollback_exc:
                rollback_errors.append(str(rollback_exc))
        for directory in sorted(
            set(created_parents), key=lambda value: len(PurePosixPath(value).parts), reverse=True
        ):
            try:
                relative_rmdir(base_fd, directory)
            except OSError:
                pass
        if rollback_errors:
            preserve_backup = True
            raise InstallError(
                "installation failed and rollback was incomplete: %s; "
                "recoverable originals are preserved at %s; %s"
                % (exc, backup, "; ".join(rollback_errors))
            ) from exc
        raise InstallError("installation failed before completion: %s" % exc) from exc
    finally:
        os.close(backup_fd)
        os.close(stage_fd)
        os.close(base_fd)
        shutil.rmtree(str(stage), ignore_errors=True)
        if not preserve_backup:
            shutil.rmtree(str(backup), ignore_errors=True)
        if not base_existed:
            try:
                base.rmdir()
            except OSError:
                pass
    return result


def verify_installed_entry(base: Path, entry: Mapping[str, Any], mode: str) -> Optional[str]:
    relative = entry["path"]
    target = target_for(base, relative)
    kind = entry.get("kind")
    if mode == "symlink":
        if not target.is_symlink():
            return "%s is not the recorded symlink" % relative
        actual = str(target.resolve(strict=False))
        if actual != entry.get("link_target"):
            return "%s symlink target changed" % relative
        return None
    if kind == "directory":
        if not target.is_dir() or target.is_symlink():
            return "%s is not the recorded directory" % relative
    elif not target.is_file() or target.is_symlink():
        return "%s is not the recorded file" % relative
    if content_digest(target, kind) != entry.get("digest"):
        return "%s content changed after installation" % relative
    return None


def uninstall(base: Path, scope: str, apply: bool) -> Mapping[str, Any]:
    metadata = read_metadata(base)
    if metadata.get("scope") != scope:
        raise InstallError("metadata scope does not match requested scope")
    mode = metadata.get("mode")
    if mode not in ("copy", "symlink"):
        raise InstallError("metadata install mode is invalid")
    entries = metadata["entries"]
    problems = [problem for problem in (verify_installed_entry(base, entry, mode) for entry in entries) if problem]
    result: Dict[str, Any] = {
        "action": "uninstall" if apply else "uninstall-dry-run",
        "base": str(base),
        "entries": entries,
        "mode": mode,
        "ok": not problems,
        "problems": problems,
        "scope": scope,
    }
    if problems or not apply:
        return result
    for entry in reversed(entries):
        remove_target(target_for(base, entry["path"]))
    metadata_path(base).unlink()
    parents = sorted({target_for(base, entry["path"]).parent for entry in entries}, key=lambda item: len(item.parts), reverse=True)
    for parent in parents:
        if parent == base:
            continue
        try:
            parent.rmdir()
        except OSError:
            pass
    return result


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--dry-run", action="store_true", help="show changes without writing (default)")
    actions.add_argument("--apply", action="store_true", help="perform installation")
    parser.add_argument("--uninstall", action="store_true", help="select metadata-verified uninstall; combine with --apply to remove")
    parser.add_argument("--mode", choices=("symlink", "copy"), default="symlink")
    parser.add_argument("--scope", choices=("user", "project"), default="user")
    parser.add_argument("--project-root", help="target project root; defaults to cwd for project scope")
    parser.add_argument("--force", action="store_true", help="replace existing install targets during installation")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    try:
        root = source_root()
        base = resolve_base(args.scope, args.project_root)
        if args.uninstall:
            result = uninstall(base, args.scope, apply=args.apply)
        else:
            result = install(root, base, args.scope, args.mode, args.force, apply=args.apply)
    except (InstallError, OSError) as exc:
        selected = "uninstall" if args.uninstall else "install"
        operation = "apply" if args.apply else "dry-run"
        result = {"action": "%s-%s" % (selected, operation), "error": str(exc), "ok": False}
    sys.stdout.write(stable_json(result) + "\n")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())