# server/src/index

`/api/index`: put, pull and search over pgvector `file_chunks`, and `verify` for foreign-owned results (rwx plus x on every ancestor, in one statement).

- **Primary owner:** R2 VFS/DB
- **Secondary reviewer:** R4 AI
- **Spec:** [specs/10-ai/rag-semantic-search.md](../../../specs/10-ai/rag-semantic-search.md), [specs/11-server/backend-api.md](../../../specs/11-server/backend-api.md)
- **Requirement IDs:** RAG-02, RAG-03
