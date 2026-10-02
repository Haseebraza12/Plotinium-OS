# ai/src/embed

The `ai.embed` worker: mdbr-leaf-ir q8 (revision 4262131b), MRL-truncated to 384 dimensions with a query prefix (fallback: Xenova/bge-small-en-v1.5 q8), on Transformers.js over ORT WASM; batch size 1, at most 512 tokens, `numThreads = hwc >= 8 ? 2 : 1`, self-hosted weights. Accounted as one evictable page of about 100 MiB.

- **Primary owner:** R4 AI Pipeline Specialist
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/10-ai/rag-semantic-search.md](../../../specs/10-ai/rag-semantic-search.md), [specs/03-kernel/memory-and-paging.md](../../../specs/03-kernel/memory-and-paging.md)
- **Requirement IDs:** RAG-01, RAG-05, MEM-01
