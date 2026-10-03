# Contributing to OOSR

Thanks for helping. There are three ways to contribute, each with its own path.

## 1. Spec changes: the RFC process

Anything that changes what an implementation must do (schemas, primitives, event types, API,
trust rules) goes through an RFC.

1. Open an issue labelled `rfc` describing the problem. Discuss before writing.
2. Copy the format of [`spec/rfcs/0001-oosr.md`](spec/rfcs/0001-oosr.md) into
   `spec/rfcs/NNNN-short-title.md` and open a PR. Spanish or English are both fine.
3. The PR stays open for comments for **14 days**.
4. Maintainers record the decision (accept, reject, postpone) in the PR, with reasons.
5. Accepted RFCs update `schemas/`, the reference implementation and the conformance suite in
   the same or a follow-up PR. **A spec change without a conformance test is not finished.**

New primitives always enter as optional capabilities in the Capability Manifest.

## 2. Skills for the community registry

Community skills live in [`skills/`](skills/) and are signed in CI by
`did:web:traxito.github.io:oosr`. See [`skills/README.md`](skills/README.md) for the checklist.
In short: horticultural or domain facts must be sourced, physical effects must be bounded by
`constraints`, and `knowledge.md` must read as information, never as instructions.

## 3. Code

```sh
npm install
npm run build
npm test
```

- TypeScript, ESM, Node.js ≥ 20.10. No new runtime dependencies without discussion: the core
  depends only on `ajv`.
- Every hub rule must have a conformance test in `packages/conformance`.
- Keep the app free of build steps and frameworks: it is served as static files by any hub.
- Robot- or manifest-supplied strings are untrusted. In the app, render them through
  `textContent`, never `innerHTML`.

## Security issues

Do not open public issues for vulnerabilities in the trust model or the reference hub. Use
GitHub's private vulnerability reporting on this repository.

## Licensing

By contributing you agree that code is licensed under Apache-2.0 and spec text and schemas under
CC BY 4.0.
