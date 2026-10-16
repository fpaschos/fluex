---
name: trim
description: "Cut code and comments in the current diff while keeping the ticket's and existing behaviour."
disable-model-invocation: true
---

Reduce the code to maintain in the current branch's diff against main, without changing behaviour.

If the user passes a ticket reference, fetch it and list its acceptance criteria first. Those, and all existing tests, must still hold.

Read each changed file whole, then look for:
- Extras: code the ticket does not require, such as checks, heuristics, or guards against your own repo's scripts.
- Duplicates: two fields, helpers or branches that do the same thing; merge them.
- Reuse: search the codebase for an existing helper that does what new code does; use it instead.
- Efficiency: work repeated per call or per loop that can be done once (module-level values, compiled regexes, cached reads).
- Altitude: logic at the wrong level; move it into the helper it belongs to, or inline a helper used once.
- Comments that restate the code; shorten the rest to one line where possible.

Do not change anything another contract depends on (wire formats, stdin/stdout shapes, public exports) unless the user agrees.

List each cut with its line saving and what behaviour, if any, it drops. Apply the cuts that drop no required behaviour; ask about the rest.

Run typechecking and the tests after the cuts, then commit to the current branch.
