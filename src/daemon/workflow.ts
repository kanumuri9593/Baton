import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { SessionSnapshot } from '../core/types.ts';

const stepSchema = z.object({
  name: z.string().min(1).max(100),
  cwd: z.string().min(1),
  target: z.string().min(1),
  deviceId: z.string().optional(),
  branch: z.string().optional(),
  checkout: z.string().optional(),
  until: z.enum(['running', 'url']).default('running'),
  timeoutMs: z.number().int().min(1).max(120000).default(60000),
}).strict().refine((s) => !(s.branch && s.checkout), 'branch and checkout are mutually exclusive');
export const workflowSchema = z.object({
  name: z.string().min(1).max(100),
  steps: z.array(stepSchema).min(1).max(8),
}).strict();
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowResult = {
  name: string; ok: boolean;
  steps: Array<{ name: string; status: 'ready' | 'failed' | 'skipped'; session?: string; root: string; url?: string; elapsedMs: number; error?: string }>;
  next: string;
};

/** Validate every step before any process starts. File paths are relative to the plan. */
export function parseWorkflow(input: unknown, base?: string): Workflow {
  const workflow = workflowSchema.parse(input);
  const names = new Set<string>();
  for (const step of workflow.steps) {
    if (names.has(step.name)) throw new Error(`Duplicate workflow step: ${step.name}`);
    names.add(step.name);
    if (base) {
      step.cwd = resolve(base, step.cwd);
      if (step.checkout) step.checkout = resolve(base, step.checkout);
    } else if (!isAbsolute(step.cwd) || (step.checkout && !isAbsolute(step.checkout))) {
      throw new Error('RPC workflow paths must be absolute. The CLI resolves paths relative to the workflow file.');
    }
  }
  return workflow;
}

export type WorkflowHost = {
  run(step: Workflow['steps'][number], workflowName: string): Promise<SessionSnapshot>;
  wait(id: string, step: Workflow['steps'][number]): Promise<{ url?: string }>;
};

/** Sequential readiness gates: do not start dependents after a failure. No log polling. */
export async function runWorkflow(host: WorkflowHost, input: unknown): Promise<WorkflowResult> {
  const workflow = parseWorkflow(input);
  const result: WorkflowResult = { name: workflow.name, ok: true, steps: [], next: '' };
  for (const step of workflow.steps) {
    if (!result.ok) {
      result.steps.push({ name: step.name, root: step.cwd, status: 'skipped', elapsedMs: 0 });
      continue;
    }
    const start = Date.now();
    let session: SessionSnapshot | undefined;
    try {
      session = await host.run(step, workflow.name);
      const ready = await host.wait(session.id, step);
      result.steps.push({ name: step.name, root: step.cwd, session: session.id, status: 'ready', url: ready.url ?? session.url, elapsedMs: Date.now() - start });
    } catch (error) {
      result.ok = false;
      result.steps.push({ name: step.name, root: step.cwd, session: session?.id, status: 'failed', elapsedMs: Date.now() - start, error: String((error as Error).message).slice(0, 2000) });
    }
  }
  result.next = result.ok
    ? 'Use the returned URLs or device sessions to exercise the flow. Read session_summary only when needed; readiness does not prove visual or business correctness.'
    : 'Inspect the failed step. Started sessions are retained for debugging; stop only these session IDs when finished.';
  return result;
}
