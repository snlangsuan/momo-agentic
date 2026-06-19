import { partsToRunInput, resultToArtifact, rpcError, rpcResult } from '@/a2a/mapping'
import type { A2ATaskStore } from '@/a2a/task-store'
import type {
  A2AAgentCard,
  A2AAgentSkill,
  A2AArtifactUpdateEvent,
  A2AMessage,
  A2APart,
  A2APushNotificationConfig,
  A2AStatusUpdateEvent,
  A2ATask,
  A2ATaskState,
  JsonRpcRequest,
} from '@/a2a/types'
/**
 * A2A server — expose a momo-agentic {@link IAgent} to remote A2A clients.
 *
 * `serveA2A` returns an Agent Card plus a framework-agnostic `handle(Request)`
 * that speaks JSON-RPC 2.0 — mount it in any Web-standard server (Bun.serve,
 * Hono, edge). Methods: `message/send`, `message/stream` (token-level SSE),
 * `tasks/get`, `tasks/cancel`, and `tasks/pushNotificationConfig/{set,get}`.
 * Nothing imports a transport.
 *
 * Pass a single agent, or an `(contextId) => IAgent` resolver to scope memory per
 * A2A context (e.g. `base.withMemory(store.for({ userId: contextId, ... }))`).
 */
import type { IAgent, RunResult } from '@/agent/types'
import type { AgentHooks } from '@/observability/hooks'

const ARTIFACT_ID = 'artifact-1'

/** An agent, or a per-context resolver (for memory scoping by A2A `contextId`). */
export type A2AAgentResolver = (contextId: string) => IAgent | Promise<IAgent>

/** Configuration for {@link serveA2A}; fills in the {@link A2AAgentCard}. */
export interface ServeA2AOptions {
  /** Public JSON-RPC endpoint URL clients POST to. */
  url: string
  /** Semver of this agent deployment. */
  version: string
  /** Display name. Defaults to the agent's name (or `"agent"` for a resolver). */
  name?: string
  description?: string
  /** Advertised skills. Defaults to a single catch-all skill. */
  skills?: A2AAgentSkill[]
  /** A2A protocol version to advertise. Defaults to `"0.3.0"`. */
  protocolVersion?: string
  /** Task persistence; enables `tasks/get`. Defaults to none (then `tasks/get` errors). */
  taskStore?: A2ATaskStore
  /** Advertised security schemes (echoed into the Agent Card). */
  securitySchemes?: Record<string, unknown>
  /** Required security (scheme name → scopes), echoed into the Agent Card. */
  security?: Array<Record<string, string[]>>
  /**
   * Decide whether a finished run still needs more input from the client. When it
   * returns true the task ends in `input-required` (not `completed`); the client
   * continues by sending another message with the same `taskId`/`contextId`.
   */
  needsInput?: (result: RunResult) => boolean
  /** Fetch used to POST push notifications. Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** The result of {@link serveA2A}: a discovery card and a request handler. */
export interface A2AServer {
  /** Serve this at `/.well-known/agent-card.json`. */
  readonly card: A2AAgentCard
  /** Handle one JSON-RPC request (POST body). */
  handle(request: Request): Promise<Response>
}

interface ServerContext {
  resolveAgent: A2AAgentResolver
  taskStore?: A2ATaskStore
  inflight: Map<string, AbortController>
  pushConfigs: Map<string, A2APushNotificationConfig>
  needsInput?: (result: RunResult) => boolean
  fetchImpl: typeof fetch
}

type Id = JsonRpcRequest['id']

// --- small builders ---------------------------------------------------------

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const makeTask = (
  id: string,
  contextId: string,
  state: A2ATaskState,
  parts?: A2APart[],
): A2ATask => ({
  kind: 'task',
  id,
  contextId,
  status: { state },
  ...(parts ? { artifacts: [{ artifactId: ARTIFACT_ID, name: 'response', parts }] } : {}),
})

const statusEvent = (
  taskId: string,
  contextId: string,
  state: A2ATaskState,
  text?: string,
): A2AStatusUpdateEvent => ({
  kind: 'status-update',
  taskId,
  contextId,
  status: text
    ? {
        state,
        message: {
          kind: 'message',
          role: 'agent',
          messageId: crypto.randomUUID(),
          parts: [{ kind: 'text', text }],
        },
      }
    : { state },
  final: true,
})

const artifactEvent = (
  taskId: string,
  contextId: string,
  parts: A2APart[],
  append: boolean,
  lastChunk: boolean,
): A2AArtifactUpdateEvent => ({
  kind: 'artifact-update',
  taskId,
  contextId,
  artifact: { artifactId: ARTIFACT_ID, name: 'response', parts },
  append,
  lastChunk,
})

const textParts = (output: string, object?: unknown): A2APart[] => {
  const parts: A2APart[] = [{ kind: 'text', text: output }]
  if (object !== undefined && object !== null) {
    parts.push({ kind: 'data', data: object as Record<string, unknown> })
  }
  return parts
}

const runOptions = (
  taskId: string,
  contextId: string,
  signal: AbortSignal,
  hooks?: AgentHooks,
) => ({
  runId: taskId,
  signal,
  metadata: { a2a: { taskId, contextId } },
  ...(hooks ? { hooks } : {}),
})

const finalState = (ctx: ServerContext, result: RunResult): A2ATaskState =>
  ctx.needsInput?.(result) ? 'input-required' : 'completed'

/** Fire-and-forget POST of the task to its configured push webhook, if any. */
function notify(ctx: ServerContext, taskId: string, task: A2ATask): void {
  const config = ctx.pushConfigs.get(taskId)
  if (!config) return
  void ctx
    .fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { 'x-a2a-notification-token': config.token } : {}),
      },
      body: JSON.stringify(task),
    })
    .catch(() => {})
}

/** Link the request's abort to a fresh controller (so `tasks/cancel` can abort too). */
const linkedController = (signal?: AbortSignal): AbortController => {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', () => controller.abort())
  return controller
}

const idsFor = (message: A2AMessage) => ({
  contextId: message.contextId ?? crypto.randomUUID(),
  taskId: message.taskId ?? crypto.randomUUID(),
})

function buildAgentCard(name: string, options: ServeA2AOptions): A2AAgentCard {
  const description = options.description ?? `The ${name} agent`
  return {
    protocolVersion: options.protocolVersion ?? '0.3.0',
    name,
    description,
    url: options.url,
    version: options.version,
    capabilities: { streaming: true, pushNotifications: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: options.skills ?? [{ id: 'default', name, description, tags: [] }],
    ...(options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}),
    ...(options.security ? { security: options.security } : {}),
  }
}

// --- method handlers --------------------------------------------------------

async function handleSend(
  ctx: ServerContext,
  message: A2AMessage,
  push: A2APushNotificationConfig | undefined,
  id: Id,
): Promise<Response> {
  const { contextId, taskId } = idsFor(message)
  if (push) ctx.pushConfigs.set(taskId, push)
  const controller = linkedController()
  ctx.inflight.set(taskId, controller)
  try {
    const agent = await ctx.resolveAgent(contextId)
    const result = await agent.run(
      partsToRunInput(message.parts),
      runOptions(taskId, contextId, controller.signal),
    )
    const done = makeTask(
      taskId,
      contextId,
      finalState(ctx, result),
      textParts(result.output, result.object),
    )
    await ctx.taskStore?.set(done)
    notify(ctx, taskId, done)
    return json(rpcResult(id, done))
  } catch (error) {
    if (controller.signal.aborted) {
      const canceled = makeTask(taskId, contextId, 'canceled')
      await ctx.taskStore?.set(canceled)
      notify(ctx, taskId, canceled)
      return json(rpcResult(id, canceled))
    }
    return json(rpcError(id, -32603, error instanceof Error ? error.message : String(error)))
  } finally {
    ctx.inflight.delete(taskId)
  }
}

/** Drive the run, streaming token deltas as artifact-update chunks. */
async function pump(
  ctx: ServerContext,
  message: A2AMessage,
  taskId: string,
  contextId: string,
  controller: AbortController,
  send: (result: unknown) => void,
): Promise<void> {
  let first = true
  const hooks: AgentHooks = {
    onEvent: (event) => {
      if (event.type !== 'token' || !event.delta) return
      send(artifactEvent(taskId, contextId, [{ kind: 'text', text: event.delta }], !first, false))
      first = false
    },
  }
  try {
    const agent = await ctx.resolveAgent(contextId)
    const result = await agent.run(
      partsToRunInput(message.parts),
      runOptions(taskId, contextId, controller.signal, hooks),
    )
    send(
      first
        ? {
            ...artifactEvent(taskId, contextId, [], false, true),
            artifact: resultToArtifact(result.output, result.object ?? undefined),
          }
        : artifactEvent(taskId, contextId, [], true, true),
    )
    const state = finalState(ctx, result)
    const finalTask = makeTask(taskId, contextId, state, textParts(result.output))
    await ctx.taskStore?.set(finalTask)
    notify(ctx, taskId, finalTask)
    send(statusEvent(taskId, contextId, state))
  } catch (error) {
    const state: A2ATaskState = controller.signal.aborted ? 'canceled' : 'failed'
    const finalTask = makeTask(taskId, contextId, state)
    await ctx.taskStore?.set(finalTask)
    notify(ctx, taskId, finalTask)
    send(statusEvent(taskId, contextId, state, error instanceof Error ? error.message : undefined))
  }
}

function handleStream(
  ctx: ServerContext,
  message: A2AMessage,
  push: A2APushNotificationConfig | undefined,
  id: Id,
): Response {
  const { contextId, taskId } = idsFor(message)
  if (push) ctx.pushConfigs.set(taskId, push)
  const controller = linkedController()
  ctx.inflight.set(taskId, controller)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (result: unknown) =>
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(rpcResult(id, result))}\n\n`))
      send(makeTask(taskId, contextId, 'working'))
      void pump(ctx, message, taskId, contextId, controller, send).finally(() => {
        ctx.inflight.delete(taskId)
        ctrl.close()
      })
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

async function handleTasksGet(ctx: ServerContext, params: unknown, id: Id): Promise<Response> {
  const taskId = (params as { id?: string })?.id
  if (!taskId) return json(rpcError(id, -32602, 'Invalid params: id required'))
  if (!ctx.taskStore) return json(rpcError(id, -32601, 'tasks/get not supported (no taskStore)'))
  const found = await ctx.taskStore.get(taskId)
  return found
    ? json(rpcResult(id, found))
    : json(rpcError(id, -32001, `Task not found: ${taskId}`))
}

async function handleTasksCancel(ctx: ServerContext, params: unknown, id: Id): Promise<Response> {
  const taskId = (params as { id?: string })?.id
  if (!taskId) return json(rpcError(id, -32602, 'Invalid params: id required'))
  const controller = ctx.inflight.get(taskId)
  if (controller) {
    controller.abort()
    const existing = await ctx.taskStore?.get(taskId)
    const canceled = makeTask(taskId, existing?.contextId ?? crypto.randomUUID(), 'canceled')
    await ctx.taskStore?.set(canceled)
    return json(rpcResult(id, canceled))
  }
  const existing = await ctx.taskStore?.get(taskId)
  return existing
    ? json(rpcError(id, -32002, `Task not cancelable (state: ${existing.status.state})`))
    : json(rpcError(id, -32001, `Task not found: ${taskId}`))
}

function handlePushSet(ctx: ServerContext, params: unknown, id: Id): Response {
  const { taskId, pushNotificationConfig } =
    (params as { taskId?: string; pushNotificationConfig?: A2APushNotificationConfig }) ?? {}
  if (!taskId || !pushNotificationConfig?.url) {
    return json(
      rpcError(id, -32602, 'Invalid params: taskId + pushNotificationConfig.url required'),
    )
  }
  ctx.pushConfigs.set(taskId, pushNotificationConfig)
  return json(rpcResult(id, { taskId, pushNotificationConfig }))
}

function handlePushGet(ctx: ServerContext, params: unknown, id: Id): Response {
  const taskId = (params as { id?: string })?.id
  if (!taskId) return json(rpcError(id, -32602, 'Invalid params: id required'))
  const config = ctx.pushConfigs.get(taskId)
  return config
    ? json(rpcResult(id, { taskId, pushNotificationConfig: config }))
    : json(rpcError(id, -32001, `No push config for task: ${taskId}`))
}

async function dispatch(ctx: ServerContext, request: Request): Promise<Response> {
  let rpc: JsonRpcRequest
  try {
    rpc = (await request.json()) as JsonRpcRequest
  } catch {
    return json(rpcError(null, -32700, 'Parse error'))
  }
  const id = rpc?.id ?? null
  const params = rpc?.params as
    | {
        message?: A2AMessage
        configuration?: { pushNotificationConfig?: A2APushNotificationConfig }
      }
    | undefined
  const message = params?.message
  const push = params?.configuration?.pushNotificationConfig
  const needsMessage = rpc?.method === 'message/send' || rpc?.method === 'message/stream'
  if (needsMessage && !message?.parts) {
    return json(rpcError(id, -32602, 'Invalid params: message.parts required'))
  }

  switch (rpc?.method) {
    case 'message/send':
      return handleSend(ctx, message as A2AMessage, push, id)
    case 'message/stream':
      return handleStream(ctx, message as A2AMessage, push, id)
    case 'tasks/get':
      return handleTasksGet(ctx, rpc.params, id)
    case 'tasks/cancel':
      return handleTasksCancel(ctx, rpc.params, id)
    case 'tasks/pushNotificationConfig/set':
      return handlePushSet(ctx, rpc.params, id)
    case 'tasks/pushNotificationConfig/get':
      return handlePushGet(ctx, rpc.params, id)
    default:
      return json(rpcError(id, -32601, `Method not found: ${rpc?.method}`))
  }
}

/**
 * Build an {@link A2AServer} that proxies A2A requests to `agent.run`.
 *
 * @example
 * ```ts
 * const a2a = serveA2A(agent, { url: 'https://me/a2a', version: '1.0.0', taskStore: new InMemoryA2ATaskStore() })
 * Bun.serve({
 *   fetch(req) {
 *     const { pathname } = new URL(req.url)
 *     if (pathname === '/.well-known/agent-card.json') return Response.json(a2a.card)
 *     if (pathname === '/a2a') return a2a.handle(req)
 *     return new Response('not found', { status: 404 })
 *   },
 * })
 * ```
 */
export function serveA2A(agent: IAgent | A2AAgentResolver, options: ServeA2AOptions): A2AServer {
  const ctx: ServerContext = {
    resolveAgent: typeof agent === 'function' ? agent : () => agent,
    taskStore: options.taskStore,
    inflight: new Map(),
    pushConfigs: new Map(),
    needsInput: options.needsInput,
    fetchImpl: options.fetch ?? fetch,
  }
  const cardName = options.name ?? (typeof agent === 'function' ? 'agent' : agent.name)
  const card = buildAgentCard(cardName, options)
  return { card, handle: (request) => dispatch(ctx, request) }
}
