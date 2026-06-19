/**
 * Persistence for A2A tasks, enabling `tasks/get` (and surviving restarts when
 * backed by a shared store). An injected port — an in-process map ships here;
 * wrap Redis/Postgres for cross-instance durability (mirrors {@link RunStore}).
 */
import type { A2ATask } from '@/a2a/types'

/** Storage port for completed/in-flight {@link A2ATask}s. */
export interface A2ATaskStore {
  get(taskId: string): Promise<A2ATask | undefined> | A2ATask | undefined
  set(task: A2ATask): Promise<void> | void
}

/** A single-process {@link A2ATaskStore} backed by a Map. */
export class InMemoryA2ATaskStore implements A2ATaskStore {
  private readonly store = new Map<string, A2ATask>()

  get(taskId: string): A2ATask | undefined {
    return this.store.get(taskId)
  }

  set(task: A2ATask): void {
    this.store.set(task.id, task)
  }
}
