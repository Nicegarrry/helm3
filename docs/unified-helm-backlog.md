# Unified Helm operational backlog

The user approved unified ownership of Helm CLI and Helm 3 on 17 September 2026. All reported operational defects belong to Helm, regardless of the original repository. This does not claim that every CLI behaviour has already been ported or every reported defect reproduced in Helm 3.

GitHub issues are authoritative work state. The issues below are native children of [Map #1](https://github.com/Nicegarrry/helm3/issues/1), with acceptance criteria, priorities, source links and blocking information. Do not close an original report merely because its follow-up is tracked here.

- [[P0] Merge local-gate repositories using trusted exact-SHA evidence](https://github.com/Nicegarrry/helm3/issues/111)
- [[P0] Publish review verdicts through the host and report truthful completion](https://github.com/Nicegarrry/helm3/issues/112)
- [[P1] Adopt existing PRs for independent review and verification](https://github.com/Nicegarrry/helm3/issues/113)
- [[P1] Explain all dispatch preconditions before starting a worker](https://github.com/Nicegarrry/helm3/issues/114)
- [[P0] Pause stop and resume workers without losing WIP or branch ownership](https://github.com/Nicegarrry/helm3/issues/115)
- [[P0] Queue or refuse dispatch when simulator memory or gate capacity is exhausted](https://github.com/Nicegarrry/helm3/issues/116)
- [[P1] Configure realistic disk admission without routine force flags](https://github.com/Nicegarrry/helm3/issues/117)
- [[P1] Show fast trustworthy live attempts sessions and simulators](https://github.com/Nicegarrry/helm3/issues/118)
- [[P1] Validate Oracle executable and argument contract before expensive dispatch](https://github.com/Nicegarrry/helm3/issues/119)
- [[P1] Keep worker scratch and PR-body artifacts out of product commits](https://github.com/Nicegarrry/helm3/issues/120)
- [[P1] Report accurate attempt elapsed active and queued durations](https://github.com/Nicegarrry/helm3/issues/121)

## Execution order and acceptance

Start with host-owned verdict publication and truthful completion, evidence-bound merges for local-gate repositories, pause/stop/resume, and host resource admission. Finish normal operational bootstrap and safe retry facts as part of making these paths usable; a helper alone does not establish end-to-end completion. Dispatch explanation, existing-PR adoption, configured disk floors, fast status, Oracle validation, scratch hygiene and accurate timing complete the operational backlog.

A local-gate policy must still bind trusted machine evidence, independent approval and authority to the exact commit. An absent CI configuration is not a blanket merge bypass. A completed model response is not a published verdict or successful executable verification. Process death is not proof that remote effects are absent. Pause/stop must preserve useful work and distinguish cancellation intent from observed termination.

Use a bounded real-project acceptance run to demonstrate the full loop: local-only gate, read-only reviewer with permitted scratch, posted verdict readback, pause/resume and branch reuse, constrained-machine admission, malformed Oracle refusal, accurate status/timing, and a merge recorded in the Log. Measure coordinator interventions as well as accepted output.

Prefer native Pi Gemini/open-model implementation and independent review. Any ChatGPT workers must be Luna; the coordinator exception is explicit. The user's continued-usage permission supersedes the old coordination reserve stop, not API ceilings, effect boundaries, provider constraints or independent review requirements.
