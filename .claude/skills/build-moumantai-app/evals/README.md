# Evals — regression canaries

`canaries.md` is the living list of failure modes this skill has shipped a fix for. Each entry records a **Scenario**, **Category**, **Expected skill guidance**, and a **Verified-in** pointer (see the Format block at the top of `canaries.md`).

There is no automated runner — verification is a **manual re-read**: before editing the skill, walk the list and confirm each canary is still addressed by the current `SKILL.md` / `references/`; after a failure in the wild, add a canary for it.

The file is the skill's regression harness. Transient eval-session artifacts — per-round prompts, rubrics, failure classifications — belong in git history, not the skill.
