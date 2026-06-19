/**
 * A2A (Agent2Agent) interop, shipped as a separate entry point
 * (`momo-agentic/a2a`). Dependency-free — server returns a Web `Response`,
 * client uses `fetch`. See {@link serveA2A} (expose a momo agent) and
 * {@link a2aAgentAsTool} (call a remote A2A agent).
 */
export { a2aAgentAsTool, fetchAgentCard } from '@/a2a/client'
export type { A2AAgentAsToolOptions, FetchLike } from '@/a2a/client'
export { serveA2A } from '@/a2a/server'
export type { A2AAgentResolver, A2AServer, ServeA2AOptions } from '@/a2a/server'
export { InMemoryA2ATaskStore } from '@/a2a/task-store'
export type { A2ATaskStore } from '@/a2a/task-store'
export { extractText, partsToRunInput, resultToArtifact } from '@/a2a/mapping'
export type {
  A2AAgentCard,
  A2AAgentSkill,
  A2AArtifact,
  A2AArtifactUpdateEvent,
  A2ADataPart,
  A2AFilePart,
  A2AMessage,
  A2APart,
  A2APushNotificationConfig,
  A2ARole,
  A2AStatusUpdateEvent,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
  A2ATextPart,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@/a2a/types'
