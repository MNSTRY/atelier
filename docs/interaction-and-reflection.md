# Interaction and Reflection

Companion supplies the qualities and behavior of an interaction. Witness offers
revisable reflection on a person, work, an interface or a system. Coaching is an
optional mode tied to a chosen intention. One host owns the conversation floor,
effects and delivery; neither role creates a second conversation or personal
profile store.

The portable `@mnstry/atelier/reflection` API validates attributed observations
and assessments, qualifies exact evidence revisions, and prepares reflective
acts. An observation reports what a source says; an assessment interprets it.
Qualification checks provenance references, scope, purpose, withdrawal and
assistance. It does not determine semantic truth, psychological state or learning.
A system-friction assessment cannot become a claim of personal incapacity.
Independent-capacity claims require independent evidence about the same person,
and still remain attributed judgments with uncertainty and limits.

Correcting or withdrawing an observation changes its reference. Dependent
assessments and queued acts then become unavailable until deliberately revised.
Several assessors may disagree. The caller retains their histories and owns
correction, withdrawal, export and retention. This module does not silently
persist a personal model, enable monitoring, erase source records or publish them.

## Typed acts and interaction policy

An act has an origin, purpose, scope, semantic meaning, wording, dependencies,
mode and expiry. Ask, explain, reflect, propose, challenge, acknowledge and repair
remain separate from delivery. A change in meaning or wording produces a changed
act digest and requires a new delivery identity rather than replaying an old ID.

Policy expresses Reflection/coaching availability, challenge, initiative,
pacing and communication criteria. The selector enforces scope, current evidence,
expiry, floor, pause and enabled modes. Clarity, warmth, candor, attribution,
uncertainty and repair are surfaced evaluation criteria. Their presence does not
prove that generated language exhibits them; representative human assessment is
still required. Ordinary work and Companion acts function with Reflection off.

`selectInteractionAct` returns selected, deferred or declined with reasons.
Selection grants no effect authority. Orientation pins for chosen intentions
and preferences come from their native owner; a name match cannot join contexts.
An empty current context supports ordinary conversation without tracking.

## Host delivery contract

`createInteractionController({authorityId, host})` requires one host with:

| Method | Responsibility |
| --- | --- |
| `current()` | Return current policy, scoped observations/assessments/orientations, interaction state and time |
| `authorize(exactAct)` | Apply the existing host effect authority to the exact act digest, scope and purpose |
| `reserve(delivery)` | Durably reserve an idempotency key and serialize access to the conversation floor; return `created` |
| `send(delivery)` | Emit the exact text, observe interruption, and retain actual partial/full native delivery state |
| `read(key)` | Read the native reservation/delivery receipt, including key, authority, act digest, status and delivered text |
| `interrupt(request)` | Stop/reconcile the native effect and retain actual partial delivery |

Reservations must be durable and exclusive across controllers and processes.
The host rechecks its own live scope, authority and floor at emission and serializes
competing deliveries. The controller's pre-send recheck is additional protection,
not a replacement for atomic host admission. No raw network sender is included.

Receipt statuses are reserved, begun, completed, interrupted, failed and unknown.
A new controller reads an existing reservation instead of emitting again. Unknown
or interrupted output requires native reconciliation; automatic retries cannot
duplicate guidance. Readback must match the exact act and actual text prefix.
Completed delivery requires the complete text, and proves neither understanding
nor improvement. Repair is a separately selected act with its own identity.

The reference tests use a file-backed host to exercise actual partial output,
interruption, repair, controller restart, changed evidence and a lost response.
This qualifies orchestration against that test adapter. Production conversation
hosts, voice output, persistent personal tracking and human communication quality
need their own adoption and acceptance evidence.
