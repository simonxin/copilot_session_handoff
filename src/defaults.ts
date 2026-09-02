import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const builtInExportDefaults = {
  format: 'bundle' as const,
  platform: 'github-copilot-cli',
  workflowId: 'copilot-cli-session-handoff-test',
  workflowRevision: 1,
  fallbackRunId: 'session-47-test',
  nodeId: 'session-summary',
  resumeObjective:
    'Continue the work summarized by the previous session checkpoint.',
  recommendedPrompt:
    'First verify the package and its evidence, then continue from the documented open questions and next steps without assuming artifacts were imported.',
}

const builtInImportDefaults = {
  platform: 'copilot-cli' as const,
}

const workflowDefaultsSchema = z.object({
  export: z.object({
    format: z.enum(['bundle', 'json'])
      .default(builtInExportDefaults.format),
    platform: z.string().min(1).default(builtInExportDefaults.platform),
    workflowId: z.string().min(1)
      .default(builtInExportDefaults.workflowId),
    workflowRevision: z.number().int().positive()
      .default(builtInExportDefaults.workflowRevision),
    fallbackRunId: z.string().min(1)
      .default(builtInExportDefaults.fallbackRunId),
    nodeId: z.string().min(1).default(builtInExportDefaults.nodeId),
    resumeObjective: z.string().min(1).default(
      builtInExportDefaults.resumeObjective,
    ),
    recommendedPrompt: z.string().min(1).default(
      builtInExportDefaults.recommendedPrompt,
    ),
    destinationDirectory: z.string().min(1).optional(),
  }).default(builtInExportDefaults),
  import: z.object({
    platform: z.enum(['copilot-cli', 'acp', 'context'])
      .default(builtInImportDefaults.platform),
  }).default(builtInImportDefaults),
}).strict()

export type HandoffWorkflowDefaults = z.infer<typeof workflowDefaultsSchema>

export async function loadWorkflowDefaults(
  filePath: string | undefined,
): Promise<HandoffWorkflowDefaults> {
  if (!filePath) return workflowDefaultsSchema.parse({})
  const path = resolve(filePath)
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  return workflowDefaultsSchema.parse(value)
}
