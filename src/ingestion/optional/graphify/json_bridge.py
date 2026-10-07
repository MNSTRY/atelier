"""Finite JSON workflow bridge for a host-owned supplier factory.

Host module must define create_supplier() -> GraphifySupplier. This does not
choose a processor or discover credentials. The executable host module belongs
to host custody. Workflow shape is validated before importing that module.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

from graphify_supplier import GraphifySupplier, PINS, SupplierError, json_safe, require


def validate_workflow(requests) -> list[dict]:
    """Validate the complete finite transport, including later steps, before effects.

    Source admission, budgets and per-operation native settings still belong to
    the supplier/host. A valid transport never confers acceptance or authority.
    """
    require(isinstance(requests, list) and 0 < len(requests) <= 128, "WORKFLOW_BOUND", "Finite native workflow required")
    labels, count = set(), 0

    def value_shape(value, depth=0):
        nonlocal count
        count += 1
        require(depth <= 64 and count <= 100000, "WORKFLOW_BOUND", "Bounded JSON workflow required")
        if isinstance(value, dict):
            require(all(isinstance(k, str) for k in value), "WORKFLOW_SHAPE", "JSON object keys required")
            if "generationFrom" in value:
                require(set(value) == {"generationFrom"} and isinstance(value["generationFrom"], str)
                        and value["generationFrom"] in labels, "WORKFLOW_REFERENCE", "Generation must reference an earlier operation label")
            else:
                for item in value.values():
                    value_shape(item, depth + 1)
        elif isinstance(value, list):
            for item in value:
                value_shape(item, depth + 1)
        else:
            require(value is None or isinstance(value, (str, bool, int, float)), "WORKFLOW_SHAPE", "JSON scalar required")
            require(not isinstance(value, float) or math.isfinite(value), "WORKFLOW_SHAPE", "Finite JSON number required")
            require(not isinstance(value, str) or len(value) <= 1048576, "WORKFLOW_BOUND", "Bounded JSON string required")

    for request in requests:
        require(isinstance(request, dict) and {"id", "operation"} <= set(request)
                and set(request) <= {"id", "operation", "params"}, "WORKFLOW_SHAPE", "ID and operation are required")
        rid, operation = request["id"], request["operation"]
        require(isinstance(rid, str) and 0 < len(rid) <= 128 and rid not in labels,
                "WORKFLOW_REFERENCE", "Unique bounded operation label required")
        require(isinstance(operation, str), "WORKFLOW_SHAPE", "Operation name must be a string")
        require(operation in PINS["operations"], "CAPABILITY_UNSUPPORTED", "Unknown or unsupported workflow operation")
        params = request.get("params", {})
        require(isinstance(params, dict), "WORKFLOW_SHAPE", "Operation params must be an object")
        value_shape(params)
        labels.add(rid)
    # A detached JSON value prevents caller mutation during an admitted workflow.
    return json.loads(json.dumps(requests, allow_nan=False))


def _portable(value):
    return json.loads(json.dumps(json_safe(value), sort_keys=True, ensure_ascii=False, allow_nan=False))


def _error_receipt(receipt):
    try:
        return _portable(receipt)
    except BaseException as exc:
        # Retain useful existing receipt identities without pretending an unknown
        # result was transported. Earlier successful snapshots are unaffected.
        safe = {"transportState": "receipt-serialization-failed", "errorType": type(exc).__name__,
                "authority": "none", "canonicalMutation": False}
        if isinstance(receipt, dict):
            for key in ("operationId", "operation", "status", "generationId", "rootIdentity"):
                if isinstance(receipt.get(key), str):
                    safe[key] = receipt[key]
            for key in ("artifacts", "nativeExecution", "error"):
                try:
                    safe[key] = _portable(receipt.get(key))
                except BaseException:
                    pass
        return safe


def run_workflow(supplier: GraphifySupplier, requests: list[dict]) -> dict:
    completed, receipts = {}, []
    try:
        requests = validate_workflow(requests)
    except BaseException as exc:
        return {"status": "failed", "completed": [], "executionState": "workflow-not-started",
                "error": {"code": getattr(exc, "code", "WORKFLOW_VALIDATION_FAILURE"), "type": type(exc).__name__},
                "authority": "none", "canonicalMutation": False}

    def bind(value):
        if isinstance(value, dict) and set(value) == {"generationFrom"}:
            previous = completed[value["generationFrom"]]
            require(isinstance(previous.get("generationId"), str), "WORKFLOW_REFERENCE", "Earlier operation did not create a generation")
            return previous["generationId"]
        if isinstance(value, list):
            return [bind(x) for x in value]
        if isinstance(value, dict):
            return {k: bind(v) for k, v in value.items()}
        return value

    for request in requests:
        rid, receipt, invoked, returned = request["id"], None, False, False
        try:
            params = bind(request.get("params", {}))
            invoked = True
            receipt = supplier.call(request["operation"], params)
            returned = True
            snapshot = _portable(receipt)
            require(isinstance(snapshot, dict) and snapshot.get("status") in {"complete", "partial"},
                    "WORKFLOW_RECEIPT", "Supplier returned no terminal usable receipt")
        except BaseException as exc:
            current_receipt = getattr(exc, "receipt", None) or receipt
            return {"status": "failed", "completed": receipts, "failedOperation": rid,
                    "executionState": "not-started" if not invoked else "returned-transport-failed" if returned else "unknown-owned-invocation",
                    "error": {"code": getattr(exc, "code", "OWNED_INVOCATION_FAILURE"), "type": type(exc).__name__,
                              "receipt": _error_receipt(current_receipt)}, "authority": "none", "canonicalMutation": False}
        completed[rid] = snapshot
        receipts.append({"id": rid, "receipt": snapshot})
    return {"status": "partial" if any(r["receipt"]["status"] == "partial" for r in receipts) else "complete",
            "completed": receipts, "authority": "none", "canonicalMutation": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="Admitted local Python factory module")
    parser.add_argument("--request", required=True, help="Finite JSON workflow file")
    args = parser.parse_args()
    output = sys.stdout
    try:
        # No host import/factory/cache creation until the whole request is valid.
        raw = Path(args.request).read_bytes()
        require(len(raw) <= 16777216, "WORKFLOW_BOUND", "Finite request file required")
        requests = validate_workflow(json.loads(raw))
        spec = importlib.util.spec_from_file_location("atelier_graphify_host", Path(args.host).resolve())
        require(spec is not None and spec.loader is not None, "HOST_FACTORY", "Readable host factory required")
        host = importlib.util.module_from_spec(spec)
        sys.stdout = sys.stderr
        spec.loader.exec_module(host)
        supplier = host.create_supplier()
        require(isinstance(supplier, GraphifySupplier), "HOST_FACTORY", "Host must return the supplier boundary")
        result = run_workflow(supplier, requests)
    except SupplierError as exc:
        result = {"status": "failed", "completed": [], "error": {"code": exc.code, "receipt": _error_receipt(exc.receipt)},
                  "authority": "none", "canonicalMutation": False}
    except BaseException as exc:
        result = {"status": "failed", "completed": [], "error": {"code": "HOST_BRIDGE_FAILURE", "type": type(exc).__name__},
                  "authority": "none", "canonicalMutation": False}
    finally:
        sys.stdout = output
    # run_workflow has already encoded each receipt independently; a later owned
    # invocation/encoding failure cannot erase earlier completed portable receipts.
    print(json.dumps(result, sort_keys=True, ensure_ascii=False, allow_nan=False))
    return {"complete": 0, "failed": 1, "partial": 2}[result["status"]]


if __name__ == "__main__":
    raise SystemExit(main())
