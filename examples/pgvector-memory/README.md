# Example: long-term semantic memory with Postgres + pgvector

Implements the [`Memory`](../../src/memory/memory.ts) port over **Postgres +
pgvector** so the agent's long-term facts are durable and retrieved
**semantically** (`searchFacts` → vector similarity), not by keyword. Drop-in:
`new Agent({ model, memory: new PgVectorMemory({...}) })`.

```
agent ──recallRelevantFacts──▶ PgVectorMemory.searchFacts ──▶ pgvector  (embedding <=> query)
        rememberFact ─────────▶ INSERT … embedding = embed(value)
```

## Files

```
pgvector-memory.ts   PgVectorMemory implements Memory (conversation + facts + searchFacts)
index.ts             seed Thai/English facts, semantic search, plug into an Agent
```

## Run

Needs Postgres with the `vector` extension. For **real (Thai-capable) semantic
search**, use a multilingual embedder — `bge-m3` via Ollama is the easy pick.

```bash
# 1. Postgres + pgvector (e.g. the official image)
docker run -d --name pgv -p 5432:5432 -e POSTGRES_PASSWORD=pw pgvector/pgvector:pg16

# 2. A multilingual embedder (handles Thai)
ollama pull bge-m3

# 3. Run (bun add pg first)
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres \
EMBED=ollama OLLAMA_MODEL=bge-m3 \
  bun run examples/pgvector-memory/index.ts
```

Without `EMBED=ollama` it uses a toy hash embedder (mechanics only, not
semantic). Without `DATABASE_URL` it just prints what it would do.

## Thai-language knowledge bases — what to use

momo-agentic is language-agnostic; **Thai support comes from the embedder (and,
for chunking, a Thai tokenizer)** you plug in. Recommended:

| Layer | Thai-capable options |
| --- | --- |
| **Embeddings** (the key piece) | **BGE-M3** (BAAI, multilingual, 8k tokens — used here), `intfloat/multilingual-e5`, Cohere `embed-multilingual-v3`, OpenAI `text-embedding-3`, Google Gemini embeddings, Voyage multilingual |
| **Thai tokenization / chunking** | [PyThaiNLP](https://pythainlp.org) (newmm, deepcut), AttaCut — Thai has no spaces, so word-segment before chunking/keyword |
| **Thai LLM** (generation) | [Typhoon](https://opentyphoon.ai) (SCB10X), OpenThaiGPT — strong Thai answers; or any multilingual LLM (Claude, Gemini) |
| **Vector store / RAG** | pgvector (here), Qdrant, Chroma, Milvus, LlamaIndex/LangChain — all language-agnostic once embeddings are multilingual |

**Recipe for a Thai KB:** multilingual embedder (BGE-M3) + PyThaiNLP for
segmentation/chunking + pgvector/Qdrant + a Thai-capable LLM (Typhoon/Claude/Gemini).
Swap `ollamaEmbed('bge-m3', …)` in `index.ts` for any of the above.
