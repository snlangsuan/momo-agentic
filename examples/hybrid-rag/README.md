# Example: Thai hybrid RAG (dense + keyword + rerank) as a `rag_search` tool

The 2026 best-practice for **Thai** retrieval, packaged as one agent tool:

```
query ─┬─ dense  (bge-m3 + pgvector,  embedding <=> q) ─┐
       └─ sparse (Postgres FTS over Thai-segmented text) ┤─ RRF fuse ─▶ rerank (bge-reranker-v2-m3) ─▶ rag_search
       (Thai word-segmented with ICU Intl.Segmenter)     ┘                              (optional)
```

Why hybrid + rerank for Thai:
- **Dense** (bge-m3) handles paraphrase / cross-lingual, no segmentation needed.
- **Sparse** (BM25/FTS) nails exact terms, names, numbers — but **Thai has no
  spaces, so it must be word-segmented first**. We use the runtime's ICU
  `Intl.Segmenter('th')` — no extra dependency.
- **RRF** fuses the two rankings; a **cross-encoder reranker** gives the biggest
  precision boost on the top candidates.

## Files

```
hybrid-rag.ts   HybridRag (ingest + hybrid search + RRF + rerank) + createRagSearchTool + Thai segment()
index.ts        ingest Thai docs, run hybrid search, expose rag_search to an agent
```

## Run

```bash
# Postgres + pgvector
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw pgvector/pgvector:pg16

# multilingual embeddings (Thai) + (optional) reranker
ollama pull bge-m3
# optional rerank: HuggingFace Text Embeddings Inference serving bge-reranker-v2-m3
#   docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest --model-id BAAI/bge-reranker-v2-m3

# run (bun add pg first)
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres \
EMBED=ollama OLLAMA_MODEL=bge-m3 \
RERANK=tei RERANK_URL=http://localhost:8080 \
  bun run examples/hybrid-rag/index.ts "ลาพักร้อนได้ปีละกี่วัน"
```

| Env | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres + `vector` extension (required) |
| `EMBED` | `hash` (toy, offline) or `ollama` (real, Thai-capable) |
| `OLLAMA_MODEL` | default `bge-m3` |
| `RERANK` | unset (none) or `tei` for a cross-encoder reranker |
| `RERANK_URL` | TEI endpoint serving `bge-reranker-v2-m3` |

Without `DATABASE_URL` it prints a dry-run note (Thai segmentation still runs).

## Notes

- The whole pipeline is one `rag_search` tool — add it to any agent's `tools`.
- The `Embedder` and `Reranker` are injected: swap bge-m3 for Cohere/OpenAI/Voyage
  multilingual, or the reranker for Cohere Rerank, without touching the agent.
- For higher recall on names/IDs, keep the sparse side; for pure semantic Q&A,
  dense alone may suffice — measure on your data (BM25 sometimes wins).
