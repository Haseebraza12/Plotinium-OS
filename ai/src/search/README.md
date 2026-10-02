# ai/src/search

Search: the exact client vector index (Float32Array segments of 1,024 rows, pageable) with the readable set computed from the CURRENT tree before ranking, top-k via `dsa/heap`; BM25 fallback, reciprocal rank fusion, snippets and citations. Online, results from inodes the querying uid does not own are re-verified with `POST /api/index/verify`; offline they are hidden.

- **Primary owner:** R4 AI (vector search); R3 WM/UI (BM25, citations)
- **Secondary reviewer:** R4 and R3 review each other's part
- **Spec:** [specs/10-ai/rag-semantic-search.md](../../../specs/10-ai/rag-semantic-search.md)
- **Requirement IDs:** RAG-03, RAG-04, RAG-05, RAG-06
