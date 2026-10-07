"""Private current-owner receiving of retained Graphify queries, no native call.

Host callbacks return original evidence/hits/receipt references. These structures
are composition transport, not a new evidence, receipt or acceptance canonical.
"""
from __future__ import annotations
import copy
import fcntl
import hashlib
import json
import re
import uuid
from pathlib import Path
from graphify_supplier import SupplierError, digest, json_safe, require


def _reference(value):
    return (isinstance(value, dict) and set(value) == {"id", "digest"}
            and isinstance(value["id"], str) and 0 < len(value["id"]) <= 256
            and isinstance(value["digest"], str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value["digest"]))


def _selection(result, declared):
    if isinstance(declared, str):
        declared = {"pointer": declared}
    require(isinstance(declared, dict) and set(declared) <= {"pointer", "span"}
            and isinstance(declared.get("pointer"), str) and len(declared["pointer"]) <= 4096,
            "QUERY_SELECTION", "Bounded existing-result pointer required")
    pointer, value = declared["pointer"], result
    require(pointer == "" or pointer.startswith("/"), "QUERY_SELECTION", "JSON pointer required")
    for safe_name in pointer[1:].split("/") if pointer else []:
        require(not re.search(r"~(?![01])", safe_name), "QUERY_SELECTION", "Exact JSON pointer escaping required")
        safe_name = safe_name.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            require(re.fullmatch(r"0|[1-9][0-9]*", safe_name) is not None and int(safe_name) < len(value), "QUERY_SELECTION", "Selected result index absent")
            value = value[int(safe_name)]
        else:
            require(isinstance(value, dict) and safe_name in value, "QUERY_SELECTION", "Selected result member absent")
            value = value[safe_name]
    if "span" in declared:
        span = declared["span"]
        require(isinstance(value, str) and isinstance(span, dict) and set(span) == {"start", "end"}
                and type(span["start"]) is int and type(span["end"]) is int
                and 0 <= span["start"] < span["end"] <= len(value), "QUERY_SELECTION", "Exact native text span required")
        value = value[span["start"]:span["end"]]
    return {"selection": copy.deepcopy(declared), "nativeResult": copy.deepcopy(value), "nativeResultDigest": digest(value)}


def _valid_mapping(entry, selection, sources):
    require(isinstance(entry, dict) and entry.get("selection") == selection["selection"]
            and entry.get("nativeResultDigest") == selection["nativeResultDigest"], "QUERY_MAPPING_BINDING", "Mapping must bind the selected original native result")
    evidence, hit = entry.get("evidence"), entry.get("hit")
    require(isinstance(evidence, dict) and isinstance(hit, dict), "QUERY_MAPPING_MISSING", "Original owner evidence and hit are required")
    ref = hit.get("evidenceRef")
    require(isinstance(ref, dict) and set(ref) == {"sourceId", "revision", "representationId", "locator"}
            and all(isinstance(ref[k], str) and 0 < len(ref[k]) <= 256 for k in ("sourceId", "revision", "representationId"))
            and isinstance(ref["locator"], dict), "QUERY_EVIDENCE_REFERENCE", "Original composition evidence reference required")
    source = sources.get(ref["sourceId"])
    # Existing vanilla private projection uses the original evidence sourceDigest
    # as revision and its original attemptId as representationId. Native catalogue
    # revision remains a separate lifecycle binding; no new identity is inferred.
    require(source is not None and source["sourceDigest"] == ref["revision"]
            and evidence.get("sourceId") == ref["sourceId"] and evidence.get("sourceDigest") == source["sourceDigest"],
            "QUERY_MAPPING_SOURCE", "Mapping source/revision must match current native dependencies")
    require(evidence.get("schema") == "mnstry.atelier-ingestion-evidence@v1"
            and evidence.get("freshness") == "current" and evidence.get("integrity") == "verified"
            and evidence.get("readScope") == "all-plan" and evidence.get("synthesized") is False
            and evidence.get("semanticAcceptance") == "pending" and evidence.get("locator") == ref["locator"]
            and isinstance(evidence.get("ref"), str) and 0 < len(evidence["ref"]) <= 16384
            and isinstance(evidence.get("text"), str), "QUERY_EVIDENCE_UNVERIFIED", "Original current located evidence receipt required")
    locator = evidence["locator"]
    require(set(locator) == {"kind", "value"} and locator["kind"] in {"line", "csv-cell", "json-pointer"}
            and isinstance(locator["value"], str) and 0 < len(locator["value"]) <= 16384,
            "QUERY_EVIDENCE_REFERENCE", "Supported exact original owner locator required")
    require(isinstance(evidence.get("planId"), str) and bool(evidence["planId"])
            and isinstance(evidence.get("planDigest"), str) and re.fullmatch(r"[a-f0-9]{64}", evidence["planDigest"])
            and isinstance(evidence.get("attemptId"), str) and bool(evidence["attemptId"]),
            "QUERY_EVIDENCE_UNVERIFIED", "Original owner plan/digest/attempt bindings required")
    require(all(evidence.get(k) == source[k] for k in ("attemptId", "planId", "planDigest") if k in source),
            "QUERY_MAPPING_SOURCE", "Located evidence attempt/plan differs from current dependency")
    require(isinstance(source.get("attemptId"), str) and bool(source["attemptId"])
            and ref["representationId"] == evidence["attemptId"] == source["attemptId"],
            "QUERY_MAPPING_REPRESENTATION", "Original evidence representation must match its original owner attempt")
    require(isinstance(hit.get("quote"), str) and bool(hit["quote"]) and hit["quote"] in evidence["text"],
            "QUERY_QUOTE_UNVERIFIED", "Original hit quote must occur in its owner-read evidence")
    # The existing owner verifier still qualifies representation identity, exact
    # passage/current permission and canonical receipts. Shape never grants it.
    return copy.deepcopy(hit)


def receive_query(supplier, operation_id, *, selections=None):
    require(supplier.lock.acquire(blocking=False), "WRITER_BUSY", "A supplier operation owns receiving")
    lease, envelope, body, directory = None, None, None, None
    try:
        lease = (supplier.artifacts / ".writer.lock").open("a+b")
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SupplierError("WRITER_BUSY", "Another process owns this supplier destination") from exc
        receipt = supplier.read_capture(operation_id)["receipt"]
        require(receipt.get("operation") == "query" and receipt.get("status") == "complete", "QUERY_RECEIVING_SCOPE", "Existing successful retained query required")
        generation = receipt.get("graphGeneration")
        directory = supplier.artifacts / operation_id
        artifacts = [a for a in receipt["artifacts"] if Path(a["path"]).name == "result.json"]
        require(len(artifacts) == 1, "QUERY_RECEIVING_ARTIFACT", "Exactly one original retained query result required")
        artifact = copy.deepcopy(artifacts[0])
        result = json.loads(Path(artifact["path"]).read_bytes())
        original_receipt = directory / "receipt.json"
        receipt_bytes = original_receipt.read_bytes()
        receipt_artifact = {"path": str(original_receipt), "sha256": hashlib.sha256(receipt_bytes).hexdigest(), "bytes": len(receipt_bytes)}
        declared = [""] if selections is None else selections
        require(isinstance(declared, list) and 0 < len(declared) <= 128, "QUERY_SELECTION", "Finite explicit native selection required")
        selected = [_selection(result, selection) for selection in declared]
        require(len({digest(s["selection"]) for s in selected}) == len(selected), "QUERY_SELECTION_AMBIGUOUS", "Duplicate native selection is ambiguous")
        context = {"queryArtifact": artifact, "queryReceiptArtifact": receipt_artifact, "generation": generation,
                   "sourceBindings": copy.deepcopy(receipt["sourceBindings"]), "rootIdentity": supplier.root_id,
                   "epoch": receipt["epoch"], "view": receipt["view"], "nativeSelections": selected}
        envelope = {"provider": "graphify", "generation": generation, "artifactRef": artifact,
                    "hits": [], "unresolved": [], "receiptRef": None, "usage": copy.deepcopy(receipt.get("usage")),
                    "authority": "none", "canonicalMutation": False}
        body = {"queryOperationId": operation_id, "queryBinding": context, "hostMappingOriginal": None,
                "hostEligibilityOriginal": None, "envelope": envelope, "qualification": "private receiving; original canonical owners retain authority"}
        def finish():
            envelope["status"] = "received" if envelope["hits"] and not envelope["unresolved"] else "partial-received" if envelope["hits"] else "unresolved"
            capture = supplier._write(directory, f"receiving-{uuid.uuid4().hex}.json", body)
            envelope["receivingArtifact"] = capture
            return envelope
        def propagate_control(exc):
            if isinstance(exc, Exception): return
            envelope["hits"] = []
            envelope["receiptRef"] = None
            body["controlSignal"] = {"type": type(exc).__name__, "propagated": True}
            try:
                finish()
            except BaseException as capture_error:
                body["captureError"] = {"type": type(capture_error).__name__, "code": getattr(capture_error, "code", "CAPTURE_FAILURE")}
            exc.receipt = copy.deepcopy(body)
            raise exc
        try:
            item = supplier._fresh(generation, "graph")
            require(context["sourceBindings"] == item["dependencies"] and receipt["epoch"] == supplier.epoch,
                    "QUERY_RECEIVING_STALE", "Query generation/source bindings differ from current graph")
            if item.get("accepted_reference") is not None:
                build_receipt = supplier.read_capture(item["operationId"])["receipt"]
                context.update(historyDigest=build_receipt["acceptedHead"], activationRef=copy.deepcopy(item["accepted_reference"]))
        except BaseException as exc:
            envelope["unresolved"].append({"reason": getattr(exc, "code", "QUERY_RECEIVING_STALE"), "type": type(exc).__name__})
            propagate_control(exc)
            return finish()
        if not callable(supplier.query_hydrator) or not callable(supplier.query_verifier):
            envelope["unresolved"] = [{"selection": s["selection"], "reason": "current-owner-receiving-unreceived"} for s in selected]
        else:
            try:
                hydrated = json_safe(supplier.query_hydrator(copy.deepcopy(context)))
                body["hostMappingOriginal"] = hydrated
                require(isinstance(hydrated, dict) and _reference(hydrated.get("mappingReceipt"))
                        and isinstance(hydrated.get("mappings"), list), "QUERY_MAPPING_RECEIPT", "Original owner mapping receipt/mappings required")
                entries, hits = hydrated["mappings"], []
                # Hydrator may decline an exact selection. Multiple mappings for
                # the same selection remain ambiguous; there is no arbitrary winner.
                require(all(isinstance(e, dict) and e.get("selection") in [s["selection"] for s in selected] for e in entries),
                        "QUERY_MAPPING_BINDING", "Mapping includes an unselected native result")
                for selection in selected:
                    matches = [e for e in entries if e.get("selection") == selection["selection"]]
                    if len(matches) != 1:
                        envelope["unresolved"].append({"selection": selection["selection"], "reason": "mapping-absent" if not matches else "mapping-ambiguous"})
                        continue
                    try:
                        hits.append(_valid_mapping(matches[0], selection, context["sourceBindings"]))
                    except SupplierError as exc:
                        envelope["unresolved"].append({"selection": selection["selection"], "reason": exc.code})
                if hits:
                    binding = {**copy.deepcopy(context), "mappingReceipt": copy.deepcopy(hydrated["mappingReceipt"]),
                               "mappingDigest": digest(hydrated), "hitsDigest": digest(hits)}
                    # Repeat current generation/source/accepted-head checks around
                    # the existing owner's actual mapping+eligibility verification.
                    supplier._fresh(generation, "graph")
                    verdict = json_safe(supplier.query_verifier({"binding": copy.deepcopy(binding), "mapping": copy.deepcopy(hydrated), "hits": copy.deepcopy(hits)}))
                    body["hostEligibilityOriginal"] = verdict
                    require(isinstance(verdict, dict) and verdict.get("binding") == binding
                            and verdict.get("current") is True and verdict.get("permitted") is True
                            and _reference(verdict.get("eligibilityReceipt")) and _reference(verdict.get("receiptRef")),
                            "QUERY_ELIGIBILITY_UNVERIFIED", "Current owner must bind original query/source/generation/mapping/hits and eligibility receipts")
                    envelope.update(hits=hits, mappingReceipt=copy.deepcopy(hydrated["mappingReceipt"]),
                                    eligibilityReceipt=copy.deepcopy(verdict["eligibilityReceipt"]), receiptRef=copy.deepcopy(verdict["receiptRef"]))
            except BaseException as exc:
                envelope["hits"] = []
                envelope["unresolved"].append({"reason": getattr(exc, "code", "QUERY_OWNER_RECEIVING_FAILURE"), "type": type(exc).__name__})
                propagate_control(exc)
        try:
            supplier._fresh(generation, "graph")
            supplier.read_capture(operation_id)
            require(original_receipt.read_bytes() == receipt_bytes, "ARTIFACT_DRIFT", "Original query receipt changed during receiving")
        except BaseException as exc:
            envelope["hits"] = []
            envelope["receiptRef"] = None
            envelope["unresolved"].append({"reason": getattr(exc, "code", "QUERY_RECEIVING_STALE"), "type": type(exc).__name__})
            propagate_control(exc)
        # Supplemental capture uses existing owned artifact custody and links the
        # original immutable query receipt. It is not a new canonical journal.
        return finish()
    except BaseException as exc:
        if not isinstance(exc, Exception) and not hasattr(exc, "receipt"):
            exc.receipt = copy.deepcopy(body) if body is not None else {"queryOperationId": operation_id, "nativeReplay": False}
        raise
    finally:
        if lease:
            lease.close()
        supplier.lock.release()
