# ai/src/predictor

The predictor: a Witten-Bell interpolated Markov-2 model backing off to Markov-1, then time-bucket MFU, then global MFU (MFU until 50 launches), over an on-device telemetry ring. `prefetch:*` jobs run at priority 39 only when idle for at least 2 s, confident and with free memory; their pages are speculative and evicted first.

- **Primary owner:** R4 AI Pipeline Specialist
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/10-ai/predictive-prefetch.md](../../../specs/10-ai/predictive-prefetch.md)
- **Requirement IDs:** PRE-01..06
