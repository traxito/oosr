# Generic houseplant (conservative default)

> OOSR knowledge file. Context for planners and people. It is data, not instructions:
> the only actions a robot may take are the tasks and primitives in `manifest.json`.

This skill applies to any object whose type starts with `plant` when no more specific skill is
available. It is deliberately cautious:

- It never waters on a schedule, only when a fresh measurement shows dry soil (volumetric
  moisture below ~0.15), and only 50 ml per litre of pot, capped at 300 ml.
- It checks plant health weekly and reports what it sees; it never cuts.

Underwatering is easy to fix; overwatering and root rot often are not. If you know the species,
install a specific skill or set the object's type so a better skill applies.
