---
name: neural
description: Neural pattern training, prediction, compression, and pipeline optimization
---

Neural system commands — dispatch by subcommand parsed from the user's input:

1. **train** — `mcp__ruflo__neural_train` with `modelType` (one of `moe|transformer|classifier|embedding`) and `epochs N`.
2. **status** — `mcp__ruflo__neural_status` (SONA + MoE state, active patterns, training in flight).
3. **patterns** — `mcp__ruflo__neural_patterns` to list learned patterns; supports `--list` and `--filter`.
4. **predict** — `mcp__ruflo__neural_predict` with `--input "<task description>"` to get a predicted outcome.
5. **optimize** — `mcp__ruflo__neural_optimize` to retune the pipeline based on recent outcomes.
6. **compress** — `mcp__ruflo__neural_compress` to compact stored patterns via `method: prune` (drop low-usage) or `method: distill` (merge near-duplicates). Note: `method: quantize` is not supported in this build (int8 quantization was removed in ADR-0086 Phase 1).

Present results clearly. For `train`, surface the loss curve summary; for `predict`, show the predicted agent + confidence; for `optimize`/`compress`, show before/after counts.
