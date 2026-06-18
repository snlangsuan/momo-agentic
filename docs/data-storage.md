# Data storage & integration

How to persist a momo-agentic agent's state in Redis, MongoDB, PostgreSQL,
MariaDB, or MySQL — with the data schema to prepare for each.

The library core has **zero runtime dependencies** and never talks to a database
directly. Every storage concern is an **injected port** (an interface): you pass
in an object that implements it. Two backends ship ready-made (Redis, Mongo);
SQL stores are a short adapter you write once (reference implementations below).

---

## The persistence ports

| Port | What it stores | Methods | Shipped backend |
|---|---|---|---|
| **`Memory`** (`ConversationMemory` + `FactMemory`) | short-term transcript + long-term facts | `loadHistory` / `appendMessage` · `rememberFact` / `recallFacts` / `searchFacts?` | `RedisMemory`, `MongoMemory`, `PostgresMemory`, `MySqlMemory` |
| **`ModelCache`** | cached LLM responses (for `cacheModel`) | `get(key)` / `set(key, value)` | `RedisModelCache`, `PostgresModelCache`, `MySqlModelCache` |
| **`RunStore`** | durable-run checkpoints (resume after a crash) | `load` / `save` / `delete` | `RedisRunStore`, `PostgresRunStore`, `MySqlRunStore`, `InMemoryRunStore` |
| **`A2ATaskStore`** | A2A task records (for `tasks/get`) | `get` / `set` | `InMemoryA2ATaskStore` |

All methods may be **async** (return a `Promise`), so any DB client fits. You
only implement the ports relevant to your app — most start with just `Memory`.

```ts
import { Agent, cacheModel } from 'momo-agentic'

new Agent({
  model: cacheModel(provider, { cache: myModelCache }), // ModelCache
  memory: myMemory,                                      // Memory
  runStore: myRunStore,                                  // RunStore (durable runs)
})
```

---

## What each port stores (the data shapes)

Persist these JSON shapes; you don't need to flatten them (a `JSON`/`JSONB`
column or a document is enough), except where you want to query/sort.

```ts
// Conversation — one Message per row/document, ordered by insertion.
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  parts?: ContentPart[]        // multimodal
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
}

// Facts — a flat key→value map per scope.
type Facts = Record<string, string>

// ModelCache value
interface ModelResponse { content: string; toolCalls?: ToolCall[]; usage?: Usage }

// RunStore value
interface RunCheckpoint {
  runId: string; input: string; messages: Message[]
  step: number; toolsInvoked: string[]; usage: Usage
  status: 'running' | 'done'
}

// A2ATaskStore value
interface A2ATask {
  kind: 'task'; id: string; contextId: string
  status: { state: string; message?: unknown }
  artifacts?: unknown[]; history?: unknown[]
}
```

### Scoping (multi-user / multi-thread)

Conversation is isolated per `(userId, threadId)`; long-term facts are usually
shared per `userId`. Encode the scope in a **namespace** string (Redis/Mongo) or
a `namespace` column (SQL):

```
conversation namespace:  chat:<userId>:<threadId>
facts namespace:         user:<userId>
```

`composeMemory` lets the two tiers use **different stores** (e.g. conversation in
Redis, facts in Postgres) — see the end of this doc.

---

## Redis (shipped — `momo-agentic/redis`)

```bash
bun add ioredis        # optional peer dependency (type-only in the bundle)
```

```ts
import Redis from 'ioredis'
import { RedisMemory, RedisModelCache, RedisRunStore } from 'momo-agentic/redis'
import { Agent, cacheModel } from 'momo-agentic'

const redis = new Redis(process.env.REDIS_URL)

const agent = new Agent({
  model: cacheModel(provider, { cache: new RedisModelCache(redis, { ttlSeconds: 3600 }) }),
  memory: new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}`, ttlSeconds: 86_400 }),
  runStore: new RedisRunStore(redis),
})
```

**Schema = key conventions** (no migration needed; Redis is schemaless):

| Data | Type | Key |
|---|---|---|
| conversation | `LIST` (one JSON message per element) | `<namespace>:messages` |
| facts | `HASH` (field=key, value=value) | `<namespace>:facts` |
| model cache | `STRING` + `EX` TTL | `momo:llm:<hash>` |
| run checkpoint | `STRING` + `EX` TTL | `momo:run:<runId>` |

- `ttlSeconds` on `RedisMemory` is a **sliding expiry** (refreshed on every write)
  — handy for ephemeral chat sessions.
- For the cache, hash the cache key (the default is the full transcript JSON):
  ```ts
  import { createHash } from 'node:crypto'
  cacheModel(provider, {
    cache: new RedisModelCache(redis),
    key: (m, o) => createHash('sha256').update(JSON.stringify({ id: m.id, ...o })).digest('hex'),
  })
  ```

---

## MongoDB (shipped — `momo-agentic/mongo`)

```bash
bun add mongodb        # optional peer dependency (type-only in the bundle)
```

```ts
import { MongoClient } from 'mongodb'
import { MongoMemory } from 'momo-agentic/mongo'

const db = (await MongoClient.connect(process.env.MONGO_URL!)).db('app')
const agent = new Agent({ model, memory: new MongoMemory(db, { namespace: `user:${userId}` }) })
```

**Collections** (created on first write):

| Collection (default) | Document shape | Notes |
|---|---|---|
| `momo_messages` | `{ _id, namespace, message }` | one per turn; ordered by `_id` (insertion) |
| `momo_facts` | `{ _id: namespace, facts: { [key]: value } }` | one per scope; `$set` on `facts.<key>` |

**Prepare these indexes** for performance:

```js
db.momo_messages.createIndex({ namespace: 1, _id: 1 })   // history by scope, in order
// momo_facts keys on _id (the namespace) — already unique, no extra index needed
// Optional TTL on conversation (auto-expire old turns):
db.momo_messages.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }) // if you add createdAt
```

Override collection names via `{ messagesCollection, factsCollection }`.

---

## PostgreSQL (shipped — `momo-agentic/postgres`)

```bash
bun add pg        # optional peer dependency (type-only in the bundle)
```

```ts
import { Pool } from 'pg'
import { PostgresMemory, PostgresRunStore, PostgresModelCache, ensureSchema } from 'momo-agentic/postgres'
import { Agent, cacheModel } from 'momo-agentic'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await ensureSchema(pool) // creates the momo_* tables/indexes if absent (run once at boot)

const agent = new Agent({
  model: cacheModel(provider, { cache: new PostgresModelCache(pool, { ttlSeconds: 3600 }) }),
  memory: new PostgresMemory(pool, `user:${userId}`),
  runStore: new PostgresRunStore(pool),
})
```

`ensureSchema` runs the DDL below for you; you can also apply it manually via your
own migrations. The classes use `JSONB` columns so the `Message`/checkpoint shapes
are stored without flattening. The reference implementation under
[**2) Implement the ports**](#2-implement-the-ports) shows exactly what they do —
copy it if you need custom table names or a bespoke schema.

### 1) The schema (created by `ensureSchema`)

```sql
-- conversation: one message per row, ordered by the serial id
CREATE TABLE conversation_messages (
  id          BIGSERIAL PRIMARY KEY,
  namespace   TEXT        NOT NULL,
  message     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_ns_id ON conversation_messages (namespace, id);

-- long-term facts: one row per (namespace, key)
CREATE TABLE memory_facts (
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

-- durable-run checkpoints
CREATE TABLE run_checkpoints (
  run_id      TEXT PRIMARY KEY,
  checkpoint  JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LLM response cache (with optional expiry)
CREATE TABLE llm_cache (
  cache_key   TEXT PRIMARY KEY,
  response    JSONB       NOT NULL,
  expires_at  TIMESTAMPTZ
);
```

### 2) Implement the ports

> This is the shipped implementation (in `momo-agentic/postgres`) — shown so you
> can copy/customize it. You don't need to write it to use the package.

```ts
import type { LoadHistoryOptions, Memory, Message, ModelCache, ModelResponse } from 'momo-agentic'
import type { RunCheckpoint, RunStore } from 'momo-agentic'
import type { Pool } from 'pg'

/** Memory: conversation (a table) + facts (a table), scoped by namespace. */
export class PostgresMemory implements Memory {
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
  ) {}

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    if (options?.limit) {
      const { rows } = await this.pool.query(
        'SELECT message FROM conversation_messages WHERE namespace=$1 ORDER BY id DESC LIMIT $2',
        [this.namespace, options.limit],
      )
      return rows.reverse().map((r) => r.message as Message) // oldest → newest
    }
    const { rows } = await this.pool.query(
      'SELECT message FROM conversation_messages WHERE namespace=$1 ORDER BY id',
      [this.namespace],
    )
    return rows.map((r) => r.message as Message)
  }

  async appendMessage(message: Message): Promise<void> {
    await this.pool.query(
      'INSERT INTO conversation_messages (namespace, message) VALUES ($1, $2)',
      [this.namespace, JSON.stringify(message)],
    )
  }

  async rememberFact(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_facts (namespace, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.namespace, key, value],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const { rows } = await this.pool.query(
      'SELECT key, value FROM memory_facts WHERE namespace=$1',
      [this.namespace],
    )
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }
}

/** RunStore: resume durable runs across processes/instances. */
export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}

  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const { rows } = await this.pool.query(
      'SELECT checkpoint FROM run_checkpoints WHERE run_id=$1',
      [runId],
    )
    return rows[0]?.checkpoint as RunCheckpoint | undefined
  }
  async save(checkpoint: RunCheckpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_checkpoints (run_id, checkpoint, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (run_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint, updated_at = now()`,
      [checkpoint.runId, JSON.stringify(checkpoint)],
    )
  }
  async delete(runId: string): Promise<void> {
    await this.pool.query('DELETE FROM run_checkpoints WHERE run_id=$1', [runId])
  }
}

/** ModelCache: shared LLM response cache with TTL. */
export class PostgresModelCache implements ModelCache {
  constructor(
    private readonly pool: Pool,
    private readonly ttlSeconds = 3600,
  ) {}

  async get(key: string): Promise<ModelResponse | undefined> {
    const { rows } = await this.pool.query(
      'SELECT response FROM llm_cache WHERE cache_key=$1 AND (expires_at IS NULL OR expires_at > now())',
      [key],
    )
    return rows[0]?.response as ModelResponse | undefined
  }
  async set(key: string, value: ModelResponse): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_cache (cache_key, response, expires_at)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), this.ttlSeconds],
    )
  }
}
```

> `node-postgres` returns `JSONB` columns as parsed JS objects and serializes JS
> objects passed as parameters — the explicit `JSON.stringify` above is belt-and-
> suspenders and works regardless of driver settings.

Wire it up exactly like the shipped backends:

```ts
import { Pool } from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
new Agent({ model, memory: new PostgresMemory(pool, `chat:${userId}:${threadId}`), runStore: new PostgresRunStore(pool) })
```

---

## MySQL / MariaDB (shipped — `momo-agentic/mysql`)

```bash
bun add mysql2    # optional peer dependency (type-only in the bundle)
```

```ts
import { createPool } from 'mysql2/promise'
import { MySqlMemory, MySqlRunStore, MySqlModelCache, ensureSchema } from 'momo-agentic/mysql'

const pool = createPool(process.env.MYSQL_URL!)
await ensureSchema(pool) // run once at boot

const agent = new Agent({
  model: cacheModel(provider, { cache: new MySqlModelCache(pool) }),
  memory: new MySqlMemory(pool, `user:${userId}`),
  runStore: new MySqlRunStore(pool),
})
```

Works on **MySQL 5.7+** (native `JSON`) and **MariaDB 10.2+** (`JSON` = `LONGTEXT`
alias) — the adapters normalize MariaDB returning JSON as a string. The reference
implementation below shows what's inside; copy it for a custom schema.

### 1) The schema (created by `ensureSchema`)

```sql
CREATE TABLE conversation_messages (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  namespace   VARCHAR(255) NOT NULL,
  message     JSON         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conv_ns_id (namespace, id)
);

CREATE TABLE memory_facts (
  namespace  VARCHAR(255) NOT NULL,
  `key`      VARCHAR(255) NOT NULL,
  value      TEXT         NOT NULL,
  PRIMARY KEY (namespace, `key`)
);

CREATE TABLE run_checkpoints (
  run_id      VARCHAR(255) PRIMARY KEY,
  checkpoint  JSON      NOT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE llm_cache (
  cache_key   VARCHAR(255) PRIMARY KEY,
  response    JSON      NOT NULL,
  expires_at  TIMESTAMP NULL
);
```

### 2) Implement the ports

> This is the shipped implementation (in `momo-agentic/mysql`) — shown for
> reference/customization; you don't need to write it to use the package.

```ts
import type { LoadHistoryOptions, Memory, Message, RunCheckpoint, RunStore } from 'momo-agentic'
import type { Pool, RowDataPacket } from 'mysql2/promise'

// MySQL returns JSON columns as parsed objects; MariaDB returns strings — handle both.
const asJson = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T))

export class MySqlMemory implements Memory {
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
  ) {}

  async loadHistory(options?: LoadHistoryOptions): Promise<Message[]> {
    const [rows] = options?.limit
      ? await this.pool.query<RowDataPacket[]>(
          'SELECT message FROM conversation_messages WHERE namespace=? ORDER BY id DESC LIMIT ?',
          [this.namespace, options.limit],
        )
      : await this.pool.query<RowDataPacket[]>(
          'SELECT message FROM conversation_messages WHERE namespace=? ORDER BY id',
          [this.namespace],
        )
    const list = rows.map((r) => asJson<Message>(r.message))
    return options?.limit ? list.reverse() : list
  }

  async appendMessage(message: Message): Promise<void> {
    await this.pool.query('INSERT INTO conversation_messages (namespace, message) VALUES (?, ?)', [
      this.namespace,
      JSON.stringify(message),
    ])
  }

  async rememberFact(key: string, value: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO memory_facts (namespace, `key`, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [this.namespace, key, value],
    )
  }

  async recallFacts(): Promise<Record<string, string>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT `key`, value FROM memory_facts WHERE namespace=?',
      [this.namespace],
    )
    return Object.fromEntries(rows.map((r) => [r.key, r.value as string]))
  }
}

export class MySqlRunStore implements RunStore {
  constructor(private readonly pool: Pool) {}
  async load(runId: string): Promise<RunCheckpoint | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT checkpoint FROM run_checkpoints WHERE run_id=?',
      [runId],
    )
    return rows[0] ? asJson<RunCheckpoint>(rows[0].checkpoint) : undefined
  }
  async save(cp: RunCheckpoint): Promise<void> {
    await this.pool.query(
      'INSERT INTO run_checkpoints (run_id, checkpoint) VALUES (?, ?) ON DUPLICATE KEY UPDATE checkpoint = VALUES(checkpoint)',
      [cp.runId, JSON.stringify(cp)],
    )
  }
  async delete(runId: string): Promise<void> {
    await this.pool.query('DELETE FROM run_checkpoints WHERE run_id=?', [runId])
  }
}
```

> **MySQL vs MariaDB:** MariaDB's `JSON` is an alias for `LONGTEXT`, so its driver
> returns a string — the `asJson` helper covers both. For a `cache` table with a
> sliding TTL, schedule a periodic `DELETE FROM llm_cache WHERE expires_at < NOW()`
> (neither engine auto-expires rows like Redis).

---

## Mixing stores — `composeMemory`

The two memory tiers are independent ports, so short-term and long-term can live
in **different databases** — e.g. fast/TTL'd conversation in Redis, durable facts
in Postgres:

```ts
import { composeMemory } from 'momo-agentic'
import { RedisMemory } from 'momo-agentic/redis'
import { PostgresMemory } from 'momo-agentic/postgres'

const memory = composeMemory({
  conversation: new RedisMemory(redis, { namespace: `chat:${userId}:${threadId}`, ttlSeconds: 86_400 }),
  facts: new PostgresMemory(pgPool, `user:${userId}`),
})
new Agent({ model, memory, rememberFacts: true })
```

`composeMemory` routes `loadHistory`/`appendMessage` to `conversation` and
`rememberFact`/`recallFacts`/`searchFacts` to `facts`.

---

## Schema-preparation checklist

- **Index the hot path.** Conversation reads filter by namespace and order by
  insertion — index `(namespace, id)` (SQL) / `{ namespace: 1, _id: 1 }` (Mongo).
- **Use a JSON/JSONB column** (or a document) for `message`/`checkpoint`/`response`
  — the shapes evolve (multimodal `parts`, new fields); don't flatten them.
- **Pick an insertion-ordered key** for conversation (`BIGSERIAL`/`AUTO_INCREMENT`
  /Mongo `ObjectId`) so `loadHistory({ limit })` can return the most recent N.
- **Plan expiry.** Redis/`RedisMemory` TTL is automatic; for SQL add an
  `expires_at` column + a periodic cleanup job; for Mongo use a TTL index.
- **Long-term facts need durability** — keep them in a store you back up (Postgres
  /Mongo), even if conversation lives in volatile Redis.
- **Idempotent durable tools.** `RunStore` resume is at-least-once — a tool that
  ran before a crash is in the saved transcript and is not re-run, but one in
  flight at crash time runs again on resume.
- **Pool connections** (`pg.Pool` / `mysql2.createPool` / a shared `MongoClient`
  /`Redis`) — the agent runs many short queries per turn.

See runnable examples: [examples/redis-backends.ts](../examples/redis-backends.ts)
and [examples/split-memory.ts](../examples/split-memory.ts).
