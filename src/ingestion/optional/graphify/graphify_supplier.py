"""Private Graphify supplier. Native results are derived artifacts, never authority.

No package imports, provider calls, server or watcher are started at import time.
See README.md for the trusted host interfaces and installed qualification boundary.
"""
from __future__ import annotations

import copy
import array
import base64
import fcntl
import hashlib
import importlib
import importlib.abc
import importlib.machinery
import functools
import contextlib
import inspect
import json
import math
import os
import re
import sys
import stat
import threading
import time
import uuid
from dataclasses import dataclass, fields, is_dataclass
from pathlib import Path
from typing import Any, Callable

PINS = json.loads(Path(__file__).with_name("native-pins.json").read_text())
NATIVE_CLOSURE = json.loads(Path(__file__).with_name("native-closure-pins.json").read_text())
_IMPORT_LOCK = threading.RLock()
_ATTESTED_MODULES: dict[str, tuple[Any, str, str]] = {}
_NO_NATIVE_RESULT = object()
UNSUPPORTED = {
    "watch": "Requires admitted host-owned long-lived lifecycle and semantic scheduling.",
    "mcp": "Requires admitted server/session lifecycle and project containment.",
    "http-mcp": "Requires admitted server/authentication lifecycle.",
    "global-graph": "Native global state uses the user's home; isolated state binding is unreceived.",
    "acquire-url": "Source acquisition/network custody is separate and unreceived.",
    "workspace-connectors": "Connector permissions and source custody are unreceived.",
    "database-scip": "Native dependency and source custody qualification is unreceived.",
    "assistant-install": "Native assistant installation/hooks are a separate lifecycle.",
    "export-html-wiki-callflow": "Renderer dependencies and destination qualification are unreceived.",
    "pr-impact": "Native PR operations invoke external gh; offline selected impact is exposed.",
    "save-result-querylog": "Native home/work-memory write custody is unreceived; reflect is bounded.",
}


class SupplierError(RuntimeError):
    def __init__(self, code: str, message: str, receipt: dict | None = None):
        super().__init__(message)
        self.code, self.receipt = code, receipt


def require(condition: Any, code: str, message: str) -> None:
    if not condition:
        raise SupplierError(code, message)


def json_safe(value: Any) -> Any:
    """Retain native scalar/container types explicitly instead of silently flattening."""
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        require(math.isfinite(value), "NON_JSON_NATIVE", "Nonfinite native number")
        return value
    if isinstance(value, Path):
        return {"$nativeType": "path", "value": str(value)}
    if isinstance(value, array.array):
        return {"$nativeType": "array", "typecode": value.typecode, "itemsize": value.itemsize,
                "byteorder": sys.byteorder, "bytesBase64": base64.b64encode(value.tobytes()).decode("ascii"),
                "items": [json_safe(v) for v in value]}
    if is_dataclass(value) and not isinstance(value, type):
        return {"$nativeType": "dataclass", "class": f"{type(value).__module__}.{type(value).__qualname__}",
                "fields": {field.name: json_safe(getattr(value, field.name)) for field in fields(value)}}
    if isinstance(value, dict):
        if all(isinstance(k, str) for k in value):
            return {k: json_safe(v) for k, v in value.items()}
        return {"$nativeType": "mapping", "entries": [[json_safe(k), json_safe(v)] for k, v in value.items()]}
    if isinstance(value, (list, tuple, set, frozenset)):
        data = [json_safe(v) for v in value]
        if isinstance(value, (set, frozenset)):
            data.sort(key=lambda x: json.dumps(x, sort_keys=True))
        return data if isinstance(value, list) else {"$nativeType": type(value).__name__, "items": data}
    if hasattr(value, "nodes") and hasattr(value, "edges") and hasattr(value, "is_directed"):
        multi = value.is_multigraph()
        edges = list(value.edges(data=True, keys=True)) if multi else list(value.edges(data=True))
        return {"$nativeType": "graph", "directed": value.is_directed(), "multigraph": multi,
                "attributes": json_safe(value.graph), "nodes": json_safe(list(value.nodes(data=True))),
                "edges": json_safe(edges)}
    raise SupplierError("NON_JSON_NATIVE", f"Unsupported native artifact type: {type(value).__name__}")


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(json_safe(value), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class NativeClosureError(SupplierError):
    """Closure refusal retaining the distinction between preflight and effects."""
    def __init__(self, code: str, message: str, *, invoked=False, returned=False, result=_NO_NATIVE_RESULT):
        super().__init__(code, message)
        self.native_invoked, self.native_returned, self.native_result = invoked, returned, result


class _PinnedLoader(importlib.abc.Loader):
    def __init__(self, runtime, name, source):
        self.runtime, self.name, self.source = runtime, name, source

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        # Execute the verified source bytes, never a possibly unrelated cached pyc.
        raw = self.runtime._source(self.name)
        exec(compile(raw, str(self.source), "exec", dont_inherit=True), module.__dict__)
        self.runtime._source(self.name)
        _ATTESTED_MODULES[self.name] = (module, str(self.runtime.package_root), hashlib.sha256(raw).hexdigest())


class _PinnedFinder(importlib.abc.MetaPathFinder):
    def __init__(self, runtime):
        self.runtime = runtime

    def find_spec(self, fullname, path=None, target=None):
        if fullname != "graphify" and not fullname.startswith("graphify."):
            return None
        self.runtime._source(fullname)  # Unknown lazy imports refuse before module execution.
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        source = self.runtime._path(fullname)
        if spec is None or spec.origin is None or Path(spec.origin).resolve() != source:
            raise NativeClosureError("NATIVE_SOURCE_DRIFT", "Graphify import resolved outside its pinned source")
        spec.loader = _PinnedLoader(self.runtime, fullname, source)
        return spec


class InstalledGraphifyRuntime:
    """Lazy direct binding with the fixed admitted public Graphify source closure.

    The host must qualify dependencies, source/processor permission and finite budgets.
    This class does not install anything or qualify a provider account.
    """
    kind = "installed-native"

    def __init__(self, *, package_root: str | Path, semantic_admitted: bool = False):
        # Explicit host-owned installed package directory, never a guessed import.
        self.package_root = Path(package_root).resolve()
        self.semantic_admitted = semantic_admitted

    def _path(self, name):
        pin = NATIVE_CLOSURE["modules"].get(name)
        if pin is None:
            raise NativeClosureError("NATIVE_IMPORT_UNADMITTED", "Graphify module is outside the admitted source closure")
        path = (self.package_root / pin["relativePath"]).resolve()
        if not path.is_relative_to(self.package_root):
            raise NativeClosureError("NATIVE_SOURCE_DRIFT", "Pinned module escaped the package root")
        return path

    def _source(self, name):
        try:
            raw = self._path(name).read_bytes()
        except OSError as exc:
            raise NativeClosureError("NATIVE_SOURCE_DRIFT", "Pinned Graphify source is missing or unreadable") from exc
        if hashlib.sha256(raw).hexdigest() != NATIVE_CLOSURE["modules"][name]["sha256"]:
            raise NativeClosureError("NATIVE_SOURCE_DRIFT", "Graphify dependency differs from the admitted source pin")
        return raw

    def _audit(self):
        # Check the entire admitted closure before every dispatch, not just modules
        # already imported. This detects a changed lazy dependency before effects.
        for name in NATIVE_CLOSURE["modules"]:
            self._source(name)
        for name, native in list(sys.modules.items()):
            if name != "graphify" and not name.startswith("graphify."):
                continue
            source = self._path(name)
            origin = getattr(getattr(native, "__spec__", None), "origin", None)
            filename = getattr(native, "__file__", None)
            if not origin or not filename or Path(origin).resolve() != source or Path(filename).resolve() != source:
                raise NativeClosureError("NATIVE_SOURCE_DRIFT", "Loaded Graphify module differs from the pinned import origin")
            attested = _ATTESTED_MODULES.get(name)
            if attested != (native, str(self.package_root), NATIVE_CLOSURE["modules"][name]["sha256"]):
                raise NativeClosureError("NATIVE_IMPORT_UNATTESTED", "Preloaded Graphify code was not executed through the pinned source loader")

    @contextlib.contextmanager
    def _imports(self):
        # Host must keep executable interpreter/importer custody. This scope binds
        # Graphify Python source; public third-party wheels remain host-owned.
        with _IMPORT_LOCK:
            finder = _PinnedFinder(self)
            sys.meta_path.insert(0, finder)
            try:
                yield
            finally:
                sys.meta_path.remove(finder)

    def resolve(self, module: str, function: str) -> Callable:
        candidates = [p for p in PINS["operations"].values() if p["module"] == module]
        require(module.startswith("graphify.") and len(module.split(".")) == 2, "NATIVE_BINDING", "Only pinned Graphify modules")
        source = self.package_root / (module.split(".")[1] + ".py")
        raw = source.read_bytes()
        require(candidates and hashlib.sha256(raw).hexdigest() == candidates[0]["sourceSha256"],
                "NATIVE_SOURCE_DRIFT", "Installed Graphify module differs from inspected pin")
        with self._imports():
            self._audit()
            native = importlib.import_module(module)
            self._audit()
            call = getattr(native, function)
            require(callable(call) and inspect.getsourcefile(call) is not None
                    and Path(inspect.getsourcefile(call)).resolve() == source,
                    "NATIVE_BINDING", "Pinned native function is not callable from its pinned source")

        @functools.wraps(call)
        def pinned_call(*args, **kwargs):
            with self._imports():
                self._audit()
                try:
                    result = call(*args, **kwargs)
                except BaseException as exc:
                    if isinstance(exc, NativeClosureError):
                        exc.native_invoked = True
                        raise
                    try:
                        self._audit()
                    except NativeClosureError as drift:
                        drift.native_invoked = True
                        raise drift from exc
                    raise
                try:
                    self._audit()
                except NativeClosureError as drift:
                    drift.native_invoked, drift.native_returned, drift.native_result = True, True, result
                    raise
                return result
        return pinned_call


@dataclass(frozen=True)
class AcceptedProjection:
    """Host transport ONLY, returned by an injected canonical owner verifier.

    Not a new canonical schema. The host verifies current reviews/activation/head,
    source dependencies and IDs using existing Atelier knowledge APIs before return.
    """
    extractions: list[dict]
    source_ids: list[str]
    record_ids: list[str]
    history_digest: str
    activation_ref: dict
    qualified_records: list[dict]


class GraphifySupplier:
    """Serial, generation-bound callable native workflow with immutable captures.

    Trusted host supplies `source_catalog()` (current, admitted intake sources),
    optional `map_evidence(native_object, source_descriptor)`, optional
    `accepted_owner(reference)` and `usage_meter(operation)` context objects.
    Callers select operations/settings; callers cannot set acceptance or custody.
    """

    def __init__(self, *, runtime: Any, source_root: str | Path, source_root_id: str,
                 cache_root: str | Path, artifact_root: str | Path,
                 source_catalog: Callable[[], dict[str, dict]],
                 map_evidence: Callable | None = None, accepted_owner: Callable | None = None,
                 usage_meter: Callable | None = None, whole_root_admitted: bool = False,
                 query_hydrator: Callable | None = None, query_verifier: Callable | None = None):
        self.runtime = runtime
        self.root, self.cache, self.artifacts = map(lambda p: Path(p).resolve(), (source_root, cache_root, artifact_root))
        require(bool(source_root_id), "ROOT_ID", "Host-owned logical root ID is required")
        require(self.root != self.cache and self.root != self.artifacts and not self.cache.is_relative_to(self.root)
                and not self.artifacts.is_relative_to(self.root), "ROOT_SCOPE", "Cache/artifact roots must be outside source root")
        require(callable(source_catalog), "SOURCE_OWNER", "An admitted source owner reader is required")
        self.root_id, self.catalog = source_root_id, source_catalog
        self.mapper, self.accepted_owner, self.meter = map_evidence, accepted_owner, usage_meter
        self.query_hydrator, self.query_verifier = query_hydrator, query_verifier
        self.whole_root_admitted = whole_root_admitted
        self.cache.mkdir(parents=True, exist_ok=True)
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.generations: dict[str, dict] = {}
        self.read_graphs: dict[str, dict] = {}
        self.withdrawn: set[str] = set()
        self.enabled, self.epoch = True, 0
        self.lock = threading.Lock()

    def capabilities(self) -> dict:
        return {"enabled": self.enabled, "epoch": self.epoch, "implemented": copy.deepcopy(PINS["operations"]),
                "unsupported": UNSUPPORTED.copy(), "runtime": getattr(self.runtime, "kind", "host-injected"),
                "qualification": "supplier boundary only; native dependency/provider/host qualification separate"}

    def receive_query(self, operation_id: str, *, selections: list | None = None) -> dict:
        """Receive an existing query via trusted canonical-owner callbacks only.

        This is a private receiving seam, not another native operation/canonical.
        Original query/host receipts remain distinct from supplemental captures.
        """
        from query_receiving import receive_query
        return receive_query(self, operation_id, selections=selections)

    def receive_composition(self, received_query: dict, *, receipt_bridge: Callable, verify_receipt_bridge: Callable) -> dict:
        """Receive the selected host step receipt independently of evidence hits.

        No SDK operation or transport is added. Trusted existing host callbacks
        retain their own authority and costs, including successful no-hit queries.
        """
        from composition_receiving import receive_composition
        return receive_composition(self, received_query, receipt_bridge=receipt_bridge,
                                   verify_receipt_bridge=verify_receipt_bridge)

    def remove(self) -> None:
        with self.lock:
            self.enabled = False
            self.epoch += 1
            self.read_graphs.clear()
            for item in self.generations.values():
                item["invalidated"] = "tool-removed"

    def enable(self) -> None:
        with self.lock:
            self.enabled = True
            self.epoch += 1
            self.read_graphs.clear()

    def withdraw(self, source_ids: list[str]) -> None:
        with self.lock:
            self.withdrawn.update(source_ids)
            for gid, item in self.generations.items():
                if self.withdrawn.intersection(item["dependencies"]):
                    item["invalidated"] = "source-withdrawn"
                    self.read_graphs.pop(gid, None)

    def _sources(self, source_ids: list[str]) -> dict[str, dict]:
        require(isinstance(source_ids, list) and len(source_ids) == len(set(source_ids)), "SOURCE_SCOPE", "Unique selected source IDs required")
        current, result = self.catalog(), {}
        for sid in source_ids:
            require(sid in current and sid not in self.withdrawn, "SOURCE_UNAVAILABLE", "Source absent or withdrawn")
            entry = copy.deepcopy(current[sid])
            require(entry.get("sourceId") == sid and entry.get("revision") is not None,
                    "SOURCE_BINDING", "Intake source identity and revision required")
            path = (self.root / entry["path"]).resolve()
            require(path.is_relative_to(self.root) and path.is_file(), "SOURCE_SCOPE", "Source path escaped root or is not a file")
            expected = entry.get("sourceDigest")
            require(isinstance(expected, str) and len(expected) == 64 and hashlib.sha256(path.read_bytes()).hexdigest() == expected,
                    "SOURCE_STALE", "Selected source bytes differ from intake digest")
            entry["path"] = path.relative_to(self.root).as_posix()
            result[sid] = entry
        return result

    def _fresh(self, generation_id: str, kind: str | None = None) -> dict:
        try:
            return self._fresh_checked(generation_id, kind)
        except Exception:
            self.read_graphs.pop(generation_id, None)
            raise

    def _fresh_checked(self, generation_id: str, kind: str | None = None) -> dict:
        item = self._retained(generation_id, kind)
        require(not item.get("invalidated"),
                "GENERATION_STALE", "Generation invalidated or tool removed")
        now = self._sources(list(item["dependencies"]))
        require(now == item["dependencies"], "GENERATION_STALE", "Source binding/revision changed")
        if item.get("accepted_reference") is not None:
            current = self.accepted_owner(copy.deepcopy(item["accepted_reference"]))
            require(isinstance(current, AcceptedProjection) and digest(current.__dict__) == item["accepted_digest"],
                    "ACCEPTANCE_STALE", "Canonical accepted projection changed")
        return item

    def _retained(self, generation_id: str, kind: str | None = None) -> dict:
        """Historical artifacts may feed diff/update, never current query authority."""
        item = self.generations.get(generation_id)
        require(item is not None, "GENERATION_UNKNOWN", "Unknown supplier generation")
        require(self.enabled and item["epoch"] == self.epoch, "GENERATION_STALE", "Tool lifecycle invalidated generation")
        require(kind is None or item["kind"] == kind, "GENERATION_KIND", "Wrong native generation kind")
        require(item.get("invalidated") not in {"failed", "cancelled"}, "GENERATION_STALE", "Failed/cancelled generation")
        return item

    def _write(self, operation_dir: Path, name: str, value: Any) -> dict:
        require(not operation_dir.is_symlink() and operation_dir.resolve() == operation_dir
                and operation_dir.parent == self.artifacts and self.artifacts.resolve() == self.artifacts
                and isinstance(name, str) and Path(name).name == name and name not in {"", ".", ".."},
                "CAPTURE_ROOT_ESCAPE", "Capture destination changed or escaped its owned operation root")
        raw = json.dumps(json_safe(value), ensure_ascii=False, sort_keys=True, indent=2).encode()
        path = operation_dir / name
        # No caller-selected file name; operation directory is exclusive and owned.
        directory_fd = os.open(operation_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            file_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
            with os.fdopen(file_fd, "wb") as out:
                out.write(raw)
                out.flush()
                os.fsync(out.fileno())
        finally:
            os.close(directory_fd)
        return {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}

    def read_capture(self, operation_id: str) -> dict:
        """Read a terminal capture after restart; never restore serving authority.

        Artifact hashes are checked against the retained receipt. The receipt
        itself needs existing intake custody for an independently trusted pin.
        """
        require(isinstance(operation_id, str) and re.fullmatch(r"[0-9a-f]{32}", operation_id), "CAPTURE_ID", "Owned capture identifier required")
        directory = self.artifacts / operation_id
        require(directory.is_dir() and not directory.is_symlink(), "CAPTURE_SCOPE", "Owned capture missing")
        receipt_path = directory / "receipt.json"
        require(receipt_path.is_file() and not receipt_path.is_symlink(), "CAPTURE_INCOMPLETE", "Terminal capture receipt missing; native outcome is unknown")
        receipt = json.loads(receipt_path.read_text())
        require(receipt.get("operationId") == operation_id and receipt.get("canonicalMutation") is False
                and receipt.get("authority") == "none" and receipt.get("status") in {"complete", "partial", "failed", "cancelled"},
                "CAPTURE_INCOMPLETE", "Invalid terminal capture")
        artifacts = receipt.get("artifacts", []) + [chunk["capture"] for chunk in receipt.get("chunks", [])]
        for artifact in artifacts:
            path = Path(artifact["path"])
            require(path.resolve().is_relative_to(directory) and path.is_file() and not path.is_symlink()
                    and hashlib.sha256(path.read_bytes()).hexdigest() == artifact["sha256"],
                    "ARTIFACT_DRIFT", "Retained capture differs from receipt")
        return {"receipt": receipt, "servingAuthorityRestored": False,
                "qualification": "local capture readback; independent receipt pin/intake registration required"}

    def _invoke(self, operation: str, *args: Any, **kwargs: Any) -> Any:
        pin = PINS["operations"][operation]
        call = self.runtime.resolve(pin["module"], pin["function"])
        try:
            inspect.signature(call).bind(*args, **kwargs)
        except (ValueError, TypeError) as exc:
            raise SupplierError("NATIVE_SIGNATURE", "Selected native function signature is incompatible") from exc
        trace = getattr(self, "_native_trace", None)
        if trace is not None:
            trace["invocations"] += 1
        try:
            result = call(*args, **kwargs)
        except NativeClosureError as exc:
            if trace is not None:
                if not exc.native_invoked:
                    trace["invocations"] -= 1
                if exc.native_returned:
                    trace["returns"] += 1
            raise
        if trace is not None:
            trace["returns"] += 1
        return result

    def _inventory_partial_artifacts(self, directory: Path, receipt: dict) -> None:
        """Bounded no-follow inventory; neither custody errors nor bounds hide failure.

        Unhashed originals remain on disk. This is hash custody, not completion,
        rollback, usage accounting or authority to read beyond the operation root.
        """
        limits = {"entries": 4096, "files": 256, "bytes": 16 * 1024 * 1024, "depth": 8}
        inventory = {"bounds": limits, "visitedEntries": 0, "hashedFiles": 0, "readBytes": 0,
                     "unlisted": [], "truncated": False, "scope": "owned operation root only; originals retained"}
        receipt["partialArtifactInventory"] = inventory
        require(not directory.is_symlink() and directory.resolve() == directory
                and directory.parent == self.artifacts and self.artifacts.resolve() == self.artifacts,
                "CAPTURE_ROOT_ESCAPE", "Partial capture root changed or escaped")
        known = {a["path"] for a in receipt["artifacts"]}
        flags = os.O_RDONLY | os.O_NOFOLLOW
        def omit(relative, reason):
            inventory["unlisted"].append({"path": relative.as_posix(), "reason": reason})
        def walk(fd, relative, depth):
            entries = []
            with os.scandir(fd) as scan:
                for entry in scan:
                    if inventory["visitedEntries"] >= limits["entries"]:
                        inventory["truncated"] = True
                        omit(relative, "entry-bound")
                        break
                    inventory["visitedEntries"] += 1
                    entries.append(entry)
            for entry in sorted(entries, key=lambda value: value.name):
                child = relative / entry.name
                path = directory / child
                metadata = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(metadata.st_mode):
                    omit(child, "symlink-not-followed")
                    continue
                if not path.resolve().is_relative_to(directory):
                    omit(child, "root-escape-refused")
                    continue
                if stat.S_ISDIR(metadata.st_mode):
                    if depth >= limits["depth"]:
                        inventory["truncated"] = True; omit(child, "depth-bound")
                        continue
                    child_fd = os.open(entry.name, flags | os.O_DIRECTORY, dir_fd=fd)
                    try:
                        walk(child_fd, child, depth + 1)
                    finally:
                        os.close(child_fd)
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    omit(child, "nonregular-file-not-read")
                    continue
                if str(path) in known:
                    continue
                if inventory["hashedFiles"] >= limits["files"] or metadata.st_size > limits["bytes"] - inventory["readBytes"]:
                    inventory["truncated"] = True; omit(child, "file-or-byte-bound")
                    continue
                file_fd = os.open(entry.name, flags | os.O_NONBLOCK, dir_fd=fd)
                try:
                    before = os.fstat(file_fd)
                    require(stat.S_ISREG(before.st_mode) and (before.st_dev, before.st_ino) == (metadata.st_dev, metadata.st_ino)
                            and path.resolve().is_relative_to(directory), "CAPTURE_ROOT_ESCAPE", "Partial file changed identity or escaped")
                    hasher, size = hashlib.sha256(), 0
                    while inventory["readBytes"] < limits["bytes"]:
                        chunk = os.read(file_fd, min(65536, limits["bytes"] - inventory["readBytes"]))
                        if not chunk:
                            break
                        inventory["readBytes"] += len(chunk); size += len(chunk); hasher.update(chunk)
                    after = os.fstat(file_fd)
                    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or size != after.st_size:
                        inventory["truncated"] = True; omit(child, "changed-or-byte-bound-during-read")
                        continue
                    receipt["artifacts"].append({"path": str(path), "sha256": hasher.hexdigest(), "bytes": size})
                    inventory["hashedFiles"] += 1
                finally:
                    os.close(file_fd)
        root_fd = os.open(directory, flags | os.O_DIRECTORY)
        try:
            walk(root_fd, Path(), 0)
        finally:
            os.close(root_fd)

    def _read_graph_native(self, operation: str, graph: Any, directory: Path, receipt: dict, *args: Any, **kwargs: Any) -> Any:
        # serve's lookup/query paths add array/set caches to graph attributes.
        # Retain those native effects separately; they must not poison the
        # accepted/exploratory graph or its original native JSON exporter.
        gid = receipt["graphGeneration"]
        key = digest({"generation": gid, "operation": operation, "settings": receipt["settings"]})
        cached = self.read_graphs.get(gid)
        reused = cached is not None and cached["key"] == key
        working = cached["graph"] if reused else copy.deepcopy(graph)
        receipt["nativeGraphUse"] = {"isolatedFromGeneration": True, "warmLookupCacheReused": reused,
                                     "generationId": gid, "settingsKey": key, "maximumCachedGenerations": 8}
        receipt["limitations"].append("Native lookup state is a separate current-generation/settings-bound in-memory graph cache; reuse is not speed or quality proof.")
        try:
            result = self._invoke(operation, working, *args, **kwargs)
            self.read_graphs.pop(gid, None)
            self.read_graphs[gid] = {"key": key, "graph": working}
            while len(self.read_graphs) > 8:
                self.read_graphs.pop(next(iter(self.read_graphs)))
            return result
        except BaseException:
            self.read_graphs.pop(gid, None)
            raise
        finally:
            receipt["artifacts"].append(self._write(directory, "native-read-graph.json", working))

    def _settings(self, params: dict, allowed: set[str]) -> dict:
        value = copy.deepcopy(params.get("settings", {}))
        require(isinstance(value, dict) and not (set(value) - allowed), "SETTING_UNSUPPORTED", "Unknown or reserved native settings")
        require("api_key" not in value, "SECRET_SETTING", "Credentials belong to the admitted runtime, not receipts")
        if value.get("dedup_llm_backend") is not None:
            require(getattr(self.runtime, "semantic_admitted", False), "PROCESSOR_UNADMITTED", "Model-backed dedup requires host admission")
        return value

    def call(self, operation: str, params: dict | None = None, *, cancel: threading.Event | None = None) -> dict:
        params = copy.deepcopy(params or {})
        require(operation in PINS["operations"], "CAPABILITY_UNSUPPORTED", UNSUPPORTED.get(operation, "Unknown operation"))
        require(self.lock.acquire(blocking=False), "WRITER_BUSY", "A supplier operation owns the native writer")
        file_lock = None
        receipt, opdir, meter = None, None, None
        failed = False
        self._native_trace = {"invocations": 0, "returns": 0}
        try:
            require(self.enabled, "TOOL_REMOVED", "Graphify is unavailable")
            require(not cancel or not cancel.is_set(), "CANCELLED", "Cancelled before native dispatch")
            file_lock = (self.artifacts / ".writer.lock").open("a+b")
            try:
                fcntl.flock(file_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise SupplierError("WRITER_BUSY", "Another process owns this supplier destination") from exc
            opid = uuid.uuid4().hex
            opdir = self.artifacts / opid
            opdir.mkdir()
            receipt = {"operationId": opid, "operation": operation, "producer": PINS["upstreamCommit"],
                       "runtime": getattr(self.runtime, "kind", "host-injected"), "rootIdentity": self.root_id,
                       "root": str(self.root), "cacheRoot": str(self.cache), "epoch": self.epoch,
                       "canonicalMutation": False, "authority": "none", "status": "running", "artifacts": [],
                       "nativePin": PINS["operations"][operation], "settings": {}, "limitations": []}
            meter = self.meter(operation) if self.meter else None
            if meter:
                meter.start()
            began = time.monotonic()
            result = self._execute(operation, params, opdir, receipt, cancel)
            receipt["elapsedSeconds"] = time.monotonic() - began
            # Preserve completed native output even if final freshness/cancellation
            # checks refuse its use. Recovery must never imply rerunning a processor.
            receipt["artifacts"].append(self._write(opdir, "result.json", result))
            require(not cancel or not cancel.is_set(), "CANCELLED_AFTER_NATIVE", "Native completed after cancellation; output retained, generation unusable")
            if receipt.get("sourceBindings"):
                current = self._sources(list(receipt["sourceBindings"]))
                require(current == receipt["sourceBindings"], "SOURCE_CHANGED_DURING_NATIVE", "Source changed during native operation; output retained as stale")
            if receipt.get("graphGeneration"):
                self._fresh(receipt["graphGeneration"], "graph")
            if receipt.get("generationId"):
                self._fresh(receipt["generationId"])
            receipt["result"] = json_safe(result)
            receipt["status"] = receipt.get("outcome", "complete")
            if operation == "extract-semantic":
                receipt["nativeUsage"] = {k: result.get(k) for k in ("input_tokens", "output_tokens", "model")}
                receipt["limitations"].append("Native aggregate token counters can omit truncated parent/hollow retry work; callbacks are not per-attempt metering.")
            return receipt
        except BaseException as exc:
            failed = True
            if receipt is not None:
                receipt["status"] = "cancelled" if isinstance(exc, SupplierError) and exc.code.startswith("CANCELLED") else "failed"
                receipt["error"] = {"type": type(exc).__name__, "code": getattr(exc, "code", "NATIVE_FAILURE")}
                if isinstance(exc, NativeClosureError):
                    receipt["nativeExecution"] = {"invoked": exc.native_invoked, "returned": exc.native_returned,
                                                  "state": "unknown-after-closure-drift" if exc.native_invoked else "native-operation-not-started"}
                    receipt["limitations"].append("Closure drift refuses serving; reconcile retained outputs before any replay. No native effect rollback is claimed.")
                    if exc.native_result is not _NO_NATIVE_RESULT:
                        try:
                            receipt["artifacts"].append(self._write(opdir, "post-drift-native-result.json", exc.native_result))
                            receipt["partialNativeResult"] = json_safe(exc.native_result)
                        except Exception as capture_error:
                            receipt["partialCaptureError"] = {"type": type(capture_error).__name__, "code": getattr(capture_error, "code", "CAPTURE_FAILURE")}
                else:
                    invoked = self._native_trace["invocations"] > 0
                    receipt["nativeExecution"] = {"invoked": invoked,
                        "returned": invoked and self._native_trace["returns"] == self._native_trace["invocations"],
                        "state": "unknown-after-native-dispatch" if invoked else "native-operation-not-started"}
                # Ordinary exceptions can leave exporter/processor files too.
                # Inventory failures annotate rather than replace the original error.
                try:
                    self._inventory_partial_artifacts(opdir, receipt)
                except BaseException as inventory_error:
                    receipt["partialArtifactInventoryError"] = {"type": type(inventory_error).__name__, "code": getattr(inventory_error, "code", "CAPTURE_INVENTORY_FAILURE")}
                self.read_graphs.pop(receipt.get("graphGeneration"), None)
                # Do not copy potentially sensitive native error text into portable receipts.
                for item in self.generations.values():
                    if item["operationId"] == receipt["operationId"]:
                        item["invalidated"] = receipt["status"]
            if isinstance(exc, SupplierError):
                exc.receipt = receipt
                raise
            raise SupplierError("NATIVE_FAILURE", "Native operation failed; captures retained", receipt) from exc
        finally:
            try:
                if receipt is not None:
                    if meter:
                        try:
                            receipt["usage"] = json_safe(meter.finish())
                            receipt["usageAssurance"] = "host-metered; host must declare retry coverage"
                        except Exception:
                            receipt["usageAssurance"] = "unknown; meter failed"
                            receipt["limitations"].append("Usage meter failed; do not claim complete cost.")
                    else:
                        receipt["usage"] = None
                        receipt["usageAssurance"] = "unknown; native returned counters only"
                    try:
                        self._write(opdir, "receipt.json", receipt)
                    except BaseException as receipt_error:
                        receipt["receiptCaptureError"] = {"type": type(receipt_error).__name__, "code": getattr(receipt_error, "code", "RECEIPT_CAPTURE_FAILURE")}
                        if not failed:
                            raise
            finally:
                self._native_trace = None
                if file_lock:
                    file_lock.close()
                self.lock.release()

    def _generation(self, op: str, value: Any, sources: dict, receipt: dict, **extras: Any) -> str:
        gid = receipt["operationId"]
        self.generations[gid] = {"kind": op, "value": value, "dependencies": copy.deepcopy(sources),
                                "epoch": self.epoch, "operationId": gid, **extras}
        receipt["generationId"] = gid
        receipt["sourceBindings"] = sources
        return gid

    def _mapping(self, value: dict, sources: dict) -> dict:
        # File association is not passage support. Only host evidence readback
        # can hydrate a canonical evidence receipt; absent locators remain unknown.
        sf = value.get("source_file")
        descriptor = None
        if isinstance(sf, str):
            candidate = (self.root / sf).resolve()
            descriptor = next((s for s in sources.values() if (self.root / s["path"]).resolve() == candidate), None)
        evidence = self.mapper(copy.deepcopy(value), copy.deepcopy(descriptor)) if descriptor and self.mapper else None
        if evidence is not None:
            require(isinstance(evidence, dict) and evidence.get("schema") == "mnstry.atelier-ingestion-evidence@v1"
                    and evidence.get("sourceId") == descriptor["sourceId"] and evidence.get("sourceDigest") == descriptor["sourceDigest"]
                    and evidence.get("freshness") == "current" and evidence.get("integrity") == "verified"
                    and evidence.get("semanticAcceptance") == "pending" and evidence.get("synthesized") is False
                    and isinstance(evidence.get("locator"), dict) and isinstance(evidence.get("text"), str)
                    and all(evidence.get(key) == descriptor[key] for key in ("attemptId", "planId", "planDigest") if key in descriptor),
                    "EVIDENCE_UNVERIFIED", "Canonical evidence readback does not match current source")
        return {"nativeId": value.get("id"), "source": descriptor, "evidence": json_safe(evidence),
                "support": "host-evidence-readback" if evidence is not None else "unknown",
                "identityAcceptance": "pending"}

    def _execute(self, op: str, p: dict, directory: Path, receipt: dict, cancel: Any) -> Any:
        if op in {"discover", "discover-incremental"}:
            require(self.whole_root_admitted, "ROOT_UNADMITTED", "Native discovery reads the whole root; host admission required")
            settings = self._settings(p, {"follow_symlinks", "extra_excludes", "gitignore", "kind"} if op.endswith("incremental") else {"follow_symlinks", "extra_excludes", "gitignore"})
            receipt["settings"] = settings
            kwargs = {"cache_root": self.cache, "google_workspace": False, **settings}
            if op.endswith("incremental"):
                kwargs["manifest_path"] = str(self.cache / "manifest.json")
            result = self._invoke(op, self.root, **kwargs)
            receipt["limitations"].append("Discovery is inventory, not source admission. Workspace conversion is disabled.")
            return result
        if op in {"extract-structure", "extract-semantic", "cache-check"}:
            sources = self._sources(p.get("source_ids", []))
            require(sources, "SOURCE_SCOPE", "Selected source bindings required")
            paths = [self.root / s["path"] for s in sources.values()]
            allowed = {"parallel", "max_workers", "resolution_context_nodes", "resolution_context_edges"}
            if op == "extract-semantic":
                require(getattr(self.runtime, "semantic_admitted", False), "PROCESSOR_UNADMITTED", "Semantic/media processor runtime must be explicitly admitted")
                allowed = {"backend", "model", "chunk_size", "token_budget", "max_concurrency", "max_retry_depth", "deep_mode"}
            elif op == "cache-check":
                allowed = {"mode", "prompt", "prompt_file"}
            settings = self._settings(p, allowed)
            if op == "extract-structure":
                settings = {"parallel": False, "max_workers": 1, **settings}
                require(type(settings["parallel"]) is bool and type(settings["max_workers"]) is int
                        and 1 <= settings["max_workers"] <= 32, "BUDGET_UNBOUNDED", "Finite native structural worker bound required")
            if op == "cache-check":
                require(settings.get("prompt") is None or isinstance(settings["prompt"], str), "PROMPT_SCOPE", "Prompt must be explicit text")
                if settings.get("prompt_file") is not None:
                    prompt_file = Path(settings["prompt_file"]).resolve()
                    require(prompt_file.is_relative_to(self.artifacts) and prompt_file.is_file(),
                            "PROMPT_SCOPE", "Prompt file must be an owned supplier artifact")
                    settings["prompt_file"] = prompt_file
            if op == "extract-semantic":
                settings = {"chunk_size": 20, "token_budget": 60000, "max_concurrency": 1, "max_retry_depth": 0, **settings}
                require(bool(settings.get("backend")) and bool(settings.get("model")), "MODEL_PIN", "Explicit backend/model required")
                for key, maximum in (("chunk_size", 100), ("token_budget", 1000000), ("max_concurrency", 32), ("max_retry_depth", 8)):
                    minimum = 0 if key == "max_retry_depth" else 1
                    require(type(settings[key]) is int and minimum <= settings[key] <= maximum, "BUDGET_UNBOUNDED", "Finite native execution bounds required")
                chunks, chunk_lock = [], threading.Lock()

                def done(index: int, total: int, raw: dict) -> None:
                    # Callback runs on multiple native worker threads. Capture before
                    # cancellation; it contains top-level post-retry output only.
                    with chunk_lock:
                        capture = self._write(directory, f"chunk-{len(chunks):06d}.json", {"index": index, "total": total, "raw": copy.deepcopy(raw)})
                        chunks.append({"index": index, "total": total, "capture": capture})
                        receipt["chunks"] = copy.deepcopy(chunks)
                    require(not cancel or not cancel.is_set(), "CANCELLED", "Cancelled at chunk boundary")

                settings["on_chunk_done"] = done
            receipt["settings"] = {k: json_safe(v) for k, v in settings.items() if k != "on_chunk_done"}
            result = self._invoke(op, paths if op != "cache-check" else [str(x) for x in paths], root=self.root, cache_root=self.cache, **settings)
            if op == "cache-check":
                return result
            receipt["artifacts"].append(self._write(directory, "raw-prebuild.json", result))
            require(isinstance(result, dict), "NATIVE_OUTPUT", "Native extraction must return a dictionary")
            receipt["portableMappings"] = {name: [self._mapping(x, sources) for x in result.get(name, [])]
                                           for name in ("nodes", "edges", "hyperedges")}
            incomplete = bool(result.get("failed_chunks") or result.get("failed_sources") or result.get("uncovered_files")
                              or result.get("_partial_files") or result.get("_partial"))
            receipt["outcome"] = "partial" if incomplete else "complete"
            receipt["coverage"] = {k: copy.deepcopy(result.get(k)) for k in ("failed_chunks", "failed_sources", "extracted_sources", "uncovered_files", "_partial_files", "_partial", "out_of_scope_dropped")}
            receipt["coverage"]["assurance"] = "native-reported; no semantic-completeness claim"
            self._generation("extraction", copy.deepcopy(result), sources, receipt)
            return result
        if op in {"build-native", "build-incremental", "merge-raw", "dedup-proposals", "build-accepted"}:
            sources, extractions, accepted = {}, [], None
            if op == "build-accepted":
                require(callable(self.accepted_owner), "ACCEPTANCE_OWNER", "Canonical owner verifier required; caller receipts cannot confer acceptance")
                accepted = self.accepted_owner(copy.deepcopy(p.get("activation_ref")))
                require(isinstance(accepted, AcceptedProjection) and accepted.history_digest and accepted.activation_ref and accepted.qualified_records,
                        "ACCEPTANCE_UNQUALIFIED", "Current qualified canonical records and head required")
                require(re.fullmatch(r"sha256:[a-f0-9]{64}", accepted.history_digest) and
                        accepted.activation_ref == p.get("activation_ref") and
                        isinstance(accepted.activation_ref.get("id"), str) and
                        re.fullmatch(r"sha256:[a-f0-9]{64}", accepted.activation_ref.get("digest", "")),
                        "ACCEPTANCE_BINDING", "Existing canonical head/activation reference must match selected request")
                require(all(isinstance(record, dict) and record.get("schema") == "atelier-knowledge-record@v1"
                            and record.get("kind") in {"contribution", "relation"}
                            for record in accepted.qualified_records)
                        and {r["id"] for r in accepted.qualified_records} == set(accepted.record_ids),
                        "ACCEPTANCE_RECORDS", "Qualified existing canonical records must cover retained IDs")
                sources, extractions = self._sources(accepted.source_ids), copy.deepcopy(accepted.extractions)
                ids = [n["id"] for ext in extractions for n in ext.get("nodes", [])]
                require(len(ids) == len(set(ids)) and len(accepted.record_ids) == len(set(accepted.record_ids))
                        and set(ids) == set(accepted.record_ids), "ACCEPTANCE_IDENTITY", "Accepted projection must retain existing qualified record IDs")
                settings = {"dedup": False, "directed": True, "protected_ids": set(ids)}
                require(not p.get("settings"), "ACCEPTANCE_SETTING", "Accepted IDs/direction cannot be overridden")
                receipt["acceptedHead"] = accepted.history_digest
                receipt["artifacts"].append(self._write(directory, "qualified-records.json", accepted.qualified_records))
            else:
                for gid in p.get("extraction_ids", []):
                    item = self._fresh(gid, "extraction")
                    sources.update(item["dependencies"])
                    extractions.append(copy.deepcopy(item["value"]))
                require(extractions or op in {"build-incremental", "merge-raw"} and bool(p.get("prune_sources")),
                        "EXTRACTION_REQUIRED", "Captured extraction generations or explicit source pruning required")
                settings = self._settings(p, {"directed", "dedup", "dedup_llm_backend", "protected_ids"} if op in {"build-native", "build-incremental"} else {"communities", "dedup_llm_backend", "protected_ids"} if op == "dedup-proposals" else set())
            receipt["settings"] = json_safe(settings)
            receipt["artifacts"].append(self._write(directory, "raw-prebuild.json", extractions))
            if op == "dedup-proposals":
                raw = {k: sum((e.get(k, []) for e in extractions), []) for k in ("nodes", "edges", "hyperedges")}
                result = self._invoke(op, raw["nodes"], raw["edges"], hyperedges=raw["hyperedges"], root=self.root, **{"communities": {}, **settings})
                receipt["identityAcceptance"] = "pending"
                receipt["rewiredHyperedges"] = json_safe(raw["hyperedges"])
                return result
            if op in {"build-incremental", "merge-raw"}:
                previous = self._retained(p.get("graph_id"), "graph")
                require(previous.get("view") != "accepted-projection", "ACCEPTANCE_SETTING", "Accepted projection requires fresh canonical owner rebuild")
                require(previous.get("native_json"), "NATIVE_EXPORT_REQUIRED", "Incremental native API requires verified JSON export")
                prune = p.get("prune_sources", [])
                allowed_paths = {s["path"] for s in previous["dependencies"].values()} | {s["path"] for s in sources.values()}
                require(isinstance(prune, list) and set(prune) <= allowed_paths, "PRUNE_SCOPE", "Prune only bound source paths")
                ast_sources = p.get("ast_sources")
                require(ast_sources is None or isinstance(ast_sources, list)
                        and set(ast_sources) <= {s["path"] for s in sources.values()},
                        "AST_SOURCE_SCOPE", "AST provenance must be among freshly captured selected sources")
                # A historical graph is intentionally usable for maintenance.
                # Every surviving old binding must be unchanged or re-extracted.
                freshly_captured = set(sources)
                for sid, descriptor in previous["dependencies"].items():
                    if descriptor["path"] in prune or sid in sources:
                        continue
                    current = self._sources([sid])[sid]
                    require(current == descriptor, "INCREMENTAL_STALE", "Changed source must be replaced or explicitly pruned")
                    sources[sid] = descriptor
                # Native pruning removes the old version before the new chunks
                # replace it. The replacement's current dependency must survive.
                sources = {sid: s for sid, s in sources.items() if s["path"] not in prune or sid in freshly_captured}
                native_path = previous["native_json"]["path"]
                require(hashlib.sha256(Path(native_path).read_bytes()).hexdigest() == previous["native_json"]["sha256"], "ARTIFACT_DRIFT", "Native export changed")
                if op == "merge-raw":
                    combined = {k: sum((e.get(k, []) for e in extractions), []) for k in ("nodes", "edges", "hyperedges")}
                    raw = self._invoke(op, combined, native_path, prune_sources=prune, root=self.root, ast_sources=ast_sources)
                    self._generation("extraction", copy.deepcopy(raw), sources, receipt)
                    return raw
                graph = self._invoke(op, extractions, graph_path=native_path, prune_sources=prune, root=self.root, ast_sources=ast_sources, **settings)
            else:
                graph = self._invoke("build-native", extractions, root=self.root, **settings)
            receipt["artifacts"].append(self._write(directory, "native-build-output.json", graph))
            receipt["limitations"].append("Native simple build can coalesce parallel predicates; exact assertions/qualifiers remain in raw/qualified records. Stored orientation and logical traversal differ.")
            extras = {"view": "accepted-projection" if accepted else "source-exploration"}
            if accepted:
                require(set(graph.nodes) == set(accepted.record_ids), "ACCEPTANCE_IDENTITY", "Native build changed qualified accepted IDs")
                extras.update(accepted_reference=copy.deepcopy(p.get("activation_ref")), accepted_digest=digest(accepted.__dict__))
            self._generation("graph", graph, sources, receipt, **extras)
            return graph
        if op == "graph-diff":
            old, new = self._retained(p["old_graph_id"], "graph"), self._fresh(p["graph_id"], "graph")
            receipt["graphGenerations"] = [p["old_graph_id"], p["graph_id"]]
            receipt["comparisonScope"] = "historical-to-current derived graphs"
            return self._invoke(op, copy.deepcopy(old["value"]), copy.deepcopy(new["value"]))
        if op == "reflect":
            require(p.get("memory_dir") is not None, "MEMORY_SCOPE", "Explicit owned work-memory directory required")
            memory = Path(p["memory_dir"]).resolve()
            require(memory.is_relative_to(self.artifacts) and memory.is_dir(), "MEMORY_SCOPE", "Work-memory must be an owned supplier artifact")
            require(not any(path.is_symlink() for path in memory.rglob("*")), "MEMORY_SCOPE", "Work-memory symlinks are not admitted")
            settings = self._settings(p, {"half_life_days", "min_corroboration"})
            receipt["settings"] = json_safe(settings)
            receipt["limitations"].append("Reflected work-memory lessons are derivative, not independent original evidence.")
            output = directory / "lessons.md"
            result = self._invoke(op, memory, output, **settings)
            require(output.is_file() and not output.is_symlink(), "EXPORT_READBACK", "Native reflection output missing")
            raw = output.read_bytes()
            receipt["artifacts"].append({"path": str(output), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
            return result
        item = self._fresh(p["graph_id"], "graph")
        # No downstream native analyzer or exporter owns the retained build
        # generation. Preserve every original attribute without stripping it.
        graph = copy.deepcopy(item["value"])
        receipt["graphGeneration"], receipt["view"] = p["graph_id"], item["view"]
        receipt["sourceBindings"] = item["dependencies"]
        # Native text query cannot establish which passage supports a claim.
        receipt["portableContext"] = {"scope": "retained-graph inventory, not selected-result evidence",
                                      "nodes": [self._mapping({"id": nid, **attrs}, item["dependencies"]) for nid, attrs in graph.nodes(data=True)]}
        allowed = {
            "cluster": {"resolution", "exclude_hubs_percentile"}, "important-nodes": {"top_n", "exclude_hubs_percentile"},
            "surprising-connections": {"top_n"}, "suggest-questions": {"top_n", "community_labels"},
            "import-cycles": {"max_cycle_length", "top_n"}, "impact": {"relations", "depth"},
            "query": {"mode", "depth", "token_budget", "context_filters"}, "path": {"max_hops", "undirected"},
            "node": set(), "neighbors": set(), "label-communities": set(), "cohesion": set(),
            "export-json": {"force", "built_at_commit", "community_labels"}, "export-canvas": {"community_labels", "node_filenames"},
            "export-obsidian": {"community_labels", "cohesion"}, "export-svg": {"community_labels", "figsize"},
            "export-graphml": set(), "export-cypher": set(),
        }[op]
        settings = self._settings(p, allowed)
        receipt["settings"] = json_safe(settings)
        communities = copy.deepcopy(p.get("communities", item.get("communities", {})))
        if op == "cluster":
            result = self._invoke(op, graph, **settings)
            item["communities"] = copy.deepcopy(result)
            return result
        if op in {"label-communities", "cohesion", "surprising-connections"}:
            return self._invoke(op, graph, communities=communities, **settings)
        if op == "suggest-questions":
            return self._invoke(op, graph, communities=communities, **{"community_labels": {}, **settings})
        if op in {"important-nodes", "import-cycles"}:
            return self._invoke(op, graph, **settings)
        if op == "impact":
            return self._invoke(op, graph, p["seed"], **settings)
        if op == "query":
            require(settings.get("mode", "bfs") in {"bfs", "dfs"}, "QUERY_MODE", "Native BFS or DFS required")
            require(type(settings.get("depth", 3)) is int and 1 <= settings.get("depth", 3) <= 6, "QUERY_BOUND", "Bounded traversal required")
            require(type(settings.get("token_budget", 2000)) is int and 1 <= settings.get("token_budget", 2000) <= 100000,
                    "QUERY_BOUND", "Bounded native query context required")
            require(isinstance(p.get("question"), str) and 0 < len(p["question"]) <= 8192, "QUERY_BOUND", "Bounded query text required")
            return self._read_graph_native(op, graph, directory, receipt, p["question"], **settings)
        if op == "path":
            return self._read_graph_native(op, graph, directory, receipt, {"source": p["source"], "target": p["target"], **settings})
        if op in {"node", "neighbors"}:
            node_id, message = self._read_graph_native(op, graph, directory, receipt, p["label"])
            receipt["nativeLookup"] = json_safe((node_id, message))
            ids = [node_id] if node_id is not None else []
            if message is not None:
                receipt["limitations"].append("Native lookup returned no unique winner; its original ambiguity/no-match message is retained.")
            return [{"id": nid, "attributes": copy.deepcopy(graph.nodes[nid]),
                     "neighbors": list(graph.adj[nid].items()) if op == "neighbors" else None} for nid in ids]
        suffix = {"export-json": "json", "export-cypher": "cypher", "export-canvas": "canvas", "export-graphml": "graphml", "export-svg": "svg", "export-obsidian": "obsidian"}[op]
        if op == "export-graphml":
            receipt["limitations"].append("Native GraphML omits underscore-prefixed node/edge markers, converts non-scalar fields to strings and sanitizes XML-illegal characters; original native attributes remain in the retained graph/captures.")
        destination = directory / f"native.{suffix}"
        if op == "export-cypher":
            native = self._invoke(op, graph, str(destination), **settings)
        elif op == "export-obsidian":
            native = self._invoke(op, graph, communities, str(destination), **settings)
        else:
            native = self._invoke(op, graph, communities, str(destination), **settings)
        files = list(destination.rglob("*")) if destination.is_dir() else [destination]
        artifacts = []
        for path in files:
            require(not path.is_symlink() and path.resolve().is_relative_to(directory), "EXPORT_SCOPE", "Native export escaped owned destination")
            if path.is_file():
                raw = path.read_bytes()
                artifacts.append({"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        require(artifacts, "EXPORT_READBACK", "Native export did not produce readable artifacts")
        receipt["artifacts"].extend(artifacts)
        if op == "export-json":
            item["native_json"] = artifacts[0]
        return {"nativeReturn": native, "exports": artifacts}
