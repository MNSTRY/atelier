"""Private supplier artifacts. These receipts do not replace Atelier intake."""
from __future__ import annotations

import dataclasses
import hashlib
import json
from enum import Enum
from pathlib import Path


def portable(value):
    """Preserve native data fields without repr-based or lossy coercion."""
    if dataclasses.is_dataclass(value):
        value = dataclasses.asdict(value)
    elif isinstance(value, Enum):
        value = value.value
    elif hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    if value is None or isinstance(value, (str, bool, int, float)):
        # Reject NaN/Infinity, which are not portable JSON.
        json.dumps(value, allow_nan=False)
        return value
    if isinstance(value, (list, tuple)):
        return [portable(item) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: portable(item) for key, item in value.items()}
    raise TypeError("Native artifact needs a host JSON serializer; object was not discarded")


def encoded(value):
    return json.dumps(portable(value), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return "sha256:" + hashlib.sha256(encoded(value)).hexdigest()


class MemoryArtifacts:
    """Test/host injection sink; the host must retain its returned bytes."""
    def __init__(self):
        self.objects = {}

    def put_bytes(self, kind, data):
        if not isinstance(data, bytes):
            raise TypeError("Artifact bytes are required")
        sha = hashlib.sha256(data).hexdigest()
        self.objects.setdefault(sha, data)
        return {"artifactId": "sha256:" + sha, "kind": kind,
                "bytes": len(data), "storage": "host-memory"}

    def put_json(self, kind, value):
        return self.put_bytes(kind, encoded(value))

    def read_json(self, ref):
        return json.loads(self.read_bytes(ref))

    def read_bytes(self, ref):
        data = self.objects[ref["artifactId"].removeprefix("sha256:")]
        if "sha256:" + hashlib.sha256(data).hexdigest() != ref["artifactId"]:
            raise ValueError("Artifact readback digest differs")
        return data


class FileArtifacts:
    """Immutable, content addressed files under an explicitly allocated root."""
    def __init__(self, root, *, owner_root):
        self.root, owner = Path(root).resolve(), Path(owner_root).resolve()
        if not self.root.is_relative_to(owner):
            raise ValueError("Artifact root is outside the supplier allocation")
        self.root.mkdir(parents=True, exist_ok=True)

    def put_bytes(self, kind, data):
        if not isinstance(data, bytes):
            raise TypeError("Artifact bytes are required")
        sha = hashlib.sha256(data).hexdigest()
        target = self.root / (sha + ".artifact")
        try:
            with target.open("xb") as output:
                output.write(data)
                output.flush()
                import os
                os.fsync(output.fileno())
        except FileExistsError:
            if target.read_bytes() != data:
                raise ValueError("Existing artifact differs from its content address")
        return {"artifactId": "sha256:" + sha, "kind": kind,
                "bytes": len(data), "storage": "supplier-file", "path": str(target)}

    def put_json(self, kind, value):
        return self.put_bytes(kind, encoded(value))

    def read_json(self, ref):
        return json.loads(self.read_bytes(ref))

    def read_bytes(self, ref):
        target = self.root / (ref["artifactId"].removeprefix("sha256:") + ".artifact")
        data = target.read_bytes()
        if "sha256:" + hashlib.sha256(data).hexdigest() != ref["artifactId"]:
            raise ValueError("Artifact readback digest differs")
        return data
