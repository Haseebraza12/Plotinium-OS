# ai/src/indexer

The `ai.indexer` process: chunking, reconciliation with VFS events, throttling while the user is active; writes through `sys.index.put`.

- **Primary owner:** R4 AI Pipeline Specialist
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/10-ai/rag-semantic-search.md](../../../specs/10-ai/rag-semantic-search.md)
- **Requirement IDs:** RAG-01, RAG-02
