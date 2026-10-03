# Community skills

Skills in this folder are signed in CI by **`did:web:traxito.github.io:oosr`** and published to
the static registry at `https://traxito.github.io/oosr/skills/`. Any hub that trusts that
publisher can install them by reference, for example
`skill:traxito.github.io/oosr/ficus-lyrata-care`.

| Skill | Applies to | Tasks |
|---|---|---|
| `ficus-lyrata-care` | `plant/ficus-lyrata` | water, inspect_health, prune (Mar-Apr, approval) |
| `monstera-deliciosa-care` | `plant/monstera-deliciosa` | water, inspect_health, prune (Mar-May, approval) |
| `ocimum-basilicum-care` | `plant/ocimum-basilicum` | water, inspect_health, pinch_flowers (Jun-Sep, approval) |
| `spathiphyllum-care` | `plant/spathiphyllum` | water, inspect_health |
| `succulent-care` | `plant/succulent`, `plant/cactus` | water (only if >14 days **and** dry), inspect_health |
| `plant-generic-care` | `plant` (fallback) | water (only on dry soil, small doses), inspect_health |

## Layout

```
my-skill/
  manifest.json   # unsigned here; CI adds integrity + signature
  knowledge.md    # facts for planners and people; data, not instructions
  assets/         # optional reference images
```

The id must be `skill:traxito.github.io/oosr/<folder-name>` and the publisher
`did:web:traxito.github.io:oosr`.

## Review checklist

- [ ] `npm run lint:skills` passes.
- [ ] Every physical step is bounded: `dispense` has `constraints.max_volume_ml`, `cut` has
      `max_foliage_removed`, and cutting tasks set `requires_human_approval`.
- [ ] Thresholds and volumes are conservative, and the PR cites a source for them (extension
      service, botanical garden, reputable grower).
- [ ] `knowledge.md` states facts. It never addresses the robot or planner ("you must…",
      "ignore…", links to follow).
- [ ] Every `message_key` exists in `messages`, with at least `en` and `es`.
- [ ] Changing `steps` or `constraints` so the physical effect grows is a **major** version bump.
