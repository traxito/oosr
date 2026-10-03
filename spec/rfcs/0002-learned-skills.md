# RFC-0002: Skills learned by robots

| | |
|---|---|
| **Author** | Alex Montesinos |
| **Status** | Draft (open for comments for 14 days, [#6](https://github.com/traxito/oosr/issues/6)) |
| **Created** | 2026-10-03 |
| **Depends on** | RFC-0001 (Draft 0.2) |

## 1. Motivation

RFC-0001 left this question open: may a robot publish skills learned from experience? The answer
is **yes**, within limits. A robot that waters the same ficus for months learns things the nursery
cannot know: that this particular pot next to the radiator dries out in 4 days rather than 7, or
that 60 ml/l is enough. If that knowledge stays inside the robot, it is lost when the robot is
replaced, and the other robots in the home cannot use it.

The risk is obvious: a compromised or miscalibrated robot that "learns" to water every hour. This
RFC defines how to benefit from what robots learn without anything learned being able to escalate
permissions.

## 2. Principles

1. **What is learned never widens what is allowed.** A learned skill can only move within limits
   already authorized by a trusted publisher and by the household policy.
2. **Local by default.** What is learned lives in the home hub. Leaving the home requires an
   explicit act by the owner and a publisher's signature.
3. **Evidence-based.** Every adjustment references the signed events that justify it.
4. **Reversible.** The owner sees, disables and deletes anything learned from the app.

## 3. Two levels

### Level 1: parameter overlays

An overlay adjusts parameters of a task in a signed skill, **within ranges the publisher declares
as tunable**. The base manifest adds `tunable`:

```json
{
  "name": "water",
  "trigger": { "any": [{ "since_event": "oosr.task.water.completed", "gt_days": 7 }, { "measure": "soil_moisture", "lt": 0.20 }] },
  "tunable": {
    "/trigger/any/0/gt_days": { "min": 3, "max": 14 },
    "/trigger/any/1/lt": { "min": 0.12, "max": 0.28 },
    "/steps/2/volume_ml/per_pot_litre": { "min": 50, "max": 100 }
  }
}
```

Keys are JSON Pointers relative to the task. Anything not listed in `tunable` cannot be changed.
`constraints` are never tunable.

The robot signs the overlay:

```json
{
  "oosr": "0.2",
  "kind": "overlay",
  "id": "overlay:hub-7f3a/0192f7aa-...",
  "base": "skill:vivero-x.es/ficus-lyrata-care@1.2.0",
  "subject": "urn:oosr:obj:hub-7f3a:0192f5e1-...",
  "task": "water",
  "set": { "/trigger/any/0/gt_days": 4, "/steps/2/volume_ml/per_pot_litre": 65 },
  "provenance": {
    "learned_by": "urn:oosr:robot:acme:sn-88412",
    "method": "moisture-decay-fit/v1",
    "evidence": ["0192f6a0-...", "0192f8c1-...", "0192fa02-..."]
  },
  "signature": { "alg": "ES256", "kid": "urn:oosr:robot:acme:sn-88412#att", "value": "..." }
}
```

The hub accepts it if: the base skill is installed and trusted; every path is in `tunable` and every
value is within range; the `evidence` events exist, concern that object and were signed by that
robot; and the policy allows overlays. An overlay applies to **one object**, never to a type. When
the base skill's major version changes, its overlays expire.

### Level 2: learned skills

New tasks composed only of primitives from the vocabulary, for objects without a skill or for needs
the skill does not cover. Restrictions:

- `publisher` is the robot's URN and `provenance.kind` is `"learned"`.
- Scope: only the hub where it was learned. Another hub rejects it, even if it trusts the robot's
  manufacturer.
- **Every task with a physical effect requires human approval**, whatever the manifest or the
  policy say, until the owner "graduates" it after N supervised runs without failure (N is set by
  the policy; default 5).
- `dispense` and `cut` need explicit `constraints`, never above those of any trusted skill installed
  for the same object type, if there is one.

**Promotion.** To leave the home, a learned skill must be re-signed by a trusted publisher
(manufacturer, nursery or community) after review. That is how it enters the ecosystem, with its
`provenance` kept intact as attribution.

## 4. Trust levels

| Origin | Signed by | Scope | Physical effect |
|---|---|---|---|
| Publisher skill | trusted `did:web` | any hub that trusts the publisher | per policy |
| Overlay (L1) | paired robot | one object, one hub | within the base skill's `tunable` ranges and `constraints` |
| Learned skill (L2) | paired robot | one hub | always with approval until graduated |
| Learned and promoted | trusted `did:web` | like a publisher skill | per policy |

## 5. Proposed changes

- Manifest: optional per-task `tunable`; optional `provenance`.
- New `overlay` document (schema `schemas/v0/overlay.json`, in a separate PR).
- Household policy:

```json
{
  "learned": {
    "overlays": "allow",
    "skills": "approval",
    "graduate_after": 5,
    "share": false
  }
}
```

  `overlays`: `off | allow`. `skills`: `off | approval`. `share`: whether learned items may be
  exported for review (always with explicit consent per item).
- Events: `oosr.learned.proposed` (robot), `oosr.learned.accepted` and `oosr.learned.revoked` (hub).
- API: `POST /v0/learned`, `GET /v0/objects/{urn}/learned`, `DELETE /v0/learned/{id}`.
- App: a "What the robots have learned" section with a readable diff ("water every 4 days instead
  of 7, because it dries out sooner: see 3 waterings").
- Robot-role audit: overlays and learned skills are checked against their evidence and ranges.

## 6. Threats

| Threat | Mitigation |
|---|---|
| A compromised robot learns "always water" | `tunable` ranges, non-tunable `constraints`, write scopes, revocation, audit |
| Drift from a miscalibrated sensor | Mandatory evidence; the hub may require confirmation by a second robot or sensor; overlays expire |
| Household data leaking when sharing | `share: false` by default; promotion goes through a publisher with per-item consent |
| A learned skill as a phishing vector | As in RFC-0001: `message_key` only; learned skills cannot define new messages, only reuse those of trusted skills |

## 7. Open questions

- [ ] Should the hub recompute or check the adjustment from the evidence (e.g. with a standard
      fitting method), or is it enough to check that the evidence exists?
- [ ] How are contradictory overlays from two robots for the same object resolved? (Proposal: the
      most recent one with the most evidence wins; the app shows the conflict.)
- [ ] Is an anonymous "aggregated evidence" format worth it, so publishers can improve their skills
      with data from many homes, and with what privacy guarantees?
