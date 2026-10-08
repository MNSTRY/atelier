"""Host-injected async LightRAG supplier, bound to the inspected Python SDK.

No SDK import, model client, network transport, credential lookup or canonical
write lives here. Use one instance/loop/workspace per derived generation.
"""
from __future__ import annotations

import asyncio
import copy
import inspect
import re
import time
from .artifacts import digest, encoded, portable
from .projection import build_projection

UPSTREAM_COMMIT = "453dce83d6d0354a06e46c8d4029a0895c4e054b"
QUERY_FIELDS = frozenset({"mode", "only_need_context", "only_need_prompt", "response_type",
    "stream", "top_k", "chunk_top_k", "max_entity_tokens", "max_relation_tokens",
    "max_total_tokens", "hl_keywords", "ll_keywords", "conversation_history", "user_prompt",
    "enable_rerank", "include_references", "disable_user_prompt_prefix"})
ENQUEUE_FIELDS = frozenset({"input", "ids", "file_paths", "track_id", "docs_format",
    "parse_engine", "process_options", "chunk_options", "admission_token", "from_scan"})
ROLES = frozenset({"EXTRACT", "KEYWORD", "QUERY", "VLM", "EMBEDDING", "RERANK"})
CAPABILITIES = {
    "document-pipeline": ["apipeline_enqueue_documents", "apipeline_process_enqueue_documents"],
    "fixed-token-insert": ["ainsert"],
    "accepted-projection": ["ainsert_custom_kg"],
    "retrieval": ["aquery_data"], "native-answer": ["aquery_llm"],
    "exploration": ["get_graph_labels", "get_knowledge_graph", "get_entity_info", "get_relation_info"],
    "draft-edit": ["aedit_entity", "aedit_relation", "acreate_entity", "acreate_relation",
                   "amerge_entities", "adelete_by_entity", "adelete_by_relation"],
    "document-maintenance": ["get_processing_status", "aget_docs_by_track_id", "aget_docs_by_ids",
                             "adelete_by_doc_id"],
    "native-export": ["aexport_data"],
    "storage-lifecycle": ["initialize_storages", "finalize_storages"],
    "host-bindings": ["graceful-pipeline-cancel", "final-multimodal-readback", "source-eligibility",
                      "projection-readback", "generation-cleanup", "vector-rebuild",
                      "canonical-citation-hydration", "canonical-citation-eligibility",
                      "parser-services", "sdk-construction", "native-server-ui"],
}
# Metadata describing native settings, never provider configuration itself.
SETTINGS_FAMILIES = {
    "storage": ["working_dir", "workspace", "kv_storage", "vector_storage", "graph_storage",
                "doc_status_storage", "vector_db_storage_cls_kwargs", "pipeline_require_strict_storage_reads"],
    "models": ["role_llm_configs", "llm_model_func", "embedding_func", "rerank_model_func",
               "llm_model_kwargs", "llm_model_max_async", "default_llm_timeout"],
    "parse-and-chunk": ["chunking_func", "chunk_token_size", "chunk_overlap_token_size",
                        "max_parallel_parse_native", "max_parallel_parse_mineru", "max_parallel_parse_docling",
                        "addon_params", "max_parallel_analyze", "queue_size_parse"],
    "extraction": ["kg_extraction_validator", "max_parallel_insert", "force_llm_summary_on_merge",
                   "enable_llm_cache_for_entity_extract", "enable_llm_cache"],
    "embedding-and-rerank": ["embedding_batch_num", "embedding_func_max_async", "embedding_cache_config",
                            "default_embedding_timeout", "rerank_model_max_async", "default_rerank_timeout",
                            "min_rerank_score"],
    "graph": ["max_graph_nodes", "related_chunk_number", "kg_chunk_pick_method"],
}


class SupplierError(Exception):
    def __init__(self, code, message, *, receipt=None):
        super().__init__(message)
        self.code, self.receipt = code, receipt


async def called(function, *args, **kwargs):
    value = function(*args, **kwargs)
    return await value if inspect.isawaitable(value) else value


def required(condition, code, message):
    if not condition:
        raise SupplierError(code, message)


def usage_report(usage):
    fields = {"inputTokens", "outputTokens", "cost", "currency", "elapsedMs", "retries"}
    value = {field: None for field in fields}
    if usage is not None:
        required(isinstance(usage, dict) and set(usage) <= fields, "USAGE_INVALID", "Declared usage fields required")
        value.update(usage)
    for field in ["inputTokens", "outputTokens", "elapsedMs", "retries"]:
        required(value[field] is None or (type(value[field]) is int and 0 <= value[field] <= 9007199254740991),
                 "USAGE_INVALID", "Counts must be nonnegative safe integers or unknown")
    cost = value["cost"]
    required(cost is None or (type(cost) in {int, float} and cost >= 0), "USAGE_INVALID", "Cost is unknown or nonnegative")
    required(value["currency"] is None or re.fullmatch(r"[A-Z]{3}", value["currency"]) is not None,
             "USAGE_INVALID", "An explicit currency or unknown is required")
    portable(value)
    return value


class LightRAGSupplier:
    def __init__(self, *, native=None, native_factory=None, query_param_factory, artifacts, generation_id, workspace,
                 source_bindings, configuration, eligibility, readback, verify_readback,
                 document_mapper=None, final_reconciler=None, assessment=None,
                 verify_accepted_projection=None, cancel_pipeline=None, reconcile_native=None,
                 cleanup_generation=None, rebuild_vectors=None):
        required(bool(generation_id) and bool(workspace), "BINDING_INVALID", "An owned generation/workspace is required")
        required(bool(source_bindings), "BINDING_INVALID", "Existing source bindings are required")
        required((native is None) != (native_factory is None), "BINDING_INVALID", "Inject one native instance or one host-owned factory")
        if native is not None:
            required(getattr(native, "workspace", None) == workspace, "BINDING_INVALID", "Injected native workspace differs")
        self.native, self.query_param_factory, self.artifacts = native, query_param_factory, artifacts
        self.native_factory = native_factory
        self.eligibility, self.readback, self.verify_readback = eligibility, readback, verify_readback
        self.document_mapper, self.final_reconciler, self.assessment = document_mapper, final_reconciler, assessment
        self.verify_accepted_projection = verify_accepted_projection
        self.cancel_pipeline, self.reconcile_native = cancel_pipeline, reconcile_native
        self.cleanup_generation, self.rebuild_vectors = cleanup_generation, rebuild_vectors
        self.generation = {"generationId": generation_id, "workspace": workspace,
            "sourceBindings": portable(source_bindings), "configuration": portable(configuration),
            "configurationDigest": digest(configuration), "upstreamCommit": UPSTREAM_COMMIT,
            "view": None, "state": "new", "publication": None, "trackIds": [], "nativeDocuments": {},
            "projection": None, "readback": None, "losses": [], "canonicalMutation": False,
            "authority": "none", "nativeQualification": "not-established-by-supplier"}
        self.captures, self.filtered_captures, self.usage, self.receipts = [], [], [], []
        self._loop, self._active, self._lock, self._hook_failure = None, None, asyncio.Lock(), None
        self._manifest_ref = None
        # LightRAG dataclasses.asdict deep-copies bound methods and their owner.
        # A plain closure keeps this callback's live supplier/loop custody intact.
        async def native_quality_hook(chunk_key, chunk_text, maybe_nodes, maybe_edges):
            return await self.quality_hook(chunk_key, chunk_text, maybe_nodes, maybe_edges)
        self._native_quality_hook = native_quality_hook

    def capabilities(self):
        return {"tool": "lightrag", "upstreamCommit": UPSTREAM_COMMIT,
                "native": {family: {method: callable(getattr(self.native, method, None)) for method in methods}
                           for family, methods in CAPABILITIES.items() if family != "host-bindings"},
                "hostRequired": CAPABILITIES["host-bindings"], "settingsFamilies": SETTINGS_FAMILIES,
                "queryFields": sorted(QUERY_FIELDS), "canonicalMutation": False}

    def snapshot(self):
        return portable({"schema": "atelier.private-lightrag-generation/v0", "generation": self.generation,
                         "captures": self.captures, "filteredCaptures": self.filtered_captures,
                         "usage": self.usage, "receipts": self.receipts})

    @property
    def manifest_ref(self):
        return copy.deepcopy(self._manifest_ref)

    def capture_bundle(self):
        return copy.deepcopy({"unfiltered": self.captures, "filtered": self.filtered_captures,
                              "rawProducerEvents": self.usage})

    def _persist(self):
        self._manifest_ref = self.artifacts.put_json("generation-manifest", self.snapshot())
        return self._manifest_ref

    def _receipt(self, operation, outcome, **details):
        receipt = portable({"tool": "lightrag", "generationId": self.generation["generationId"],
            "workspace": self.generation["workspace"], "operation": operation, "outcome": outcome,
            "semanticAcceptance": "pending" if self.generation["view"] != "accepted-projection" else "owner-records-only",
            "canonicalMutation": False, "authority": "none", **details})
        self.receipts.append(receipt)
        receipt["artifact"] = self.artifacts.put_json("operation-receipt", receipt)
        self._persist()
        return copy.deepcopy(receipt)

    def _assert_loop(self):
        required(self._loop is asyncio.get_running_loop(), "LIFECYCLE_INVALID", "Use the storage's original event loop")

    async def _current(self):
        result = portable(await called(self.eligibility, copy.deepcopy(self.generation)))
        self.artifacts.put_json("eligibility-readback", result)
        required(result.get("current") is True and result.get("sourceBindings") == self.generation["sourceBindings"],
                 "GENERATION_STALE", "Current exact eligible source bindings are required")
        if self.generation["projection"]:
            project = self.artifacts.read_json(self.generation["projection"])["canonicalProjection"]
            required(result.get("historyDigest") == project["historyDigest"] and result.get("activation") == project["activation"],
                     "GENERATION_STALE", "Accepted projection history/activation changed")
        return result

    async def initialize(self):
        required(self.generation["state"] == "new", "LIFECYCLE_INVALID", "Initialize once per native generation")
        self._loop = asyncio.get_running_loop()
        self.generation["state"] = "initializing"
        self._persist()  # Write intent before touching native storage.
        try:
            await self._current()
            if self.native is None:
                self.native = await called(self.native_factory, configuration=copy.deepcopy(self.generation["configuration"]),
                                           quality_hook=self._native_quality_hook, instrument_role=self.instrument_role)
                required(getattr(self.native, "workspace", None) == self.generation["workspace"], "BINDING_INVALID", "Host-created native workspace differs")
            existing = getattr(self.native, "kg_extraction_validator", None)
            required(existing is None or existing in (self.quality_hook, self._native_quality_hook), "HOOK_CUSTODY", "An existing native validator must be composed by its host")
            await called(self.native.initialize_storages)
            # The pinned _build_global_config reads this callable dynamically.
            # Host must inject a dedicated native instance; existing hooks cannot be silently replaced.
            self.native.kg_extraction_validator = self._native_quality_hook
            await self._current()
            self.generation["state"] = "initialized"
            return self._receipt("initialize", "complete")
        except BaseException as error:
            self.generation["state"] = "recovery-required"
            receipt = self._receipt("initialize", "execution-unknown", failureType=type(error).__name__)
            if isinstance(error, asyncio.CancelledError):
                raise
            raise SupplierError("INITIALIZE_FAILED", "Native initialization requires reconciliation", receipt=receipt) from error

    async def finalize(self):
        self._assert_loop()
        required(self._active is None, "OPERATION_BUSY", "Settle the operation before storage finalization")
        async with self._lock:
            required(self._active is None, "OPERATION_BUSY", "Settle the operation before storage finalization")
            if self.generation["state"] == "finalized":
                return self._receipt("finalize", "already-finalized", deletionVerified=False)
            required(self.native is not None and self.generation["state"] not in {"new", "initializing", "removing", "removed"},
                     "LIFECYCLE_INVALID", "Storage custody must exist before finalization")
            self._active = "finalize"
            self.generation.update(state="finalizing", publication=None)
            self._persist()
            try:
                await called(self.native.finalize_storages)
                self.generation["state"] = "finalized"
                return self._receipt("finalize", "complete", deletionVerified=False)
            except BaseException as error:
                self.generation["state"] = "recovery-required"
                receipt = self._receipt("finalize", "execution-unknown", failureType=type(error).__name__, deletionVerified=False)
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise SupplierError("FINALIZE_FAILED", "Native finalization did not establish cleanup", receipt=receipt) from error
            finally:
                self._active = None

    async def reopen(self, manifest_ref):
        """Reopen retained artifacts, never assume a saved intent did not execute."""
        required(self.generation["state"] == "new", "LIFECYCLE_INVALID", "Reopen into a fresh host-owned native instance")
        saved = self.artifacts.read_json(manifest_ref)
        required(saved.get("schema") == "atelier.private-lightrag-generation/v0", "MANIFEST_INVALID", "Supplier manifest required")
        for key in ["generationId", "workspace", "sourceBindings", "configurationDigest", "upstreamCommit"]:
            required(saved["generation"].get(key) == self.generation[key], "MANIFEST_INVALID", "Exact generation/configuration/source binding required")
        self.generation = copy.deepcopy(saved["generation"])
        self.captures, self.usage, self.receipts = saved["captures"], saved["usage"], saved["receipts"]
        self.filtered_captures = saved.get("filteredCaptures", [])
        self.generation.update(state="recovery-required", publication=None)
        self._loop = asyncio.get_running_loop()
        self._persist()
        try:
            if self.native is None:
                self.native = await called(self.native_factory, configuration=copy.deepcopy(self.generation["configuration"]),
                                           quality_hook=self._native_quality_hook, instrument_role=self.instrument_role)
                required(getattr(self.native, "workspace", None) == self.generation["workspace"], "BINDING_INVALID", "Host-created native workspace differs")
            existing = getattr(self.native, "kg_extraction_validator", None)
            required(existing is None or existing in (self.quality_hook, self._native_quality_hook), "HOOK_CUSTODY", "Host must compose existing hook")
            await called(self.native.initialize_storages)
            self.native.kg_extraction_validator = self._native_quality_hook
            return self._receipt("reopen", "custody-unknown", previousManifest=manifest_ref,
                                 nextAction="host-reconcile-before-query-resume-or-rebuild")
        except BaseException as error:
            receipt = self._receipt("reopen", "execution-unknown", failureType=type(error).__name__)
            if isinstance(error, asyncio.CancelledError):
                raise
            raise SupplierError("REOPEN_FAILED", "Native storage reopening requires reconciliation", receipt=receipt) from error

    async def quality_hook(self, chunk_key, chunk_text, maybe_nodes, maybe_edges):
        """Capture first, assess copies, prune rejected endpoints including implicit nodes."""
        capture = {"chunk_key": chunk_key, "chunk_text": chunk_text,
            "generationId": self.generation["generationId"], "workspace": self.generation["workspace"],
            "sourceBindings": self.generation["sourceBindings"], "configurationDigest": self.generation["configurationDigest"],
            "nodes": copy.deepcopy(maybe_nodes),
            "edges": [{"endpoints": list(key), "records": copy.deepcopy(records)} for key, records in maybe_edges.items()],
            "authority": "none", "stage": "post-native-normalization-and-gleaning-pre-merge",
            "losses": ["Earlier normalization may already have coalesced distinctions",
                       "Multimodal additions occur after this hook and require final reconciliation"]}
        try:
            raw = self.artifacts.put_json("unfiltered-chunk-candidates", capture)
            self.captures.append(raw)
            decision = {"rejected_names": [], "rejected_edges": [], "assessments": []}
            if self.assessment is not None:
                decision = portable(await called(self.assessment, copy.deepcopy(capture)))
            required(isinstance(decision, dict) and set(decision) == {"rejected_names", "rejected_edges", "assessments"},
                     "HOOK_POLICY_INVALID", "Explicit rejection/assessment fields are required")
            required(isinstance(decision["rejected_names"], list) and all(isinstance(x, str) for x in decision["rejected_names"]),
                     "HOOK_POLICY_INVALID", "Native normalized rejected names must be a list")
            required(isinstance(decision["rejected_edges"], list) and all(isinstance(x, list) and len(x) == 2 and
                     all(isinstance(n, str) for n in x) for x in decision["rejected_edges"]),
                     "HOOK_POLICY_INVALID", "Native rejected edges must identify exact endpoint pairs")
            rejected, edges = set(decision["rejected_names"]), {tuple(x) for x in decision["rejected_edges"]}
            nodes = {name: copy.deepcopy(records) for name, records in maybe_nodes.items() if name not in rejected}
            kept = {key: copy.deepcopy(records) for key, records in maybe_edges.items()
                    if not any(endpoint in rejected for endpoint in key) and key not in edges}
            filtered = {"raw": raw, "decision": decision, "nodes": nodes,
                "edges": [{"endpoints": list(key), "records": records} for key, records in kept.items()],
                "implicitEndpoints": sorted({name for key in kept for name in key if name not in nodes}),
                "semanticAcceptance": "pending", "authority": "none"}
            self.filtered_captures.append(self.artifacts.put_json("filtered-chunk-candidates", filtered))
            self._persist()
            return nodes, kept
        except BaseException as error:
            self._hook_failure = {"failureType": type(error).__name__, "chunk_key": chunk_key,
                                  "rawRetained": len(self.captures)}
            self.artifacts.put_json("hook-failure", self._hook_failure)
            raise

    def instrument_role(self, role, function, *, model_id, request_binding, usage_reader=None,
                        response_serializer=None):
        """Host chooses/binds actual native model/embedding/rerank callable; result stays native.

        request_binding must emit permitted prompt/input/source/cache references and
        must exclude transport kwargs/credentials. Unknown usage remains null.
        response_serializer is a host-owned, explicit artifact serializer for
        native arrays/other non-JSON results. It never changes the native return.
        """
        required(role in ROLES and bool(model_id), "ROLE_INVALID", "Declare a native role and exact model/embedding identity")

        async def wrapper(*args, **kwargs):
            self._assert_loop()
            required(self.generation["state"] in {"initializing", "initialized", "indexing", "indexed", "published"},
                     "GENERATION_INELIGIBLE", "Role execution requires a live eligible native generation")
            await self._current()
            binding = portable(await called(request_binding, args, kwargs))
            request = self.artifacts.put_json("role-request", {"role": role, "model": model_id,
                "binding": binding, "generationId": self.generation["generationId"]})
            start = time.monotonic()
            raw, recorded = None, False
            try:
                result = await called(function, *args, **kwargs)
                # Do not serialize/consume a provider stream as if it were a complete response.
                if hasattr(result, "__aiter__"):
                    return self._capture_role_stream(result, role, model_id, request, start, usage_reader)
                artifact_value = await called(response_serializer, result) if response_serializer else result
                raw = self.artifacts.put_bytes("role-raw-response", artifact_value.encode("utf-8") if isinstance(artifact_value, str)
                                               else artifact_value if isinstance(artifact_value, bytes) else encoded(artifact_value))
                usage = await called(usage_reader, result) if usage_reader else None
                self._record_usage(role, model_id, request, raw, start, usage, "complete")
                recorded = True
                await self._current()
                return result
            except BaseException as error:
                if not recorded:
                    self._record_usage(role, model_id, request, raw, start, None, "failed-or-partial", type(error).__name__)
                raise
        return wrapper

    def _record_usage(self, role, model_id, request, raw, start, usage, outcome, failure_type=None):
        event = {"role": role, "model": model_id, "request": request, "rawOutput": raw,
                 "outcome": outcome, "usage": usage_report(usage), "measurement": "host-reported",
                 "wrapperElapsedMs": round((time.monotonic() - start) * 1000), "failureType": failure_type}
        self.usage.append(event)
        self.artifacts.put_json("role-usage", event)
        self._persist()

    async def _capture_role_stream(self, iterator, role, model_id, request, start, usage_reader):
        fragments, outcome = [], "interrupted-or-partial"
        try:
            async for fragment in iterator:
                raw = self.artifacts.put_bytes("role-stream-fragment", fragment.encode() if isinstance(fragment, str) else encoded(fragment))
                fragments.append(raw)
                await self._current()
                yield fragment
            outcome = "complete"
        finally:
            if hasattr(iterator, "aclose"):
                await iterator.aclose()
            ref = self.artifacts.put_json("role-stream-capture", {"fragments": fragments, "outcome": outcome})
            usage = await called(usage_reader, None) if usage_reader and outcome == "complete" else None
            self._record_usage(role, model_id, request, ref, start, usage, outcome)

    def record_cache_hit(self, *, role, model_id, binding, raw_output_ref, cache_ref, usage=None):
        required(role in ROLES and raw_output_ref and cache_ref, "CACHE_BINDING_INVALID", "Retained raw/cache references required")
        self.artifacts.read_bytes(raw_output_ref)
        event = {"role": role, "model": model_id, "binding": portable(binding), "rawOutput": raw_output_ref,
                 "cacheRef": portable(cache_ref), "cacheHit": True, "usage": usage_report(usage),
                 "measurement": "host-reported-cache-event", "outcome": "cache-hit"}
        self.usage.append(event)
        return self._receipt("cache-capture", "retained", event=event)

    def cost_summary(self, start_index=0):
        events = self.usage[start_index:]
        result = {}
        for role in sorted(ROLES):
            calls = [event for event in events if event["role"] == role]
            currencies = {event["usage"]["currency"] for event in calls if event["usage"]["cost"] is not None}
            result[role] = {"observedEvents": len(calls), "cost": None, "currency": None,
                "inputTokens": None, "outputTokens": None,
                "coverage": "instrumented-events-only; absence does not prove zero provider work"}
            if calls and all(event["usage"]["cost"] is not None for event in calls) and len(currencies) == 1 and None not in currencies:
                result[role].update(cost=sum(event["usage"]["cost"] for event in calls), currency=next(iter(currencies)))
            for field in ["inputTokens", "outputTokens"]:
                if calls and all(event["usage"][field] is not None for event in calls):
                    result[role][field] = sum(event["usage"][field] for event in calls)
        return result

    async def _write(self, operation, action, *, require_current=True):
        self._assert_loop()
        async with self._lock:
            required(self._active is None, "OPERATION_BUSY", "One operation owns this generation")
            required(self.generation["state"] in {"initialized", "indexed", "published"},
                     "RECOVERY_REQUIRED", "Reconcile the generation before another write")
            if require_current:
                await self._current()
            self._active, self._hook_failure = operation, None
            self.generation.update(state="indexing", publication=None)
            self._persist()
            try:
                result = await action()
                required(self._hook_failure is None, "HOOK_FAILED", "A hook failure prevents publishing partial native work")
                if require_current:
                    await self._current()
                self.generation["state"] = "indexed"
                return self._receipt(operation, "complete", **result)
            except BaseException as error:
                self.generation.update(state="recovery-required", publication=None)
                receipt = self._receipt(operation, "failed-or-partial", failureType=type(error).__name__,
                    hookFailure=self._hook_failure, rawCaptures=self.captures, nativeFailure=getattr(error, "receipt", None),
                    recovery="host-reconcile-before-resume-or-rebuild")
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise SupplierError(getattr(error, "code", "NATIVE_OPERATION_FAILED"),
                                    "Native work failed or may be partial; retained receipts require reconciliation", receipt=receipt) from error
            finally:
                self._active = None

    async def ingest(self, **options):
        required(set(options) <= ENQUEUE_FIELDS and "input" in options, "OPTIONS_INVALID", "Pinned enqueue options required")
        required(self.generation["view"] in {None, "native-exploration"}, "VIEW_CONFLICT", "Use a separate native-exploration generation")
        required(self.document_mapper is not None and self.final_reconciler is not None,
                 "HOST_BINDING_REQUIRED", "Native document mapping and multimodal reconciliation required")
        # IDs select RAW semantics even when docs_format says pending_parse.
        effective = "raw" if options.get("ids") is not None else options.get("docs_format", "raw")
        self.generation["view"] = "native-exploration"
        async def action():
            request = self.artifacts.put_json("enqueue-request", {k: v for k, v in options.items() if k != "admission_token"})
            track = await called(self.native.apipeline_enqueue_documents, **options)
            required(isinstance(track, str) and track, "NATIVE_RESULT_INVALID", "Enqueue returns a track ID, not document IDs")
            self.generation["trackIds"].append(track)
            self._persist()
            await called(self.native.apipeline_process_enqueue_documents)
            documents = portable(await called(self.native.aget_docs_by_track_id, track_id=track))
            required(bool(documents) and all(doc.get("status") == "processed" for doc in documents.values()),
                     "NATIVE_DOCUMENTS_PARTIAL", "Every selected native document must report processed")
            mapping = portable(await called(self.document_mapper, documents, self.generation["sourceBindings"]))
            required(set(mapping) == set(documents), "DOCUMENT_MAPPING_INVALID", "Map actual native document IDs exactly")
            required(all(binding in self.generation["sourceBindings"] for binding in mapping.values()),
                     "DOCUMENT_MAPPING_INVALID", "Native documents must resolve to existing exact source bindings")
            self.generation["nativeDocuments"].update(mapping)
            final = portable(await called(self.readback, self.native, copy.deepcopy(self.generation)))
            final_ref = self.artifacts.put_json("final-native-output", final)
            self.generation["readback"] = final_ref
            reconciliation = portable(await called(self.final_reconciler, final, self.capture_bundle()))
            required(reconciliation.get("reconciled") is True and reconciliation.get("endpointConsistency") == "verified"
                     and reconciliation.get("postHookAdditionsReviewed") is True,
                     "MULTIMODAL_RECONCILIATION_REQUIRED", "Final post-hook native additions and endpoint consistency require explicit reconciliation")
            self.generation["losses"] = reconciliation.get("losses", [])
            return {"request": request, "trackId": track, "documents": documents, "documentMapping": mapping,
                    "effectiveDocsFormat": effective, "nativeOutput": final_ref, "reconciliation": reconciliation,
                    "costs": self.cost_summary()}
        return await self._write("native-ingest", action)

    async def fixed_token_insert(self, **options):
        allowed = {"input", "split_by_character", "split_by_character_only", "ids", "file_paths", "track_id"}
        required(set(options) <= allowed and "input" in options, "OPTIONS_INVALID", "Pinned ainsert options required")
        required(self.generation["view"] in {None, "native-exploration"}, "VIEW_CONFLICT", "Separate native generation required")
        required(self.document_mapper is not None and self.final_reconciler is not None,
                 "HOST_BINDING_REQUIRED", "Native document mapping and multimodal reconciliation required")
        self.generation["view"] = "native-exploration"
        async def action():
            track = portable(await called(self.native.ainsert, **options))
            required(isinstance(track, str) and bool(track), "NATIVE_RESULT_INVALID", "ainsert returns an actual track ID")
            self.generation["trackIds"].append(track)
            documents = portable(await called(self.native.aget_docs_by_track_id, track_id=track))
            required(bool(documents) and all(doc.get("status") == "processed" for doc in documents.values()),
                     "NATIVE_DOCUMENTS_PARTIAL", "Selected documents must report processed")
            mapping = portable(await called(self.document_mapper, documents, self.generation["sourceBindings"]))
            required(set(mapping) == set(documents) and all(binding in self.generation["sourceBindings"] for binding in mapping.values()),
                     "DOCUMENT_MAPPING_INVALID", "Map actual native IDs to exact existing source bindings")
            self.generation["nativeDocuments"].update(mapping)
            final = portable(await called(self.readback, self.native, copy.deepcopy(self.generation)))
            self.generation["readback"] = self.artifacts.put_json("final-native-output", final)
            reconciliation = portable(await called(self.final_reconciler, final, self.capture_bundle()))
            required(reconciliation.get("reconciled") is True and reconciliation.get("endpointConsistency") == "verified"
                     and reconciliation.get("postHookAdditionsReviewed") is True,
                     "MULTIMODAL_RECONCILIATION_REQUIRED", "Final post-hook reconciliation required")
            self.generation.update(losses=reconciliation.get("losses", []))
            return {"trackId": track, "documents": documents, "documentMapping": mapping, "chunking": "F",
                    "nativeOutput": self.generation["readback"], "reconciliation": reconciliation}
        return await self._write("fixed-token-insert", action)

    async def import_accepted(self, project, *, profile="assertion-incidence"):
        required(self.generation["view"] is None and self.generation["state"] == "initialized",
                 "VIEW_CONFLICT", "Accepted import requires a new isolated generation")
        required(self.verify_accepted_projection is not None, "HOST_BINDING_REQUIRED", "Existing knowledge-owner verification required")
        project = portable(project)
        authority = portable(await called(self.verify_accepted_projection, project))
        required(authority.get("current") is True and authority.get("historyDigest") == project.get("historyDigest")
                 and authority.get("activation") == project.get("activation") and authority.get("inputDigest") == digest(project),
                 "ACCEPTANCE_BINDING_INVALID", "Owner must verify exact currently accepted active records and endpoint decisions")
        projection = build_projection(project, profile=profile)
        self.generation.update(view="accepted-projection", projection=self.artifacts.put_json("accepted-projection-input", projection),
                               losses=projection["losses"])
        async def action():
            await called(self.native.ainsert_custom_kg, custom_kg=projection["custom_kg"],
                         full_doc_id="projection:" + self.generation["generationId"])
            native_output = portable(await called(self.readback, self.native, copy.deepcopy(self.generation)))
            self.generation["readback"] = self.artifacts.put_json("final-native-output", native_output)
            return {"profile": profile, "projection": self.generation["projection"],
                    "nativeOutput": self.generation["readback"], "losses": projection["losses"],
                    "recoveryGuarantee": "no-document-journal; reconcile-or-rebuild-isolated-generation"}
        return await self._write("accepted-kg-import", action)

    async def publish(self):
        self._assert_loop()
        async with self._lock:
            required(self.generation["state"] == "indexed" and self.generation["readback"] is not None,
                     "GENERATION_INCOMPLETE", "A complete generation and final readback are required")
            await self._current()
            snapshot = self.artifacts.read_json(self.generation["readback"])
            check = portable(await called(self.verify_readback, copy.deepcopy(self.generation), snapshot))
            required(check.get("valid") is True and check.get("generationId") == self.generation["generationId"],
                     "READBACK_FAILED", "Host must verify normalization, mapping, completeness and storage readback")
            await self._current()
            self.generation.update(state="published", publication=self.artifacts.put_json("publication-readback", check))
            return self._receipt("publish", "eligible-derived-generation", verification=check)

    async def _query(self, operation, query, options, generation_id, *, system_prompt=None, progress_callback=None,
                     stream_consumer=None, allow_ungrounded=False):
        self._assert_loop()
        async with self._lock:
            required(generation_id == self.generation["generationId"] and self.generation["state"] == "published",
                     "GENERATION_INELIGIBLE", "Select the exact completed published generation")
            required(set(options) <= QUERY_FIELDS, "OPTIONS_INVALID", "Pinned QueryParam fields required")
            if options.get("mode") == "bypass":
                required(allow_ungrounded and self.generation["view"] == "native-exploration", "UNGROUNDED_REFUSED", "Explicit ungrounded exploration is required")
            await self._current()
            start = len(self.usage)
            parameter = self.query_param_factory(**portable(options))
            self._active = operation
            self.generation["operationIntent"] = self.artifacts.put_json("native-query-intent",
                {"operation": operation, "query": query, "options": options, "systemPrompt": system_prompt,
                 "generationId": generation_id, "sourceBindings": self.generation["sourceBindings"]})
            self._persist()
            raw, partial_artifacts = None, []
            try:
                if operation == "retrieve":
                    result = await called(self.native.aquery_data, query=query, param=parameter)
                else:
                    # Exactly one native retrieval+answer route. Never prequery aquery_data.
                    result = await called(self.native.aquery_llm, query=query, param=parameter,
                                          system_prompt=system_prompt, progress_callback=progress_callback)
                if operation == "answer" and result.get("llm_response", {}).get("is_streaming"):
                    response = dict(result["llm_response"])
                    iterator = response.pop("response_iterator")
                    if stream_consumer is None:
                        if hasattr(iterator, "aclose"):
                            await iterator.aclose()
                        required(False, "STREAM_CONSUMER_REQUIRED", "A host consumer is required to settle streaming output")
                    header = {**result, "llm_response": response}
                    partial_artifacts.append(self.artifacts.put_json("native-answer-header", header))
                    fragments, completed = [], False
                    try:
                        async for fragment in iterator:
                            ref = self.artifacts.put_bytes("native-answer-fragment", fragment.encode() if isinstance(fragment, str) else encoded(fragment))
                            fragments.append(ref)
                            await self._current()
                            await called(stream_consumer, fragment)
                        completed = True
                    finally:
                        if hasattr(iterator, "aclose"):
                            await iterator.aclose()
                        partial_artifacts.append(self.artifacts.put_json("native-answer-stream", {"fragments": fragments, "complete": completed}))
                    result = {**header, "streamFragments": fragments, "streamComplete": completed}
                result = portable(result)
                raw = self.artifacts.put_json("native-" + operation + "-result", result)
                await self._current()  # Withdrawal during retrieval refuses result delivery.
                return self._receipt(operation, "complete" if result.get("status") == "success" else "native-failure",
                    nativeResult=result, nativeArtifact=raw, costs=self.cost_summary(start), view=self.generation["view"],
                    grounded=options.get("mode") != "bypass", projectionMapping=self.generation["projection"],
                    losses=self.generation["losses"], publicationArtifact=self.generation["publication"],
                    generationReadback=self.generation["readback"], citationScope={"provider": "lightrag", "generationId": generation_id})
            except BaseException as error:
                receipt = self._receipt(operation, "failed-or-partial", failureType=type(error).__name__, costs=self.cost_summary(start),
                                        nativeArtifact=raw, partialArtifacts=partial_artifacts)
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise SupplierError(getattr(error, "code", "QUERY_FAILED"), "Native query failed or became ineligible", receipt=receipt) from error
            finally:
                self._active = None

    async def retrieve(self, query, *, generation_id, options=None, allow_ungrounded=False):
        return await self._query("retrieve", query, options or {}, generation_id, allow_ungrounded=allow_ungrounded)

    async def answer(self, query, *, generation_id, options=None, system_prompt=None,
                     progress_callback=None, stream_consumer=None, allow_ungrounded=False):
        return await self._query("answer", query, options or {}, generation_id, system_prompt=system_prompt,
            progress_callback=progress_callback, stream_consumer=stream_consumer, allow_ungrounded=allow_ungrounded)

    async def _read_native(self, operation, generation_id, action, *, states=frozenset({"initialized", "indexed", "published"})):
        """Serialize a read against all supplier writes, retaining failed delivery.

        A busy read refuses immediately; it never observes an unfinished writer or
        implicitly waits for that writer to become a different eligible revision.
        """
        start, details = len(self.usage), {"requestedGenerationId": generation_id}
        async def preflight():
            self._assert_loop()
            required(generation_id == self.generation["generationId"], "GENERATION_INELIGIBLE", "Select this exact native generation")
            required(self._active is None, "OPERATION_BUSY", "Settle active native work before inspection, export or receiving")
            required(not self._lock.locked(), "OPERATION_BUSY", "Do not wait through an unfinished writer's eligibility/readback window")
            required(self.native is not None and self.generation["state"] in states,
                     "GENERATION_INELIGIBLE", "Inspection/export requires initialized, settled native custody")
        try:
            await preflight()
            selection = digest(self.generation)
            async with self._lock:
                # We own the lock here. Recheck the binding/custody, without
                # mistaking this operation's own lock for an active writer.
                required(generation_id == self.generation["generationId"] and self._active is None
                         and self.native is not None and self.generation["state"] in states and digest(self.generation) == selection,
                         "GENERATION_INELIGIBLE", "Exact settled generation must still hold under the read lock")
                self._active = operation
                revision = digest(self.generation)
                try:
                    current = await self._current()
                    details["eligibilityBefore"] = self.artifacts.put_json("read-eligibility-before", current)
                    await action(details)
                    current = await self._current()
                    required(digest(self.generation) == revision and generation_id == self.generation["generationId"],
                             "GENERATION_INELIGIBLE", "The selected native revision changed during read/export")
                    details["eligibilityAfter"] = self.artifacts.put_json("read-eligibility-after", current)
                    return self._receipt(operation, details.pop("outcome", "complete"), costs=self.cost_summary(start), **details)
                finally:
                    self._active = None
        except BaseException as error:
            receipt = self._receipt(operation, "failed-or-partial", failureType=type(error).__name__,
                failureCode=getattr(error, "code", None), costs=self.cost_summary(start),
                nativeFailure=getattr(error, "receipt", None), **{key: value for key, value in details.items() if key != "outcome"})
            if isinstance(error, asyncio.CancelledError):
                raise
            raise SupplierError(getattr(error, "code", "NATIVE_READ_FAILED"), "Native read/export or receiving refused or failed", receipt=receipt) from error

    async def inspect_native(self, method, *, generation_id, **options):
        required(method in CAPABILITIES["exploration"] + ["get_processing_status", "aget_docs_by_track_id", "aget_docs_by_ids"],
                 "METHOD_INVALID", "Use an inspected native inspection method")
        async def action(details):
            value = portable(await called(getattr(self.native, method), **options))
            details.update(nativeResult=value, nativeArtifact=self.artifacts.put_json("native-inspection", value),
                           projectionMapping=self.generation["projection"])
        return await self._read_native(method, generation_id, action)

    async def receive_citations(self, query_receipt, *, generation_id, hydrate_citations, verify_citations):
        """Receive existing canonical located evidence through its actual host owner.

        Raw LightRAG reference numbers/paths never become evidenceRef, identity or
        acceptance. Host callbacks must retain the real mapping/eligibility proof.
        """
        async def action(details):
            required(query_receipt in self.receipts and query_receipt.get("operation") in {"retrieve", "answer"}
                     and query_receipt.get("outcome") == "complete" and query_receipt.get("grounded") is True
                     and query_receipt.get("generationId") == generation_id
                     and query_receipt.get("publicationArtifact") == self.generation["publication"]
                     and query_receipt.get("generationReadback") == self.generation["readback"],
                     "CITATION_QUERY_INVALID", "Use this generation's retained successful grounded query receipt")
            result = self.artifacts.read_json(query_receipt["nativeArtifact"])
            required(result == query_receipt["nativeResult"], "CITATION_QUERY_INVALID", "Exact retained query readback required")
            references = result.get("data", {}).get("references", [])
            details.update(queryArtifact=query_receipt["nativeArtifact"], queryReceipt=query_receipt["artifact"],
                           nativeReferences=references, projectionMapping=self.generation["projection"],
                           publicationArtifact=self.generation["publication"], generationReadback=self.generation["readback"])
            mapping = portable(await called(hydrate_citations, copy.deepcopy(self.generation), copy.deepcopy(query_receipt),
                                             copy.deepcopy(result), copy.deepcopy(self.generation["projection"])))
            details["mappingArtifact"] = self.artifacts.put_json("host-citation-mapping", mapping)
            required(isinstance(mapping.get("mappingReceipt"), dict) and isinstance(mapping["mappingReceipt"].get("id"), str)
                     and bool(mapping["mappingReceipt"]["id"])
                     and re.fullmatch(r"sha256:[a-f0-9]{64}", mapping["mappingReceipt"].get("digest", "")),
                     "CITATION_MAPPING_REQUIRED", "Retain the existing canonical owner's mapping receipt")
            mappings = mapping.get("mappings")
            required(isinstance(mappings, list) and isinstance(references, list),
                     "CITATION_MAPPING_REQUIRED", "Existing located evidence mappings are required")
            hits = []
            for entry in mappings:
                required(isinstance(entry, dict) and entry.get("nativeReference") in references
                         and isinstance(entry.get("evidence"), list) and bool(entry["evidence"]),
                         "CITATION_MAPPING_INVALID", "Map an exact native reference to existing canonical evidence")
                for evidence in entry["evidence"]:
                    required(isinstance(evidence, dict) and all(evidence.get(field) for field in
                        ["id", "sourceId", "sourceDigest", "attemptId", "locator", "ref", "quote"])
                        and isinstance(evidence["locator"], dict) and evidence["locator"].get("kind")
                        and evidence["locator"].get("value"), "CITATION_MAPPING_INVALID", "Existing canonical evidence fields and locator required")
                    required(any(all(evidence[field] == binding.get(field) for field in ["sourceId", "sourceDigest", "attemptId"])
                                 for binding in self.generation["sourceBindings"]),
                             "CITATION_MAPPING_INVALID", "Citation origin must match a current exact canonical source binding")
                    if self.generation["projection"]:
                        retained = self.artifacts.read_json(self.generation["projection"])["mapping"]["chunks"]
                        required(any(item.get("evidence") == evidence for item in retained.values()),
                                 "CITATION_MAPPING_INVALID", "Accepted projection citations must reuse its exact retained canonical evidence")
                required(isinstance(entry.get("hits"), list) and bool(entry["hits"]),
                         "CITATION_MAPPING_INVALID", "The host must return original canonical evidenceRef hits; supplier cannot derive them")
                for hit in entry["hits"]:
                    reference = hit.get("evidenceRef") if isinstance(hit, dict) else None
                    required(isinstance(reference, dict) and set(reference) == {"sourceId", "revision", "representationId", "locator"}
                        and any(hit.get("quote") == item["quote"] and reference == {
                            "sourceId": item["sourceId"], "revision": item["sourceDigest"],
                            "representationId": item["attemptId"], "locator": item["locator"]}
                            for item in entry["evidence"]),
                        "CITATION_MAPPING_INVALID", "Original owner evidenceRef must locate the exact retained canonical quote")
                    hits.append(hit)
                required(all(any(hit["evidenceRef"]["sourceId"] == evidence["sourceId"]
                                 and hit["evidenceRef"]["revision"] == evidence["sourceDigest"]
                                 and hit["evidenceRef"]["representationId"] == evidence["attemptId"]
                                 and hit["evidenceRef"]["locator"] == evidence["locator"]
                                 and hit["quote"] == evidence["quote"] for hit in entry["hits"])
                             for evidence in entry["evidence"]),
                         "CITATION_MAPPING_INVALID", "Every retained mapped origin needs its original canonical evidenceRef hit")
            unresolved = mapping.get("unresolved", [])
            required(isinstance(unresolved, list) and all(isinstance(item, dict) and item.get("nativeReference") in references
                and isinstance(item.get("reason"), str) and bool(item["reason"]) for item in unresolved),
                "CITATION_MAPPING_INVALID", "Unresolved native references need explicit coverage and reasons")
            located_refs = {digest(item["nativeReference"]) for item in mappings}
            unresolved_refs = {digest(item["nativeReference"]) for item in unresolved}
            required(not located_refs & unresolved_refs and located_refs | unresolved_refs == {digest(item) for item in references},
                     "CITATION_MAPPING_INVALID", "Every native reference must be located or explicitly unresolved")
            verification = portable(await called(verify_citations, copy.deepcopy(self.generation), copy.deepcopy(query_receipt), copy.deepcopy(mapping)))
            details["verificationArtifact"] = self.artifacts.put_json("host-citation-verification", verification)
            required(verification.get("current") is True and verification.get("generationId") == generation_id
                     and verification.get("sourceBindings") == self.generation["sourceBindings"]
                     and verification.get("queryArtifact") == query_receipt["nativeArtifact"]
                     and verification.get("mappingDigest") == digest(mapping)
                     and verification.get("hitsDigest") == digest(hits)
                     and isinstance(verification.get("eligibilityReceipt"), dict)
                     and isinstance(verification["eligibilityReceipt"].get("id"), str) and bool(verification["eligibilityReceipt"]["id"])
                     and re.fullmatch(r"sha256:[a-f0-9]{64}", verification["eligibilityReceipt"].get("digest", "")),
                     "CITATION_ELIGIBILITY_REQUIRED", "Retain concrete existing owner eligibility for the exact canonical mapping/query")
            if self.generation["projection"]:
                project = self.artifacts.read_json(self.generation["projection"])["canonicalProjection"]
                required(verification.get("historyDigest") == project["historyDigest"] and verification.get("activation") == project["activation"],
                         "CITATION_ELIGIBILITY_REQUIRED", "Exact current canonical history and activation required")
            details.update(outcome="located-evidence-received" if hits else "no-located-evidence", locatedCitations=mappings, hits=hits,
                           unresolvedReferences=unresolved,
                           mappingReceipt=mapping["mappingReceipt"], eligibilityReceipt=verification["eligibilityReceipt"],
                           evidenceAuthority="existing-canonical-owner", acceptanceGranted=False)
        return await self._read_native("receive-citations", generation_id, action, states=frozenset({"published"}))

    async def receive_composition(self, received_receipt, *, generation_id, receipt_bridge, verify_receipt_bridge):
        """Private composer envelope received through the existing host receipt owner.

        The supplier never promotes an artifact digest to an actor/principal or
        mints receiptRef. Query and receiving usage remain separately attributed.
        """
        async def action(details):
            required(received_receipt in self.receipts and received_receipt.get("operation") == "receive-citations"
                     and received_receipt.get("outcome") in {"located-evidence-received", "no-located-evidence"}
                     and received_receipt.get("generationId") == generation_id
                     and received_receipt.get("publicationArtifact") == self.generation["publication"]
                     and received_receipt.get("generationReadback") == self.generation["readback"],
                     "COMPOSITION_RECEIVING_INVALID", "Use the exact current retained citation receiving receipt")
            original = self.artifacts.read_json(received_receipt["artifact"])
            required(original == {key: value for key, value in received_receipt.items() if key != "artifact"},
                     "COMPOSITION_RECEIVING_INVALID", "Original receiving receipt artifact readback must agree")
            queries = [item for item in self.receipts if item.get("artifact") == received_receipt["queryReceipt"]
                       and item.get("nativeArtifact") == received_receipt["queryArtifact"]
                       and item.get("operation") in {"retrieve", "answer"} and item.get("outcome") == "complete"]
            required(len(queries) == 1, "COMPOSITION_RECEIVING_INVALID", "Original supplier query receipt must be retained unambiguously")
            query = queries[0]
            usage = {"query": {"attemptArtifact": query["artifact"], "roles": query["costs"]},
                     "receiving": {"attemptArtifact": received_receipt["artifact"], "roles": received_receipt["costs"]}}
            payload = {"provider": "lightrag", "generation": generation_id, "artifactRef": received_receipt["artifact"],
                       "sourceBindings": copy.deepcopy(self.generation["sourceBindings"]),
                       "hits": received_receipt["hits"], "unresolvedReferences": received_receipt["unresolvedReferences"],
                       "usage": usage, "supplierQueryReceipt": query["artifact"], "supplierReceivingReceipt": received_receipt["artifact"],
                       "nativeArtifact": query["nativeArtifact"], "nativeResult": query["nativeResult"],
                       "nativeOperation": query["operation"],
                       "mappingReceipt": received_receipt["mappingReceipt"], "eligibilityReceipt": received_receipt["eligibilityReceipt"],
                       "semanticAcceptance": "existing-owner-only", "canonicalMutation": False}
            details.update(sourceBindings=copy.deepcopy(self.generation["sourceBindings"]),
                           supplierUsage=usage, payloadArtifact=self.artifacts.put_json("composition-receiving-payload", payload),
                           supplierQueryReceipt=query["artifact"], supplierReceivingReceipt=received_receipt["artifact"])
            bridged = portable(await called(receipt_bridge, copy.deepcopy(payload), copy.deepcopy(query), copy.deepcopy(received_receipt)))
            details.update(bridgeResult=bridged, bridgeResultArtifact=self.artifacts.put_json("host-composition-receipt-bridge", bridged))
            required(bool(bridged.get("receiptRef")) and bool(bridged.get("bridgeReceipt"))
                     and bridged["receiptRef"] not in [query["artifact"], received_receipt["artifact"],
                         query["artifact"]["artifactId"], received_receipt["artifact"]["artifactId"]],
                     "COMPOSITION_RECEIPT_REQUIRED", "Actual original host receipt reference and bridge receipt are required")
            check = portable(await called(verify_receipt_bridge, copy.deepcopy(payload), copy.deepcopy(bridged),
                                          copy.deepcopy(self.generation)))
            details["bridgeVerificationArtifact"] = self.artifacts.put_json("host-composition-receipt-verification", check)
            required(check.get("verified") is True and check.get("current") is True
                     and check.get("generation") == generation_id and check.get("envelopeDigest") == digest(payload)
                     and check.get("sourceBindings") == self.generation["sourceBindings"]
                     and check.get("receiptRef") == bridged["receiptRef"] and check.get("bridgeReceipt") == bridged["bridgeReceipt"]
                     and "bridgeUsage" in check and check["bridgeUsage"] == bridged.get("usage")
                     and check.get("supplierQueryReceipt") == query["artifact"]
                     and check.get("supplierReceivingReceipt") == received_receipt["artifact"],
                     "COMPOSITION_RECEIPT_REQUIRED", "Verify the existing host receipt against the exact envelope and original attempts")
            envelope = {**payload, "receiptRef": bridged["receiptRef"], "bridgeReceipt": bridged["bridgeReceipt"],
                        "usage": {**usage, "bridge": {"receiptRef": bridged["receiptRef"], "usage": bridged.get("usage")}},
                        "receiptAssurance": "explicit-verified-existing-host-bridge"}
            details.update(outcome="composition-envelope-received", envelope=envelope,
                           envelopeArtifact=self.artifacts.put_json("composition-received-envelope", envelope))
        return await self._read_native("receive-composition", generation_id, action, states=frozenset({"published"}))

    async def draft_edit(self, method, **options):
        required(method in CAPABILITIES["draft-edit"], "METHOD_INVALID", "An inspected draft writer is required")
        required(self.generation["view"] == "native-exploration", "ACCEPTED_VIEW_IMMUTABLE", "Edit a separate native draft generation")
        async def action():
            before = self.artifacts.put_json("draft-before", await called(self.readback, self.native, copy.deepcopy(self.generation)))
            result = portable(await called(getattr(self.native, method), **options))
            native_result = self.artifacts.put_json("draft-native-result", result)
            after = self.artifacts.put_json("draft-after", await called(self.readback, self.native, copy.deepcopy(self.generation)))
            self.generation["readback"] = after
            operation_status = (result.get("operation_summary") or {}).get("operation_status")
            if result.get("status") not in {None, "success", "not_found"} or operation_status not in {None, "success"}:
                raise SupplierError("NATIVE_EDIT_FAILED", "Native draft writer refused, failed or only partly completed",
                    receipt={"nativeResult": result, "nativeArtifact": native_result, "before": before, "after": after,
                             "semanticAcceptance": "pending", "reconciliationRequired": True})
            return {"before": before, "after": after, "nativeResult": result, "nativeArtifact": native_result,
                    "proposalDelta": {"before": before, "after": after, "method": method, "parameters": portable(options)},
                    "identityAcceptance": "pending", "semanticAcceptance": "pending"}
        return await self._write("draft-" + method, action)

    async def delete_document(self, doc_id, *, delete_llm_cache=False):
        required(self.generation["view"] == "native-exploration", "DELETE_PROFILE_INVALID", "Imported generations require whole-generation cleanup")
        required(doc_id in self.generation["nativeDocuments"], "DOCUMENT_MAPPING_INVALID", "An actual mapped native document ID is required")
        required(self.generation["state"] in {"initialized", "indexed", "published"}, "RECOVERY_REQUIRED", "Settle native custody before selective deletion")
        # Revocation blocks readers immediately, before deletion returns or fails.
        self.generation.update(publication=None, state="indexed")
        async def action():
            result = portable(await called(self.native.adelete_by_doc_id, doc_id=doc_id, delete_llm_cache=delete_llm_cache))
            raw = self.artifacts.put_json("native-deletion-result", result)
            if result.get("status") not in {"success", "not_found"}:
                raise SupplierError("DELETION_NOT_VERIFIED", "Native deletion refused or failed", receipt={"nativeResult": result, "nativeArtifact": raw})
            status = portable(await called(self.native.aget_docs_by_ids, ids=[doc_id]))
            required(not status or all(value is None for value in status.values()), "DELETION_NOT_VERIFIED", "Native document absence must be read back")
            self.generation["nativeDocuments"].pop(doc_id)
            self.generation["readback"] = None
            return {"nativeResult": result, "nativeArtifact": raw, "absenceReadback": status, "sourceAccessRevoked": "host-owned",
                    "cacheDeletion": "requested" if delete_llm_cache else "retained", "publication": "requires-rebuild-or-reconcile"}
        return await self._write("delete-document", action, require_current=False)

    async def cancel(self):
        self._assert_loop()
        required(self.cancel_pipeline is not None, "HOST_BINDING_REQUIRED", "SDK has no public cancel method; bind native workspace flag under its lock")
        result = portable(await called(self.cancel_pipeline, self.native, copy.deepcopy(self.generation)))
        return self._receipt("cancel", "requested", nativeResult=result,
                             completionVerified=False, nextAction="await-active-operation-then-reconcile")

    async def reconcile(self, *, reason):
        self._assert_loop()
        required(self._active is None, "OPERATION_BUSY", "Do not reconcile a running/unknown worker")
        required(bool(reason) and self.reconcile_native is not None, "HOST_BINDING_REQUIRED", "Explicit host reconciliation and reason required")
        async with self._lock:
            required(self._active is None, "OPERATION_BUSY", "Do not reconcile a running/unknown worker")
            required(self.generation["state"] not in {"new", "initializing", "finalizing", "removing", "removed", "finalized"},
                     "LIFECYCLE_INVALID", "Reconciliation requires open native custody")
            self._active = "reconcile"
            try:
                evidence = portable(await called(self.reconcile_native, self.native, self.snapshot(), reason))
                required(evidence.get("settled") is True and evidence.get("generationId") == self.generation["generationId"],
                         "RECOVERY_UNKNOWN", "Worker/storage custody must be settled")
                required(evidence.get("nextAction") in {"resume-enqueued", "rebuild", "readback"}, "RECOVERY_INVALID", "Declare the actual recovery path")
                if self.generation["view"] == "accepted-projection":
                    required(evidence["nextAction"] != "resume-enqueued", "RECOVERY_INVALID", "Custom KG import has no ingestion retry journal")
                if evidence["nextAction"] == "readback":
                    await self._current()
                    output = portable(await called(self.readback, self.native, copy.deepcopy(self.generation)))
                    if self.generation["view"] == "native-exploration":
                        required(self.final_reconciler is not None, "HOST_BINDING_REQUIRED", "Final native reconciliation required")
                        final = portable(await called(self.final_reconciler, output, self.capture_bundle()))
                        required(final.get("reconciled") is True and final.get("endpointConsistency") == "verified"
                                 and final.get("postHookAdditionsReviewed") is True,
                                 "MULTIMODAL_RECONCILIATION_REQUIRED", "Reopened native output requires final reconciliation")
                        self.generation["losses"] = final.get("losses", [])
                    self.generation.update(state="indexed", readback=self.artifacts.put_json("recovered-native-output", output), publication=None)
                elif evidence["nextAction"] == "resume-enqueued":
                    self.generation.update(state="initialized", publication=None)
                else:
                    self.generation.update(state="rebuild-required", publication=None)
                return self._receipt("reconcile", "settled", evidence=evidence, reason=reason)
            finally:
                self._active = None

    async def resume_enqueued(self, *, reconciliation_receipt):
        evidence = reconciliation_receipt.get("evidence", {})
        required(reconciliation_receipt in self.receipts and evidence.get("nextAction") == "resume-enqueued",
                 "RECOVERY_INVALID", "Use this generation's retained host reconciliation receipt")
        required(self.generation["view"] == "native-exploration", "RECOVERY_INVALID", "Only the document pipeline is resumable")
        recovery_id = reconciliation_receipt["artifact"]["artifactId"]
        required(recovery_id not in self.generation.get("consumedRecoveryReceipts", []),
                 "RECOVERY_INVALID", "This settlement receipt already authorized one resume")
        async def action():
            self.generation.setdefault("consumedRecoveryReceipts", []).append(recovery_id)
            self._persist()
            await called(self.native.apipeline_process_enqueue_documents)
            final = portable(await called(self.readback, self.native, copy.deepcopy(self.generation)))
            self.generation["readback"] = self.artifacts.put_json("final-native-output", final)
            reconciliation = portable(await called(self.final_reconciler, final, self.capture_bundle()))
            required(reconciliation.get("reconciled") is True and reconciliation.get("endpointConsistency") == "verified"
                     and reconciliation.get("postHookAdditionsReviewed") is True,
                     "MULTIMODAL_RECONCILIATION_REQUIRED", "Final reconciliation required")
            statuses = {}
            for track in self.generation["trackIds"]:
                docs = portable(await called(self.native.aget_docs_by_track_id, track_id=track))
                required(bool(docs) and all(doc.get("status") == "processed" for doc in docs.values()), "NATIVE_DOCUMENTS_PARTIAL", "Resumed documents are incomplete")
                mapped = portable(await called(self.document_mapper, docs, self.generation["sourceBindings"]))
                required(set(mapped) == set(docs) and all(binding in self.generation["sourceBindings"] for binding in mapped.values()),
                         "DOCUMENT_MAPPING_INVALID", "Recovered native IDs need exact source mappings")
                statuses.update(docs)
                self.generation["nativeDocuments"].update(mapped)
            self.generation.update(losses=reconciliation.get("losses", []))
            return {"documents": statuses, "reconciliation": reconciliation, "reenqueued": False}
        return await self._write("resume-enqueued", action)

    async def export_native(self, *, generation_id, output_path, file_format="csv", include_vector_data=False, export_reader):
        required(file_format in {"csv", "excel", "md", "txt"}, "OPTIONS_INVALID", "Pinned native export format required")
        from pathlib import Path
        root = self.generation["configuration"].get("ownedArtifactRoot")
        required(isinstance(root, str) and Path(root).is_absolute(), "OUTPUT_SCOPE_REQUIRED", "Host must declare its owned artifact root")
        destination = Path(output_path).resolve()
        required(destination.is_relative_to(Path(root).resolve()) and destination != Path(root).resolve(),
                 "OUTPUT_SCOPE_REQUIRED", "Export destination must be inside the owned artifact root")
        destination = str(destination)
        async def action(details):
            details.update(outputPath=destination, portableProjection=self.generation["projection"], format=file_format)
            try:
                result = portable(await called(self.native.aexport_data, output_path=destination,
                                               file_format=file_format, include_vector_data=include_vector_data))
                details.update(nativeResult=result, nativeResultArtifact=self.artifacts.put_json("native-export-result", result))
            except BaseException:
                # Preserve any partial file without replacing the original native
                # failure. The host reader must be read-only and scoped to this path.
                try:
                    details["nativeArtifact"] = portable(await called(export_reader, destination))
                except BaseException as read_error:
                    details["partialReadbackFailure"] = type(read_error).__name__
                raise
            details["nativeArtifact"] = portable(await called(export_reader, destination))
            details["outcome"] = "derived-artifact"
        return await self._read_native("native-export", generation_id, action)

    async def rebuild_embedding(self, *, embedding_identity):
        required(self.rebuild_vectors is not None, "HOST_BINDING_REQUIRED", "Bind admitted native vector rebuild tool lifecycle")
        async def action():
            result = portable(await called(self.rebuild_vectors, self.native, copy.deepcopy(self.generation), embedding_identity))
            required(result.get("verified") is True, "VECTOR_REBUILD_FAILED", "Native vector consistency readback required")
            self.generation["configuration"]["embeddingIdentity"] = portable(embedding_identity)
            self.generation["configurationDigest"] = digest(self.generation["configuration"])
            self.generation["readback"] = self.artifacts.put_json("vector-rebuild-readback", await called(self.readback, self.native, copy.deepcopy(self.generation)))
            return {"nativeResult": result, "embeddingIdentity": embedding_identity}
        return await self._write("vector-rebuild", action)

    async def remove_tool(self):
        self._assert_loop()
        required(self._active is None, "OPERATION_BUSY", "Settle/cancel active native work before removal")
        required(self.cleanup_generation is not None, "HOST_BINDING_REQUIRED", "Host owns workspace/backend/cache destruction")
        async with self._lock:
            required(self._active is None, "OPERATION_BUSY", "Settle active native work before removal")
            required(self.native is not None and self.generation["state"] not in {"new", "initializing", "finalizing", "removing", "removed"},
                     "LIFECYCLE_INVALID", "Initialized native custody is required before removal")
            self._active = "remove-tool"
            self.generation.update(publication=None, state="removing")
            self._persist()
            try:
                await called(self.native.finalize_storages)
                cleanup = portable(await called(self.cleanup_generation, self.native, copy.deepcopy(self.generation)))
                required(cleanup.get("deleted") is True and cleanup.get("generationId") == self.generation["generationId"],
                         "CLEANUP_NOT_VERIFIED", "Verify all selected native stores/cache/vector artifacts are deleted")
                self.generation["state"] = "removed"
                return self._receipt("remove-tool", "native-generation-deleted", cleanup=cleanup,
                                     canonicalKnowledge="preserved-by-existing-owner", supplierReceipts="retained")
            except BaseException as error:
                self.generation["state"] = "recovery-required"
                receipt = self._receipt("remove-tool", "cleanup-unknown", failureType=type(error).__name__)
                if isinstance(error, asyncio.CancelledError):
                    raise
                raise SupplierError("CLEANUP_NOT_VERIFIED", "Native tool removal needs host cleanup reconciliation", receipt=receipt) from error
            finally:
                self._active = None
