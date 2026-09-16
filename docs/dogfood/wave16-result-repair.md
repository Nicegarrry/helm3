# Wave 1 slice: terminal-result repair

Native Pi dogfooding exposed an actual failure: a worker guessed `risks` as objects, and generic feedback did not explain the schema mismatch. The terminal contract now includes a schema-validated example, and the existing single same-session correction names safe schema paths and expected types. Raw output remains journaled unchanged. Claims still require independent gate/review evidence; no malformed output is coerced into success.

The pure helper imports the canonical contract. `parseEnvelope` preserves its public interface and whole-text JSON/fence acceptance. Invalid values, unknown property names and raw validator messages are excluded from feedback. Feedback processes at most 128 KiB of UTF-8 input and reports up to eight schema issues. The existing request/spend/lease guards still apply to correction.

## Dogfood provenance

- Accepted runtime/base: `9ee8ac9af53819972154ac9f185c04b1f93fafd2`.
- Initial Qwen3.8 Flash attempt `pi-wave1-task-d95d1cef-7c20-4710-821a-27a7eaaeaf10` ended without a valid result. Its incomplete work was preserved at `c4dfc545bebade39e18c95d284e784dd37fb0602`.
- Repair attempt `pi-wave1-task-c2e652cd-fe9b-4982-921b-ed8e605013ac` rehydrated Pi session `01a0a7a0-f23b-7668-856a-f81b7fb49acc` from a byte-hashed copy of its prior history, with a new owned worktree and fresh authority. Original session bytes were preserved. Three live model requests returned HTTP 200; two allowed file writes completed; the terminal result validated and actual changed paths matched its claims.
- Qwen produced the helper and staged tests. The trusted coordinator installed the tests, wired the protected runtime, fixed an overly narrow test issue-code matcher and added fence/multibyte regressions. Workers had no shell; they did not claim to execute tests.
- Provider-free native regression was RED against the old runtime: initial model prompt lacked the terminal contract. It exercises precise same-session correction and preserved raw invalid output after wiring.

This is a bounded Wave 1 slice, not full live factory acceptance. Reusable live API/CLI execution, frontier auth, full acceptance scenarios and required remote CI remain separate evidence. A private operational runner is not the shipped CLI.

Current user authority is US$20 combined total for 16 September 2026 across supplied OpenCode/Gemini accounts, including prior spend and unknown reservations. Operational continuation ends 02:15Z; monetary permission alone does not extend that schedule. Existing immutable grants/reservations remain intact. No account changes or CI bypass.
