/**
 * Layer 2 — Agent Internet: A2A (Agent2Agent) wire types.
 *
 * A minimal, dependency-free subset of the A2A protocol sufficient for Phase 1
 * interop — discovery (Agent Card), `message/send`, and `message/stream` — over
 * JSON-RPC 2.0. Shapes follow A2A's `kind`-discriminated objects; extend as the
 * spec evolves. Nothing here imports a transport: the server returns a Web
 * `Response`, the client uses `fetch`.
 */

// --- Parts & messages -------------------------------------------------------

export interface A2ATextPart {
  kind: 'text'
  text: string
}
export interface A2AFilePart {
  kind: 'file'
  file: { name?: string; mimeType?: string; bytes?: string; uri?: string }
}
export interface A2ADataPart {
  kind: 'data'
  data: Record<string, unknown>
}
/** A unit of content within a message or artifact. */
export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart

export type A2ARole = 'user' | 'agent'

/** One turn of A2A conversation. */
export interface A2AMessage {
  kind: 'message'
  role: A2ARole
  parts: A2APart[]
  messageId: string
  taskId?: string
  contextId?: string
}

// --- Tasks ------------------------------------------------------------------

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'unknown'

export interface A2ATaskStatus {
  state: A2ATaskState
  message?: A2AMessage
  timestamp?: string
}

/** A result payload produced by a task. */
export interface A2AArtifact {
  artifactId: string
  name?: string
  parts: A2APart[]
}

/** A unit of work and its current state. */
export interface A2ATask {
  kind: 'task'
  id: string
  contextId: string
  status: A2ATaskStatus
  artifacts?: A2AArtifact[]
  history?: A2AMessage[]
}

/** Streaming event: the task's status changed. */
export interface A2AStatusUpdateEvent {
  kind: 'status-update'
  taskId: string
  contextId: string
  status: A2ATaskStatus
  final: boolean
}

/** Streaming event: an artifact (or chunk of one) is available. */
export interface A2AArtifactUpdateEvent {
  kind: 'artifact-update'
  taskId: string
  contextId: string
  artifact: A2AArtifact
  append?: boolean
  lastChunk?: boolean
}

// --- Agent Card (discovery) -------------------------------------------------

export interface A2AAgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
}

/** The discovery document served at `/.well-known/agent-card.json`. */
export interface A2AAgentCard {
  protocolVersion: string
  name: string
  description: string
  /** The JSON-RPC endpoint clients POST to. */
  url: string
  version: string
  capabilities: { streaming?: boolean; pushNotifications?: boolean }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: A2AAgentSkill[]
  /** Optional OpenAPI-style security scheme definitions (apiKey, oauth2, ...). */
  securitySchemes?: Record<string, unknown>
  /** Which schemes (by name) a client must satisfy. */
  security?: Array<Record<string, string[]>>
}

/** Where a server should POST task updates (for non-streaming / async clients). */
export interface A2APushNotificationConfig {
  /** Webhook URL to POST the Task to on completion. */
  url: string
  /** Optional bearer-style token echoed in an `x-a2a-notification-token` header. */
  token?: string
}

// --- JSON-RPC 2.0 envelopes -------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: unknown
}
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}
