# OOSR: Open Object & Skill Registry

**An open standard for robots from any vendor to identify physical objects, learn what they can
do with them, and keep a shared, signed history of what they did.**

A plant carries an AprilTag. A robot resolves the tag to a global ID, loads the object's signed
skill manifest and its current state from the home hub, acts within what the household policy
allows, and writes a signed event. The next robot, from a different manufacturer, already knows
the plant was watered two hours ago.

> Status: **Draft 0.1**. The spec is in Spanish: [RFC-0001](spec/rfcs/0001-oosr.md). English
> translation welcome.

```
   AprilTag #37 ──► robot ──resolve──► hub ──► Object Description + Skill Manifest + state
                       │                 ▲
                       └── signed event ─┘   (CloudEvents, append-only, local-first)
```

**A tag identifies, a manifest proposes, the household policy authorizes, and the robot's safety
layer has the last word.** Nothing that comes from the environment can escalate permissions.

## What's in this repo

| Path | What |
|---|---|
| [`spec/`](spec/) | RFC-0001 (core), [RFC-0002](spec/rfcs/0002-learned-skills.md) (learned skills, draft), [implementation notes](spec/notes-0.1.md) |
| [`schemas/v0/`](schemas/v0/) | Normative JSON Schemas: object, binding, skill manifest, capability, event, policy |
| [`packages/core`](packages/core/) | `@oosr/core`: JCS (RFC 8785), ES256 detached JWS, validation, matching, conditions, state projection |
| [`packages/hub`](packages/hub/) | `@oosr/hub`: reference hub (HTTP API v0, signed log, policy, leases, approvals, RFC 8628 pairing) |
| [`packages/sim`](packages/sim/) | `@oosr/sim`: robot client SDK and a simulated robot |
| [`packages/cli`](packages/cli/) | `oosr`: publisher tools (keys, did:web, sign/verify skills, build a static registry) |
| [`packages/conformance`](packages/conformance/) | Conformance suite: the RFC §8 scenario plus the §9 hub checks |
| [`apps/app`](apps/app/) | The household app (no build step, served by the hub at `/app/`) |
| [`skills/`](skills/) | Community skills, signed in CI and published at `traxito.github.io/oosr` |

## Try it in two minutes

Requires Node.js ≥ 20.10.

```sh
npm install
npm run build
npm run demo
```

The demo boots a hub, installs six signed skills, pairs two robots from different vendors, enrols
three plants, and runs the RFC §8 cycle: the arm measures 0.12, dispenses 240 ml (80 ml/l × 3 l),
measures 0.38. The humanoid then finds nothing to do. Open the printed URL and paste the owner
token: a leaf-spot alert, a new tag to confirm and a robot waiting to pair are in your inbox.

Run the tests (unit + conformance):

```sh
npm test
```

## Run your own hub

```sh
npm run hub -- init --data ./data --trust did:web:traxito.github.io:oosr --timezone Europe/Madrid
npm run hub -- start --data ./data            # app at http://127.0.0.1:7400/app/
```

Pair a simulated robot (approve the code in the app), propose a tag, and run cycles:

```sh
npm run sim -- pair --robot urn:oosr:robot:acme:sn-1 --model acme/arm-2 \
  --primitives navigate_to,inspect,measure:soil_moisture,dispense:water,notify_human --limit dispense_max_ml=1000
npm run sim -- see --tag 37 --type plant/ficus-lyrata --zone salon --skill skill:traxito.github.io/oosr/ficus-lyrata-care
npm run sim -- world --tag 37 --moisture 0.12
npm run sim -- run
```

When you confirm the enrolment, the hub fetches the skill from the community registry announced in
`did:web:traxito.github.io:oosr` and verifies its signature.

## Publish skills

```sh
npm run oosr -- keygen --did did:web:example.com --out publisher.private.jwk.json
npm run --silent oosr -- did --key publisher.private.jwk.json --did did:web:example.com --registry https://example.com/skills > did.json
npm run oosr -- skill validate skills
npm run oosr -- skill sign my-skill --key publisher.private.jwk.json
npm run oosr -- registry build --skills skills --did did:web:example.com --base-url https://example.com --key publisher.private.jwk.json
```

Host `did.json` at `https://example.com/.well-known/did.json` and the `site/skills/` folder at the
registry URL. See [`skills/README.md`](skills/README.md) to contribute a skill to the community
registry.

## Security model, briefly

- **Skills are data, not code.** Tasks are compositions of a closed primitive vocabulary
  (`navigate_to`, `inspect`, `measure`, `grasp`, `place`, `dispense`, `cut`, `notify_human`).
  `knowledge.md` is passed to planners as untrusted data.
- **Signed everything.** Skills: ES256 JWS over the JCS-canonical manifest, including SRI hashes
  of every file. Events: a detached JWS in the `oosrsig` CloudEvents extension.
- **Namespaces are bound to publishers.** `did:web:vivero-x.es` can only sign `skill:vivero-x.es/*`.
- **The hub re-checks every action**: signature, write scopes, zones, skill trust, capability
  matching, season, quiet hours, human approval and leases. Robot-side matching is an
  optimization, not the defense.
- **Humans approve what matters**: enrolment always, and sensitive tasks (`cut` by default)
  through single-use approvals.
- **Messages to humans come only from signed manifests** (`message_key`), never from robot text.

## Governance

Code: Apache-2.0. Spec and schemas: CC BY 4.0. Changes to the spec go through RFCs (14-day
comment period). See [CONTRIBUTING.md](CONTRIBUTING.md). OOSR 1.0 ships when at least two hubs and
three robots from different vendors pass the conformance suite.

---

**En español:** OOSR es un estándar abierto para que robots de cualquier fabricante identifiquen
objetos físicos, sepan qué tareas pueden hacer sobre ellos y registren lo que hicieron en un
historial compartido y firmado. La especificación está en [spec/rfcs/0001-oosr.md](spec/rfcs/0001-oosr.md).
