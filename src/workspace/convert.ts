import { dirname } from 'node:path';
import { parseManifest, type LoadedManifest } from './manifest.ts';
import type { Workflow, WorkflowResult } from '../daemon/workflow.ts';
import type { WorkspaceRun } from './types.ts';

/**
 * A `workflow.json` as a workspace manifest.
 *
 * A workflow is a strictly sequential list, which is exactly the graph where
 * each step depends on the one before it. Expressing it that way means there is
 * one engine rather than two, and `run_workflow` keeps working unchanged —
 * including its most important behaviour, that a failed step stops the rest.
 *
 * Paths are already absolute by the time `parseWorkflow` is done, so the base
 * directory here only has to be somewhere sensible for the run to be rooted at.
 */
export function workflowToManifest(workflow: Workflow): LoadedManifest {
  const root = dirname(workflow.steps[0].cwd);
  const nodes: Record<string, unknown> = {};

  workflow.steps.forEach((step, index) => {
    const previous = workflow.steps[index - 1];
    nodes[step.name] = {
      kind: 'other',
      dependsOn: previous ? [previous.name] : [],
      providers: {
        local: {
          target: {
            cwd: step.cwd,
            name: step.target,
            ...(step.branch ? { branch: step.branch } : {}),
            ...(step.checkout ? { checkout: step.checkout } : {}),
            ...(step.deviceId ? { device: step.deviceId } : {}),
          },
          ready: step.until,
          timeoutMs: step.timeoutMs,
        },
      },
    };
  });

  return {
    manifest: parseManifest({ name: workflow.name, nodes }, root),
    // Synthetic: a workflow has no committed manifest, but the engine keys runs
    // by path, and two different workflows must not collide.
    manifestPath: `workflow:${workflow.name}:${workflow.steps[0].cwd}`,
    root,
  };
}

/** A workspace run, in the shape `run_workflow` has always returned. */
export function toWorkflowResult(workflow: Workflow, run: WorkspaceRun): WorkflowResult {
  const steps = workflow.steps.map((step) => {
    const node = run.nodes[step.name];
    const status = node?.status === 'ready' || node?.status === 'external'
      ? 'ready' as const
      : node?.status === 'failed' ? 'failed' as const : 'skipped' as const;
    return {
      name: step.name,
      root: step.cwd,
      status,
      ...(node?.sessionId ? { session: node.sessionId } : {}),
      ...(node?.url ? { url: node.url } : {}),
      elapsedMs: node?.elapsedMs ?? 0,
      ...(status === 'failed' && node?.error ? { error: node.error } : {}),
    };
  });

  const ok = steps.every((step) => step.status === 'ready');
  return {
    name: workflow.name,
    ok,
    steps,
    next: ok
      ? 'Use the returned URLs or device sessions to exercise the flow. Read session_summary only when needed; readiness does not prove visual or business correctness.'
      : 'Inspect the failed step. Started sessions are retained for debugging; stop only these session IDs when finished.',
  };
}
