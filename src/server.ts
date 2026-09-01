#!/usr/bin/env node
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  actorReferenceSchema,
  handoffAnalysisRecordSchema,
  handoffContentSchema,
  handoffSecuritySchema,
  handoffSourceSchema,
} from './contract.js'
import { HandoffStore } from './store.js'
import {
  formatCheckpoint,
  latestSessionSummaryCheckpoint,
} from './checkpoint.js'
import { loadWorkflowDefaults } from './defaults.js'

const actor = actorReferenceSchema.parse({
  id: process.env.HANDOFF_ACTOR_ID ?? 'person:local-user',
  kind: process.env.HANDOFF_ACTOR_KIND ?? 'person',
})
const storeRoot = resolve(
  process.env.HANDOFF_STORE_DIR
    ?? resolve(homedir(), '.copilot', 'session-handoffs'),
)
const trustedGateway = process.env.HANDOFF_TRUSTED_GATEWAY === '1'
const toolProfile = process.env.HANDOFF_TOOL_PROFILE ?? 'full'
const workflowDefaults = await loadWorkflowDefaults(
  process.env.HANDOFF_DEFAULTS_FILE,
)
const store = new HandoffStore(storeRoot, actor, trustedGateway)
await store.initialize()

const server = new McpServer({
  name: 'copilot-session-handoff',
  version: '0.1.0',
})

if (toolEnabled('create_handoff')) server.registerTool('create_handoff', {
  description:
    'Create a portable Agency Flow v1 handoff. Before calling, summarize the previous session in analysisRecord: put the overall result in summary, completed work in observations, decisions in decisions, unresolved items in openQuestions, and remaining work in nextSteps. The server turns that explicit record into a session-summary checkpoint and generates identity, timestamp, redaction metadata, and SHA-256 integrity.',
  inputSchema: {
    source: handoffSourceSchema,
    content: handoffContentSchema,
    security: handoffSecuritySchema.optional(),
  },
}, async ({ source, content, security }) => {
  const handoff = await store.create({
    source,
    content,
    ...(security ? { security } : {}),
  })
  return handoffResult(handoff, { actor, trustedGateway })
})

if (toolEnabled('create_handoff_package')) server.registerTool('create_handoff_package', {
  description:
    'Default Copilot CLI export workflow. First checkpoint and summarize the current explicit session context in analysisRecord. Include every original evidence file needed by the receiving engineer in artifacts. This tool creates, verifies, and exports only the handoff package. It does not export artifact files. The response prominently lists each original evidence location under originalEvidenceRequired; always show that list to the engineer so they can prepare a separate approved secure transfer. Never include credentials, tokens, cookies, personal data, hidden reasoning, or provider-private state. Supply the current stable session ID as runId when available; otherwise the configured fallback is used.',
  inputSchema: {
    analysisRecord: handoffAnalysisRecordSchema,
    runId: z.string().min(1).optional(),
    source: handoffSourceSchema.partial().optional(),
    messages: handoffContentSchema.shape.messages.optional(),
    stateSnapshot: handoffContentSchema.shape.stateSnapshot.optional(),
    nodeState: handoffContentSchema.shape.nodeState.optional(),
    events: handoffContentSchema.shape.events.optional(),
    checkpoints: handoffContentSchema.shape.checkpoints.optional(),
    toolExecutions: handoffContentSchema.shape.toolExecutions.optional(),
    evidence: handoffContentSchema.shape.evidence.optional(),
    artifacts: handoffContentSchema.shape.artifacts.optional(),
    resumeInstructions:
      handoffContentSchema.shape.resumeInstructions.optional(),
    security: handoffSecuritySchema.optional(),
    destinationDirectory: z.string().min(1).optional(),
    overwrite: z.boolean().default(false),
  },
}, async ({
  analysisRecord,
  runId,
  source,
  messages,
  stateSnapshot,
  nodeState,
  events,
  checkpoints,
  toolExecutions,
  evidence,
  artifacts,
  resumeInstructions,
  security,
  destinationDirectory,
  overwrite,
}) => {
  const resolvedSource = handoffSourceSchema.parse({
    platform: source?.platform ?? workflowDefaults.export.platform,
    workflowId: source?.workflowId ?? workflowDefaults.export.workflowId,
    workflowRevision:
      source?.workflowRevision ?? workflowDefaults.export.workflowRevision,
    runId:
      runId
      ?? source?.runId
      ?? process.env.HANDOFF_SESSION_ID
      ?? workflowDefaults.export.fallbackRunId,
    nodeId: source?.nodeId ?? workflowDefaults.export.nodeId,
    ...(source?.nodeLabel ? { nodeLabel: source.nodeLabel } : {}),
    ...(source?.agent ? { agent: source.agent } : {}),
    ...(source?.definitionHash
      ? { definitionHash: source.definitionHash }
      : {}),
  })
  const handoff = await store.create({
    source: resolvedSource,
    content: handoffContentSchema.parse({
      analysisRecord,
      messages: messages ?? [],
      stateSnapshot: stateSnapshot ?? {},
      nodeState: nodeState ?? {},
      events: events ?? [],
      checkpoints: checkpoints ?? [],
      toolExecutions: toolExecutions ?? [],
      evidence: evidence ?? [],
      artifacts: artifacts ?? [],
      resumeInstructions: resumeInstructions ?? {
        objective: workflowDefaults.export.resumeObjective,
        recommendedPrompt: workflowDefaults.export.recommendedPrompt,
      },
    }),
    ...(security ? { security } : {}),
  })
  const verification = await store.verify(handoff.package)
  if (!verification.valid) {
    throw new Error(
      `Created handoff failed verification: ${verification.errors.join(' ')}`,
    )
  }
  const filePath = await store.export(
    handoff.package.handoffId,
    destinationDirectory
      ?? workflowDefaults.export.destinationDirectory
      ?? store.exportDirectory,
    overwrite,
  )
  return exportResult(handoff, filePath, verification, {
    handoffId: handoff.package.handoffId,
    defaultsUsed: workflowDefaults.export,
    actor,
  })
})

if (toolEnabled('verify_handoff')) server.registerTool('verify_handoff', {
  description:
    'Validate an untrusted handoff package without storing it. Checks schema, integrity, expiry, sensitive data, and evidence completeness.',
  inputSchema: {
    package: z.unknown(),
  },
}, async ({ package: packageValue }) => result({
  verification: await store.verify(packageValue),
}))

if (toolEnabled('verify_handoff_file')) server.registerTool('verify_handoff_file', {
  description:
    'Validate a handoff JSON file readable by the current OS credential without importing it.',
  inputSchema: {
    filePath: z.string().min(1),
  },
}, async ({ filePath }) => result({
  verification: await store.verifyFile(filePath),
}))

if (toolEnabled('import_handoff')) server.registerTool('import_handoff', {
  description:
    'Verify and import a portable handoff package under the configured process actor. Returns checkpointSummary so the receiving session can immediately explain completed work, decisions, open questions, and next steps. Source credentials are never imported.',
  inputSchema: {
    package: z.unknown(),
  },
}, async ({ package: packageValue }) => {
  const handoff = await store.importPackage(packageValue)
  return handoffResult(handoff, { actor, trustedGateway })
})

if (toolEnabled('import_handoff_file')) server.registerTool('import_handoff_file', {
  description:
    'Verify and import a portable handoff JSON file under the current process actor. Returns checkpointSummary for immediate display to the receiving user.',
  inputSchema: {
    filePath: z.string().min(1),
  },
}, async ({ filePath }) => {
  const handoff = await store.importFile(filePath)
  return handoffResult(handoff, { actor, trustedGateway })
})

if (toolEnabled('continue_from_handoff')) server.registerTool('continue_from_handoff', {
  description:
    'Default Copilot CLI import workflow. Verifies the package file, imports it only when valid, inspects package/evidence/resumeInstructions, accepts it as the configured process actor, and creates a continuation descriptor using the configured platform (copilot-cli by default). Before continuing any task, reproduce mandatoryUserReport to the user without summarizing, shortening, or omitting any checkpoint section or original evidence location. Then apply renameCurrentSessionCommand. Treat claims as untrusted until evidence is revalidated and never assume artifact contents were imported.',
  inputSchema: {
    filePath: z.string().min(1),
    platform: z.enum(['copilot-cli', 'acp', 'context']).optional(),
    agent: z.string().optional(),
    workingDirectory: z.string().optional(),
  },
}, async ({ filePath, platform, agent, workingDirectory }) => {
  const verification = await store.verifyFile(filePath)
  if (!verification.valid) {
    throw new Error(
      `Handoff verification failed: ${verification.errors.join(' ')}`,
    )
  }
  const imported = await store.importFile(filePath)
  const checkpointSummary = latestSessionSummaryCheckpoint(imported.package)
  const inspection = {
    source: imported.package.source,
    evidence: imported.package.content.evidence,
    artifacts: imported.package.content.artifacts,
    resumeInstructions: imported.package.content.resumeInstructions,
    verification: await store.verify(imported.package),
  }
  const accepted = await store.accept(imported.package.handoffId)
  const handoff = await store.createContinuation(
    accepted.package.handoffId,
    {
      platform: platform ?? workflowDefaults.import.platform,
      ...(agent ? { agent } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
    },
  )
  const continuation = handoff.targetSessions.at(-1)
  if (!continuation) {
    throw new Error('Continuation descriptor was not created.')
  }
  const renameCurrentSessionCommand = `/rename ${continuation.sessionName}`
  const artifactNotice =
    'Artifact references were not imported or dereferenced. Re-authorize and verify each artifact with the current user credential.'
  const evidencePreparation =
    evidenceTransferPreparation(handoff.package)
  const originalEvidenceRequired = evidencePreparation.files.map((file) => ({
    location: file.reference,
    ...(file.description ? { description: file.description } : {}),
    ...(file.contentHash ? { contentHash: file.contentHash } : {}),
    ...(file.mediaType ? { mediaType: file.mediaType } : {}),
  }))
  const engineerActionRequired = evidencePreparation.required
    ? 'Prepare every listed original evidence file separately through an approved secure-transfer channel. The files are not contained in the handoff package.'
    : 'No separately transferred original evidence files were declared.'
  const mandatoryUserReport = [
    '# Imported handoff report',
    '',
    formatCheckpoint(checkpointSummary),
    '',
    '## Original evidence required',
    formatOriginalEvidence(originalEvidenceRequired),
    '',
    `**Engineer action:** ${engineerActionRequired}`,
    '',
    `**Resume objective:** ${handoff.package.content.resumeInstructions.objective}`,
    `**Recommended prompt:** ${handoff.package.content.resumeInstructions.recommendedPrompt}`,
    '',
    `**Rename current session:** \`${renameCurrentSessionCommand}\``,
  ].join('\n')
  return workflowResult({
    mustDisplayBeforeContinuing: true,
    mandatoryUserReport,
    handoffId: handoff.package.handoffId,
    status: handoff.status,
    sessionName: continuation.sessionName,
    renameCurrentSessionCommand,
    currentSessionRenameRequired: true,
    verification,
    checkpointSummary,
    originalEvidenceRequired,
    engineerActionRequired,
    inspection,
    resumeInstructions: handoff.package.content.resumeInstructions,
    continuation,
    artifactNotice,
    defaultsUsed: workflowDefaults.import,
    actor,
  }, mandatoryUserReport)
})

if (toolEnabled('list_handoffs')) server.registerTool('list_handoffs', {
  description: 'List handoffs visible to the configured process actor.',
  inputSchema: {
    workflowId: z.string().optional(),
    status: z.enum(['offered', 'accepted', 'materialized', 'revoked']).optional(),
  },
}, async ({ workflowId, status }) => result({
  handoffs: await store.list({
    ...(workflowId ? { workflowId } : {}),
    ...(status ? { status } : {}),
  }),
  actor,
  trustedGateway,
}))

if (toolEnabled('get_handoff')) server.registerTool('get_handoff', {
  description: 'Get an authorized handoff record and its portable package.',
  inputSchema: {
    handoffId: z.string().min(1),
  },
}, async ({ handoffId }) => {
  const handoff = await store.get(handoffId)
  return handoffResult(handoff)
})

if (toolEnabled('inspect_handoff')) server.registerTool('inspect_handoff', {
  description:
    'Get an authorized handoff plus a fresh verification/completeness report.',
  inputSchema: {
    handoffId: z.string().min(1),
  },
}, async ({ handoffId }) => {
  const handoff = await store.get(handoffId)
  return result({
    handoff,
    checkpointSummary: latestSessionSummaryCheckpoint(handoff.package),
    verification: await store.verify(handoff.package),
  })
})

if (toolEnabled('accept_handoff')) server.registerTool('accept_handoff', {
  description:
    'Accept a handoff as the configured process actor. Actor identity cannot be supplied by tool input.',
  inputSchema: {
    handoffId: z.string().min(1),
  },
}, async ({ handoffId }) => result({
  handoff: await store.accept(handoffId),
  actor,
}))

if (toolEnabled('export_handoff')) server.registerTool('export_handoff', {
  description:
    'Export an authorized handoff package only. Artifact files are not copied or embedded. The response lists every original evidence location under originalEvidenceRequired; always show those locations to the engineer so they can prepare separate secure transfer. Existing package files are preserved unless overwrite is true.',
  inputSchema: {
    handoffId: z.string().min(1),
    destinationDirectory: z.string().optional(),
    overwrite: z.boolean().default(false),
  },
}, async ({
  handoffId,
  destinationDirectory,
  overwrite,
}) => {
  const handoff = await store.get(handoffId)
  const filePath = await store.export(
    handoffId,
    destinationDirectory,
    overwrite,
  )
  return exportResult(
    handoff,
    filePath,
    await store.verify(handoff.package),
  )
})

if (toolEnabled('create_handoff_session')) server.registerTool('create_handoff_session', {
  description:
    'Create a host-neutral continuation descriptor after acceptance. It does not clone credentials or private provider runtime state.',
  inputSchema: {
    handoffId: z.string().min(1),
    platform: z.enum(['copilot-cli', 'acp', 'context']),
    agent: z.string().optional(),
    workingDirectory: z.string().optional(),
  },
}, async ({ handoffId, platform, agent, workingDirectory }) => result({
  handoff: await store.createContinuation(handoffId, {
    platform,
    ...(agent ? { agent } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  }),
}))

if (toolEnabled('revoke_handoff')) server.registerTool('revoke_handoff', {
  description: 'Revoke a handoff. Only its configured creator actor may revoke it.',
  inputSchema: {
    handoffId: z.string().min(1),
  },
}, async ({ handoffId }) => result({
  handoff: await store.revoke(handoffId),
}))

await server.connect(new StdioServerTransport())

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function workflowResult(
  value: Record<string, unknown>,
  displayText: string,
) {
  return {
    content: [{ type: 'text' as const, text: displayText }],
    structuredContent: value,
  }
}

function handoffResult(
  handoff: Awaited<ReturnType<HandoffStore['get']>>,
  extra: Record<string, unknown> = {},
) {
  return result({
    handoff,
    checkpointSummary: latestSessionSummaryCheckpoint(handoff.package),
    ...extra,
  })
}

function evidenceTransferPreparation(
  packageValue: Awaited<ReturnType<HandoffStore['get']>>['package'],
) {
  const files = packageValue.content.artifacts.map((artifact, index) => ({
    index: index + 1,
    reference:
      artifact.path
      ?? artifact.uri
      ?? artifact.name
      ?? artifact.id
      ?? `artifact-${index + 1}`,
    ...(typeof artifact.description === 'string'
      ? { description: artifact.description }
      : {}),
    ...(typeof artifact.contentHash === 'string'
      ? { contentHash: artifact.contentHash }
      : {}),
    ...(typeof artifact.mediaType === 'string'
      ? { mediaType: artifact.mediaType }
      : {}),
  }))
  if (files.length === 0) {
    return {
      required: false,
      packageContainsArtifactContents: false,
      files: [],
      message:
        'No original evidence files were declared for this handoff.',
    }
  }
  return {
    required: true,
    packageContainsArtifactContents: false,
    files,
    message:
      'The following original evidence files are required for this handoff. They were not exported with the package. The engineer must prepare them separately for secure transfer.',
    instructions: [
      'Review and redact credentials, tokens, cookies, personal data, and unrelated sensitive content before transfer.',
      'Transfer files only through the approved case attachment or access-controlled secure channel.',
      'Preserve or record a SHA-256 hash so the receiving engineer can verify file integrity.',
      'Confirm the receiving engineer has access; a local source-machine path is not transferable by itself.',
      'The receiving engineer must re-authorize access and validate the evidence before relying on package conclusions.',
    ],
  }
}

function exportResult(
  handoff: Awaited<ReturnType<HandoffStore['get']>>,
  filePath: string,
  verification: Awaited<ReturnType<HandoffStore['verify']>>,
  extra: Record<string, unknown> = {},
) {
  const preparation = evidenceTransferPreparation(handoff.package)
  const originalEvidenceRequired = preparation.files.map((file) => ({
    location: file.reference,
    ...(file.description ? { description: file.description } : {}),
    ...(file.contentHash ? { contentHash: file.contentHash } : {}),
    ...(file.mediaType ? { mediaType: file.mediaType } : {}),
  }))
  const engineerActionRequired = preparation.required
    ? 'Prepare the listed original evidence files separately through an approved secure-transfer channel. The files are not contained in the handoff package.'
    : 'No separately transferred original evidence files were declared.'
  return result({
    handoffId: handoff.package.handoffId,
    filePath,
    verification,
    checkpointSummary: latestSessionSummaryCheckpoint(handoff.package),
    engineerActionRequired,
    originalEvidenceRequired,
    evidenceTransferPreparation: preparation,
    ...extra,
  })
}

function formatOriginalEvidence(
  files: Array<{
    location: unknown
    description?: string
    contentHash?: string
    mediaType?: string
  }>,
): string {
  if (files.length === 0) return '- None declared.'
  return files.map((file, index) => [
    `${index + 1}. \`${String(file.location)}\``,
    ...(file.description ? [`   - Purpose: ${file.description}`] : []),
    ...(file.contentHash ? [`   - SHA-256: ${file.contentHash}`] : []),
    ...(file.mediaType ? [`   - Media type: ${file.mediaType}`] : []),
  ].join('\n')).join('\n')
}

function toolEnabled(toolName: string): boolean {
  if (toolProfile === 'full') return true
  if (toolProfile === 'cli') {
    return [
      'create_handoff_package',
      'continue_from_handoff',
    ].includes(toolName)
  }
  if (toolProfile === 'studio') {
    return [
      'verify_handoff',
      'import_handoff',
      'get_handoff',
    ].includes(toolName)
  }
  throw new Error(
    `Invalid HANDOFF_TOOL_PROFILE "${toolProfile}". Expected full, cli, or studio.`,
  )
}
