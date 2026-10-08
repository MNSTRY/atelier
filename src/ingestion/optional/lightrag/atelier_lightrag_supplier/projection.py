"""Derived native projection of the actual semantic runner project() result.

Canonical acceptance/identity remains with the host's existing knowledge runner.
Opaque IDs are native-normalization-safe. Native traversal stays undirected.
"""
from __future__ import annotations

import hashlib
import re
from .artifacts import digest, encoded, portable


def record_ref(value):
    if not (isinstance(value, dict) and isinstance(value.get("id"), str)
            and re.fullmatch(r"sha256:[a-f0-9]{64}", value.get("digest", ""))):
        raise ValueError("An exact existing harnessRef {id,digest} is required")
    return portable(value)


def opaque(kind, value):
    return "ATELIER_" + kind + "_" + hashlib.sha256(encoded(value)).hexdigest().upper()


def build_projection(project, *, profile="assertion-incidence"):
    if (project.get("schema") != "atelier-knowledge-graph-proposal@v1"
            or project.get("semanticProfile") != "atelier.semantic-operation-profile/v0"
            or project.get("canonicalMutation") is not False or project.get("authority") != "none"):
        raise ValueError("The existing runner semantic projection profile is required")
    if profile not in {"assertion-incidence", "semantic-adjacency"}:
        raise ValueError("Declare a supported projection profile")
    result = {"chunks": [], "entities": [], "relationships": []}
    mapping = {"entities": {}, "assertions": {}, "roles": {}, "chunks": {}}
    losses = ["Native traversal is undirected; resolve direction from retained assertion records",
              "Native summaries, weights and edits do not establish canonical truth",
              "Native chunk IDs hash content: identical quote chunks can coalesce; exact evidence remains retained",
              "Native entity/assertion source links use their first evidence alias; all evidence remains retained and indexed as chunks"]
    entity_by_candidate, entity_by_record, seen_records = {}, {}, set()
    for item in project.get("semanticEntities", []):
        ref, candidate = record_ref(item["record"]), portable(item["candidate"])
        if ref["id"] in seen_records or candidate["id"] in entity_by_candidate:
            raise ValueError("Semantic entity identities are ambiguous")
        seen_records.add(ref["id"])
        name = opaque("ENTITY", ref)
        entity_by_candidate[candidate["id"]] = name
        entity_by_record[(ref["id"], ref["digest"])] = name
        mapping["entities"][name] = {"record": ref, "candidate": candidate}
        aliases = []
        for index, evidence in enumerate(candidate.get("evidence", [])):
            if not isinstance(evidence.get("quote"), str) or not evidence.get("quote"):
                raise ValueError("Entity evidence needs its actual located quote")
            alias = opaque("EVIDENCE", {"entity": ref, "index": index, "evidence": evidence})
            aliases.append(alias)
            mapping["chunks"][alias] = {"entity": ref, "evidence": evidence}
            result["chunks"].append({"content": evidence["quote"], "source_id": alias,
                "file_path": evidence.get("ref", "retained-evidence:" + alias), "chunk_order_index": index})
        if not aliases:
            losses.append("Entity " + ref["id"] + " has no native chunk source; exact canonical identity reference remains retained")
        result["entities"].append({"entity_name": name, "entity_type": candidate["type"],
            "description": encoded({"label": candidate["label"], "record": ref,
                                    "identity": candidate.get("identity")}).decode(),
            "source_id": aliases[0] if aliases else ""})

    adjacency_pairs = {}
    for item in project.get("semanticAssertions", []):
        ref, candidate = record_ref(item["record"]), portable(item["candidate"])
        if ref["id"] in seen_records:
            raise ValueError("Duplicate canonical assertion record")
        seen_records.add(ref["id"])
        evidence = candidate.get("evidence", [])
        if not evidence:
            raise ValueError("An assertion requires retained located evidence")
        aliases = []
        for index, evidence_item in enumerate(evidence):
            if not isinstance(evidence_item.get("quote"), str) or not evidence_item.get("quote"):
                raise ValueError("The actual candidate's exact evidence quote is required")
            alias = opaque("EVIDENCE", {"assertion": ref, "index": index, "evidence": evidence_item})
            aliases.append(alias)
            mapping["chunks"][alias] = {"assertion": ref, "evidence": evidence_item}
            result["chunks"].append({"content": evidence_item["quote"], "source_id": alias,
                                     "file_path": evidence_item.get("ref", "retained-evidence:" + alias),
                                     "chunk_order_index": index})

        # Endpoints returned by the real runner use resolved canonical records.
        # A source-local candidate ID is not a canonical identity decision.
        endpoints = item.get("endpoints", {})
        participants = []
        for role, field in [("subject", "subjectId"), ("object", "objectId")]:
            if candidate.get(field) is None:
                continue
            endpoint = endpoints.get(role)
            if endpoint is None:
                raise ValueError("The runner's resolved endpoint record is required")
            endpoint = record_ref(endpoint)
            name = entity_by_record.get((endpoint["id"], endpoint["digest"]))
            if name is None:
                # Existing identities can resolve outside selected semanticEntities.
                # Do not invent their type/label; host must hydrate them explicitly.
                hydrated = project.get("resolvedEntities", [])
                selected = [entity for entity in hydrated if entity.get("record") == endpoint]
                if len(selected) != 1:
                    raise ValueError("A resolved canonical endpoint needs exact owner-hydrated identity data")
                entity = selected[0]
                name = opaque("ENTITY", endpoint)
                entity_by_record[(endpoint["id"], endpoint["digest"])] = name
                mapping["entities"][name] = portable(entity)
                result["entities"].append({"entity_name": name, "entity_type": entity["type"],
                    "description": encoded({"label": entity["label"], "record": endpoint}).decode()})
                losses.append("Hydrated endpoint " + endpoint["id"] + " has no native source chunk; authority stays in exact canonical record")
            participants.append((role, name, endpoint))
        assertion_name = opaque("ASSERTION", ref)
        mapping["assertions"][assertion_name] = portable(item)
        description = encoded({"record": ref, "candidate": candidate,
                               "endpoints": endpoints}).decode()
        if profile == "assertion-incidence":
            result["entities"].append({"entity_name": assertion_name, "entity_type": "DERIVED_ASSERTION",
                                       "description": description, "source_id": aliases[0]})
            for role, entity_name, endpoint in participants:
                role_name = opaque("ROLE", {"assertion": ref, "role": role})
                mapping["roles"][role_name] = {"assertion": ref, "role": role, "entity": endpoint}
                result["entities"].append({"entity_name": role_name, "entity_type": "DERIVED_ROLE_BINDING",
                    "description": encoded(mapping["roles"][role_name]).decode(), "source_id": aliases[0]})
                for source, target in [(assertion_name, role_name), (role_name, entity_name)]:
                    result["relationships"].append({"src_id": source, "tgt_id": target,
                        "description": description, "keywords": candidate["predicate"] + "," + role,
                        "source_id": aliases[0], "weight": 1.0})
        else:
            if len(participants) != 2 or participants[0][1] == participants[1][1]:
                losses.append("Adjacency omitted native edge for unary/self assertion " + ref["id"])
                continue
            pair = tuple(sorted([participants[0][1], participants[1][1]]))
            adjacency_pairs.setdefault(pair, []).append(ref)
            result["relationships"].append({"src_id": participants[0][1], "tgt_id": participants[1][1],
                "description": description, "keywords": candidate["predicate"],
                "source_id": aliases[0], "weight": 1.0})
    if profile == "semantic-adjacency":
        losses.append("Adjacency coalesces direction, predicates, negation, modality and time on a native pair")
        for pair, refs in adjacency_pairs.items():
            if len(refs) > 1:
                losses.append("Native pair collapses assertions: " + ",".join(ref["id"] for ref in refs))
    # Ensure entities have native source aliases when exact assertion evidence is available.
    for entity in result["entities"]:
        entity.setdefault("source_id", "")
    return {"custom_kg": result, "mapping": mapping, "profile": profile,
            "canonicalProjection": portable(project), "inputDigest": digest(project),
            "losses": losses, "authority": "none", "canonicalMutation": False,
            "nativeWeightMeaning": "native evidence floor/boost, never semantic confidence"}
