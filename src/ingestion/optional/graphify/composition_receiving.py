"""Private existing-host step receipt receiving. No native dispatch or canonical.

Evidence eligibility and a selected operation's actual host receipt are separate.
The trusted host owns both callbacks; caller JSON cannot supply their authority.
"""
from __future__ import annotations
import copy
import fcntl
import hashlib
import json
import os
import stat
import uuid
from pathlib import Path
from graphify_supplier import SupplierError, digest, json_safe, require
from query_receiving import _reference


def _read_artifact(supplier, directory, artifact):
    require(isinstance(artifact, dict) and set(artifact) == {"path", "sha256", "bytes"},
            "COMPOSITION_ARTIFACT", "Original artifact descriptor required")
    path = Path(artifact["path"])
    require(path.parent == directory and not directory.is_symlink()
            and directory.parent == supplier.artifacts and not supplier.artifacts.is_symlink()
            and path.is_file() and not path.is_symlink(), "COMPOSITION_ARTIFACT", "Original owned artifact required")
    # Original op-directory files only; no symlink traversal at any open step.
    root_fd = os.open(supplier.artifacts, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory_fd, file_fd = None, None
    try:
        directory_fd = os.open(directory.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        before = os.fstat(file_fd)
        require(stat.S_ISREG(before.st_mode), "COMPOSITION_ARTIFACT", "Regular original artifact required")
        with os.fdopen(file_fd, "rb", closefd=False) as stream:
            raw = stream.read()
        after = os.fstat(file_fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                "ARTIFACT_DRIFT", "Original artifact changed during readback")
    finally:
        if file_fd is not None: os.close(file_fd)
        if directory_fd is not None: os.close(directory_fd)
        os.close(root_fd)
    require(len(raw) == artifact["bytes"] and hashlib.sha256(raw).hexdigest() == artifact["sha256"],
            "ARTIFACT_DRIFT", "Original artifact differs from retained receiving")
    return json.loads(raw)


def receive_composition(supplier, received_query, *, receipt_bridge, verify_receipt_bridge):
    """Receive exact retained query output through actual existing host receipts.

    Returns an explicit unreceived result with original output/unknown costs on a
    host callback or late freshness failure. It never substitutes a supplier hash
    for a receipt owner. The JS binding retains that result on its error cause.
    """
    require(callable(receipt_bridge) and callable(verify_receipt_bridge), "COMPOSITION_OWNER",
            "Actual host receipt bridge and independent verifier required")
    require(supplier.lock.acquire(blocking=False), "WRITER_BUSY", "A supplier operation owns receiving")
    lease, details, directory = None, None, None
    try:
        lease = (supplier.artifacts / ".writer.lock").open("a+b")
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SupplierError("WRITER_BUSY", "Another process owns this supplier destination") from exc
        received = json_safe(copy.deepcopy(received_query))
        require(isinstance(received, dict) and isinstance(received.get("receivingArtifact"), dict),
                "COMPOSITION_RECEIVING", "Exact retained query receiving required")
        directory = Path(received["receivingArtifact"]["path"]).parent
        original = _read_artifact(supplier, directory, received["receivingArtifact"])
        require(original.get("envelope") == {k: v for k, v in received.items() if k != "receivingArtifact"},
                "COMPOSITION_RECEIVING", "Original receiving envelope readback must agree")
        operation_id = original["queryOperationId"]
        query = supplier.read_capture(operation_id)["receipt"]
        context = original["queryBinding"]
        require(directory == supplier.artifacts / operation_id and query["operation"] == "query"
                and query["status"] == "complete" and received["provider"] == "graphify"
                and received["generation"] == context["generation"] == query["graphGeneration"]
                and context["sourceBindings"] == query["sourceBindings"]
                and received["artifactRef"] == context["queryArtifact"]
                and isinstance(received["hits"], list) and isinstance(received["unresolved"], list),
                "COMPOSITION_RECEIVING", "Original successful query/source/generation required")
        native = _read_artifact(supplier, directory, context["queryArtifact"])
        original_query_receipt = _read_artifact(supplier, directory, context["queryReceiptArtifact"])
        require(query == original_query_receipt and received["usage"] == query.get("usage"),
                "COMPOSITION_RECEIVING", "Original query receipt and usage must agree")
        payload = {**copy.deepcopy(received), "nativeOperation": "query", "nativeResult": native,
                   "sourceBindings": copy.deepcopy(context["sourceBindings"]),
                   "supplierQueryReceipt": copy.deepcopy(context["queryReceiptArtifact"]),
                   "supplierReceivingReceipt": copy.deepcopy(received["receivingArtifact"]),
                   "evidenceReceiptRef": copy.deepcopy(received["receiptRef"]), "receiptRef": None,
                   "queryUsage": copy.deepcopy(query.get("usage")),
                   "usage": {"query": {"receiptArtifact": copy.deepcopy(context["queryReceiptArtifact"]),
                                        "usage": copy.deepcopy(query.get("usage")), "assurance": query.get("usageAssurance")},
                             "receiving": {"artifact": copy.deepcopy(received["receivingArtifact"]), "usage": None},
                             "bridge": {"usage": None}},
                   "semanticAcceptance": "existing-owner-only", "canonicalMutation": False}
        details = {"operation": "receive-composition", "queryOperationId": operation_id,
                   "generationId": context["generation"], "outcome": "composition-envelope-unreceived",
                   "originalQueryEnvelope": copy.deepcopy(received), "envelope": payload,
                   "supplierQueryReceipt": copy.deepcopy(context["queryReceiptArtifact"]),
                   "supplierReceivingReceipt": copy.deepcopy(received["receivingArtifact"]),
                   "receiptBridgeOriginal": None, "hostVerificationOriginal": None,
                   "authority": "none", "canonicalMutation": False}
        for name in ("historyDigest", "activationRef"):
            if name in context: payload[name] = copy.deepcopy(context[name])
        try:
            supplier._fresh(context["generation"], "graph")
            bridged = json_safe(receipt_bridge(copy.deepcopy(payload), copy.deepcopy(query), copy.deepcopy(original)))
            details["receiptBridgeOriginal"] = copy.deepcopy(bridged)
            require(isinstance(bridged, dict) and _reference(bridged.get("receiptRef"))
                    and _reference(bridged.get("bridgeReceipt")) and "usage" in bridged,
                    "COMPOSITION_RECEIPT", "Original actual host step/bridge receipts and known or unknown usage required")
            # This local exact-value guard is not owner authentication. It refuses
            # listed paths and bare/sha256:-prefixed lower-case content hashes;
            # other aliases/case/format variants remain the actual verifier's job.
            identifiers = {digest(query), digest(original), digest(native), digest(payload)}
            artifacts = query["artifacts"] + [context["queryReceiptArtifact"], received["receivingArtifact"]]
            for artifact in artifacts:
                identifiers.update((artifact["path"], artifact["sha256"], "sha256:" + artifact["sha256"]))
            for name in ("receiptRef", "bridgeReceipt"):
                reference = bridged[name]
                require(reference["id"] not in identifiers and reference["id"].removeprefix("sha256:") not in identifiers
                        and reference["digest"] not in identifiers
                        and reference["digest"].removeprefix("sha256:") not in identifiers,
                        "COMPOSITION_RECEIPT", "Supplier artifact digests cannot become existing host receipts")
            binding = {"provider": "graphify", "generation": context["generation"],
                       "sourceBindings": copy.deepcopy(context["sourceBindings"]),
                       "queryArtifact": copy.deepcopy(context["queryArtifact"]),
                       "queryReceiptArtifact": copy.deepcopy(context["queryReceiptArtifact"]),
                       "receivingArtifact": copy.deepcopy(received["receivingArtifact"]),
                       "envelopeDigest": digest(payload), "receiptRef": copy.deepcopy(bridged["receiptRef"]),
                       "bridgeReceipt": copy.deepcopy(bridged["bridgeReceipt"]), "bridgeUsage": copy.deepcopy(bridged["usage"])}
            for name in ("historyDigest", "activationRef"):
                if name in context: binding[name] = copy.deepcopy(context[name])
            verdict = json_safe(verify_receipt_bridge(copy.deepcopy(binding), copy.deepcopy(payload), copy.deepcopy(bridged)))
            details["hostVerificationOriginal"] = copy.deepcopy(verdict)
            require(isinstance(verdict, dict) and verdict.get("binding") == binding
                    and verdict.get("verified") is True and verdict.get("current") is True,
                    "COMPOSITION_BRIDGE_UNVERIFIED", "Independent existing host must bind exact original query/receiving/source/generation/envelope/receipts")
            supplier._fresh(context["generation"], "graph")
            require(supplier.read_capture(operation_id)["receipt"] == query
                    and _read_artifact(supplier, directory, received["receivingArtifact"]) == original
                    and _read_artifact(supplier, directory, context["queryReceiptArtifact"]) == query,
                    "ARTIFACT_DRIFT", "Original query or receiving changed during host receipt receiving")
            payload.update(receiptRef=copy.deepcopy(bridged["receiptRef"]), bridgeReceipt=copy.deepcopy(bridged["bridgeReceipt"]),
                           receiptAssurance="explicit-verified-existing-host-bridge")
            payload["usage"]["bridge"] = {"receiptRef": copy.deepcopy(bridged["bridgeReceipt"]), "usage": copy.deepcopy(bridged["usage"])}
            details["outcome"] = "composition-envelope-received"
        except BaseException as exc:
            details["error"] = {"type": type(exc).__name__, "code": getattr(exc, "code", "COMPOSITION_HOST_FAILURE")}
            # Original potentially stale hits remain diagnostic under the original
            # envelope. Refused bridging cannot provide any composition hit.
            payload["hits"] = []
            payload["receiptRef"] = None
            payload["unresolved"].append({"reason": details["error"]["code"], "type": type(exc).__name__})
            if isinstance(details["receiptBridgeOriginal"], dict):
                payload["usage"]["bridge"] = {"receiptRef": copy.deepcopy(details["receiptBridgeOriginal"].get("bridgeReceipt")),
                                               "usage": copy.deepcopy(details["receiptBridgeOriginal"].get("usage"))}
            if not isinstance(exc, Exception):
                # Control signals remain control signals; preserve originals and
                # costs, capture cancellation if possible, then let finally clean
                # both leases before the same exception reaches the host.
                details["controlSignal"] = {"type": type(exc).__name__, "propagated": True}
                try:
                    details["compositionArtifact"] = supplier._write(directory, f"composition-{uuid.uuid4().hex}.json", details)
                except BaseException as capture_error:
                    details["captureError"] = {"type": type(capture_error).__name__, "code": getattr(capture_error, "code", "CAPTURE_FAILURE")}
                exc.receipt = copy.deepcopy(details)
                raise
        capture = supplier._write(directory, f"composition-{uuid.uuid4().hex}.json", details)
        return {**details, "compositionArtifact": capture}
    except Exception as exc:
        if isinstance(exc, SupplierError):
            exc.receipt = copy.deepcopy(details) if details else copy.deepcopy(received_query)
            raise
        raise SupplierError("COMPOSITION_RECEIVING_FAILURE", "Host receiving failed; original custody retained", copy.deepcopy(details)) from exc
    except BaseException as exc:
        if not hasattr(exc, "receipt"):
            exc.receipt = copy.deepcopy(details) if details else copy.deepcopy(received_query)
        raise
    finally:
        if lease:
            lease.close()
        supplier.lock.release()
