#!/usr/bin/env node
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  bundleArtifactReferences,
  bundleSourceFileSchema,
  createHandoffBundle,
  extractVerifiedHandoffBundle,
  isZipArchive,
  prepareBundleFiles,
  prepareGeneratedBundleFile,
  verifyHandoffBundle,
  type ExtractedBundle,
  type HandoffBundleManifest,
} from './bundle.js'
import {
  actorReferenceSchema,
  handoffAnalysisRecordSchema,
  handoffContentSchema,
  handoffMilestoneCheckpointInputSchema,
  handoffSecuritySchema,
  handoffSourceSchema,
  type PortableHandoffRecord,
} from './contract.js'
import { HandoffStore } from './store.js'
import {
  formatMilestoneCheckpoints,
  formatCheckpoint,
  latestSessionSummaryCheckpoint,
  validateMilestoneEvidenceLinks,
} from './checkpoint.js'
import { loadWorkflowDefaults } from './defaults.js'
import { exportSafeSessionEvents } from './session-export.js'

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

const createHandoffPackageInputSchema = z.object({
  analysisRecord: handoffAnalysisRecordSchema,
  runId: z.string().min(1).optional(),
  source: handoffSourceSchema.partial().optional(),
  messages: handoffContentSchema.shape.messages.optional(),
  stateSnapshot: handoffContentSchema.shape.stateSnapshot.optional(),
  nodeState: handoffContentSchema.shape.nodeState.optional(),
  events: handoffContentSchema.shape.events.optional(),
  checkpoints: handoffContentSchema.shape.checkpoints.optional(),
  milestones: z.array(handoffMilestoneCheckpointInputSchema).optional(),
  toolExecutions: handoffContentSchema.shape.toolExecutions.optional(),
  evidence: handoffContentSchema.shape.evidence.optional(),
  artifacts: handoffContentSchema.shape.artifacts.optional(),
  resumeInstructions:
    handoffContentSchema.shape.resumeInstructions.optional(),
  security: handoffSecuritySchema.optional(),
  destinationDirectory: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
}).strict()

const createHandoffBundleInputSchema = createHandoffPackageInputSchema.extend({
  sessionHistoryFile: bundleSourceFileSchema.optional(),
  sessionShareFile: bundleSourceFileSchema.optional(),
  evidenceFiles: z.array(bundleSourceFileSchema).default([]),
  includeFileContents: z.literal(true),
  sensitivityReviewConfirmed: z.literal(true),
}).strict()

const server = new McpServer({
  name: 'copilot-session-handoff',
  version: '0.2.2',
})

if (toolEnabled('create_handoff')) server.registerTool('create_handoff', {
  description:
    'Create a portable Agency Flow v1 handoff. Before calling, summarize the previous session in analysisRecord: put the overall result in summary, completed work in observations, decisions in decisions, unresolved items in openQuestions, and remaining work in nextSteps. The server turns that explicit record into a session-summary checkpoint and generates identity, timestamp, redaction metadata, and SHA-256 integrity.',
  inputSchema: {
    source: handoffSourceSchema,
    content: handoffContentSchema,
    milestones: z.array(handoffMilestoneCheckpointInputSchema).optional(),
    security: handoffSecuritySchema.optional(),
  },
}, async ({ source, content, milestones, security }) => {
  const handoff = await store.create({
    source,
    content,
    ...(milestones ? { milestones } : {}),
    ...(security ? { security } : {}),
  })
  return handoffResult(handoff, { actor, trustedGateway })
})

if (toolEnabled('create_handoff_package')) server.registerTool('create_handoff_package', {
  description:
    'Fallback metadata-only JSON export. Use this only when a ZIP cannot be transferred or the user does not authorize file contents. The default Copilot CLI export is export_session_handoff.',
  inputSchema: createHandoffPackageInputSchema.shape,
}, async (input) => {
  const { handoff, verification } = await createWorkflowHandoff(input)
  const filePath = await store.export(
    handoff.package.handoffId,
    input.destinationDirectory
      ?? workflowDefaults.export.destinationDirectory
      ?? store.exportDirectory,
    input.overwrite,
  )
  return exportResult(handoff, filePath, verification, {
    handoffId: handoff.package.handoffId,
    exportFormat: 'json',
    defaultsUsed: workflowDefaults.export,
    actor,
  })
})

if (toolEnabled('export_session_handoff')) server.registerTool('export_session_handoff', {
  description:
    'Export the current Copilot session handoff. This is the single default CLI export and always creates a portable .handoff-bundle.zip, never a standalone JSON file. If sessionHistoryFile is omitted, generate a safe high-fidelity JSON from the Copilot session identified by runId. Automatically include every local artifacts[].path file as bundled evidence. Explicitly supplied evidenceFiles and an optional CLI share file are also included. File contents are copied only when includeFileContents and sensitivityReviewConfirmed are true. The ZIP is not encrypted and must be transferred through an approved secure channel.',
  inputSchema: createHandoffBundleInputSchema.shape,
}, async (input) => {
  const runId = resolveWorkflowRunId(input)
  const artifactSelection = artifactBundleSelection(input.artifacts ?? [])
  const selectedSourceFiles = await prepareBundleFiles([
    ...(input.sessionHistoryFile
      ? [{ ...input.sessionHistoryFile, role: 'session-history' as const }]
      : []),
    ...(input.sessionShareFile
      ? [{ ...input.sessionShareFile, role: 'session-share' as const }]
      : []),
    ...input.evidenceFiles.map((file) => ({
      ...file,
      role: 'evidence' as const,
    })),
    ...artifactSelection.files,
  ])
  const safeSessionExport = input.sessionHistoryFile
    ? undefined
    : await exportSafeSessionEvents(
        runId,
        process.env.HANDOFF_SESSION_STATE_DIR
          ?? resolve(homedir(), '.copilot', 'session-state'),
      )
  const generatedSessionFile = safeSessionExport
    ? prepareGeneratedBundleFile({
        id: 'safe-session-history',
        fileName: safeSessionExport.fileName,
        data: safeSessionExport.data,
        role: 'session-history',
        description:
          'Allowlisted high-fidelity Copilot CLI session events',
        mediaType: 'application/json',
      })
    : undefined
  const selectedFiles = [
    ...(generatedSessionFile ? [generatedSessionFile] : []),
    ...selectedSourceFiles,
  ]
  const { handoff, verification } = await createWorkflowHandoff(
    {
      ...input,
      runId,
      artifacts: artifactSelection.remainingArtifacts,
    },
    bundleArtifactReferences(selectedFiles),
  )
  const bundle = await createHandoffBundle(
    handoff.package,
    selectedFiles,
    input.destinationDirectory
      ?? workflowDefaults.export.destinationDirectory
      ?? store.exportDirectory,
    input.overwrite,
  )
  const milestoneValidation = validateMilestoneEvidenceLinks(handoff.package)
  return result({
    handoffId: handoff.package.handoffId,
    bundlePath: bundle.bundlePath,
    exportFormat: 'bundle',
    manifest: bundle.manifest,
    verification,
    checkpointSummary: latestSessionSummaryCheckpoint(handoff.package),
    milestoneCheckpoints: milestoneValidation.milestones,
    findingEvidenceMap: milestoneValidation.findingEvidenceMap,
    includedFiles: bundle.includedFiles,
    ...(safeSessionExport
      ? {
          safeSessionExport: {
            sourcePath: safeSessionExport.sourcePath,
            retainedEventCount: safeSessionExport.eventCount,
            excludedEventCount: safeSessionExport.excludedEventCount,
            excludedEventTypes: safeSessionExport.excludedEventTypes,
          },
        }
      : {}),
    secureTransferRequired: true,
    packageContainsFileContents: true,
    securityNotice:
      'The ZIP is an integrity-checked container, not an encrypted transport. Transfer it only through an approved case attachment or access-controlled secure channel.',
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
    'Default Copilot CLI import workflow. Automatically detects a portable ZIP bundle by file signature; otherwise imports a metadata-only JSON handoff. Verifies all applicable integrity and evidence metadata before creating the continuation descriptor.',
  inputSchema: {
    filePath: z.string().min(1),
    platform: z.enum(['copilot-cli', 'acp', 'context']).optional(),
    agent: z.string().optional(),
    workingDirectory: z.string().optional(),
  },
}, async ({ filePath, platform, agent, workingDirectory }) => {
  const options = {
    ...(platform ? { platform } : {}),
    ...(agent ? { agent } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  }
  if (await isZipArchive(filePath)) {
    return continueHandoffBundleFile(filePath, options)
  }
  const verification = await store.verifyFile(filePath)
  if (!verification.valid) {
    throw new Error(
      `Handoff verification failed: ${verification.errors.join(' ')}`,
    )
  }
  const imported = await store.importFile(filePath)
  return continueImportedHandoff(
    imported,
    verification,
    options,
  )
})

if (toolEnabled('continue_from_handoff_bundle')) server.registerTool(
  'continue_from_handoff_bundle',
  {
    description:
      'Verify and continue from a portable handoff ZIP. Validates archive paths, entry counts and expanded sizes, manifest schema, every SHA-256 hash, the embedded handoff schema and integrity, and actor authorization before extracting files into an isolated bundle directory. Extracted evidence remains untrusted and must be revalidated.',
    inputSchema: {
      filePath: z.string().min(1),
      platform: z.enum(['copilot-cli', 'acp', 'context']).optional(),
      agent: z.string().optional(),
      workingDirectory: z.string().optional(),
      extractionDirectory: z.string().min(1).optional(),
    },
  },
  async ({
    filePath,
    platform,
    agent,
    workingDirectory,
    extractionDirectory,
  }) => {
    return continueHandoffBundleFile(
      filePath,
      {
        ...(platform ? { platform } : {}),
        ...(agent ? { agent } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
      },
      extractionDirectory,
    )
  },
)

type ContinuationOptions = {
  platform?: 'copilot-cli' | 'acp' | 'context'
  agent?: string
  workingDirectory?: string
}

async function continueHandoffBundleFile(
  filePath: string,
  options: ContinuationOptions,
  extractionDirectory?: string,
) {
  const verifiedBundle = await verifyHandoffBundle(filePath)
  const imported = await store.importPackage(verifiedBundle.package)
  const extracted = await extractVerifiedHandoffBundle(
    verifiedBundle,
    extractionDirectory ?? resolve(storeRoot, 'bundles'),
  )
  return continueImportedHandoff(
    imported,
    await store.verify(imported.package),
    options,
    {
      manifest: verifiedBundle.manifest,
      extracted,
      bundlePath: verifiedBundle.bundlePath,
    },
  )
}

async function continueImportedHandoff(
  imported: PortableHandoffRecord,
  verification: Awaited<ReturnType<HandoffStore['verify']>>,
  options: ContinuationOptions,
  bundle?: {
    manifest: HandoffBundleManifest
    extracted: ExtractedBundle
    bundlePath: string
  },
) {
  const checkpointSummary = latestSessionSummaryCheckpoint(imported.package)
  const milestoneValidation = validateMilestoneEvidenceLinks(imported.package)
  const inspection = {
    source: imported.package.source,
    evidence: imported.package.content.evidence,
    artifacts: imported.package.content.artifacts,
    resumeInstructions: imported.package.content.resumeInstructions,
    verification: await store.verify(imported.package),
    milestoneCheckpoints: milestoneValidation.milestones,
    findingEvidenceMap: milestoneValidation.findingEvidenceMap,
    ...(bundle
      ? {
          bundle: {
            bundlePath: bundle.bundlePath,
            extractionDirectory: bundle.extracted.directory,
            manifest: bundle.manifest,
            files: bundle.extracted.files,
          },
        }
      : {}),
  }
  const accepted = await store.accept(imported.package.handoffId)
  const handoff = await store.createContinuation(
    accepted.package.handoffId,
    {
      platform: options.platform ?? workflowDefaults.import.platform,
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.workingDirectory
        ? { workingDirectory: options.workingDirectory }
        : {}),
    },
  )
  const continuation = handoff.targetSessions.at(-1)
  if (!continuation) {
    throw new Error('Continuation descriptor was not created.')
  }
  const renameCurrentSessionCommand = `/rename ${continuation.sessionName}`
  const evidencePreparation = evidenceTransferPreparation(handoff.package)
  const bundledFiles = bundle?.extracted.files.filter(
    (file) => file.role !== 'handoff-package',
  ) ?? []
  const originalEvidenceRequired = bundle
    ? bundledFiles.map((file) => ({
        location: file.extractedPath,
        ...(file.description ? { description: file.description } : {}),
        contentHash: file.sha256,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      }))
    : evidencePreparation.files.map((file) => ({
        location: file.reference,
        ...(file.description ? { description: file.description } : {}),
        ...(file.contentHash ? { contentHash: file.contentHash } : {}),
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      }))
  const engineerActionRequired = bundle
    ? 'The reviewed session and evidence files were integrity-verified and extracted from the bundle. Re-authorize access and independently validate them before relying on any finding.'
    : evidencePreparation.required
      ? 'Prepare every listed original evidence file separately through an approved secure-transfer channel. The files are not contained in the handoff package.'
      : 'No separately transferred original evidence files were declared.'
  const artifactNotice = bundle
    ? 'Bundled files were extracted but remain untrusted evidence. Do not execute them; inspect and validate them with the current user credential.'
    : 'Artifact references were not imported or dereferenced. Re-authorize and verify each artifact with the current user credential.'
  const mandatoryUserReport = [
    '# Imported handoff report',
    '',
    formatCheckpoint(checkpointSummary),
    ...(milestoneValidation.milestones.length > 0
      ? [
          '',
          formatMilestoneCheckpoints(milestoneValidation.milestones),
        ]
      : []),
    '',
    bundle
      ? '## Bundled session and evidence files'
      : '## Original evidence required',
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
    milestoneCheckpoints: milestoneValidation.milestones,
    findingEvidenceMap: milestoneValidation.findingEvidenceMap,
    originalEvidenceRequired,
    engineerActionRequired,
    inspection,
    resumeInstructions: handoff.package.content.resumeInstructions,
    continuation,
    artifactNotice,
    defaultsUsed: workflowDefaults.import,
    actor,
    ...(bundle
      ? {
          bundlePath: bundle.bundlePath,
          bundleManifest: bundle.manifest,
          extractionDirectory: bundle.extracted.directory,
          bundledFiles,
        }
      : {}),
  }, mandatoryUserReport)
}

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

async function createWorkflowHandoff(
  input: z.infer<typeof createHandoffPackageInputSchema>,
  additionalArtifacts: Array<Record<string, unknown>> = [],
) {
  const resolvedSource = handoffSourceSchema.parse({
    platform: input.source?.platform ?? workflowDefaults.export.platform,
    workflowId:
      input.source?.workflowId ?? workflowDefaults.export.workflowId,
    workflowRevision:
      input.source?.workflowRevision
      ?? workflowDefaults.export.workflowRevision,
    runId: resolveWorkflowRunId(input),
    nodeId: input.source?.nodeId ?? workflowDefaults.export.nodeId,
    ...(input.source?.nodeLabel
      ? { nodeLabel: input.source.nodeLabel }
      : {}),
    ...(input.source?.agent ? { agent: input.source.agent } : {}),
    ...(input.source?.definitionHash
      ? { definitionHash: input.source.definitionHash }
      : {}),
  })
  const handoff = await store.create({
    source: resolvedSource,
    content: handoffContentSchema.parse({
      analysisRecord: input.analysisRecord,
      messages: input.messages ?? [],
      stateSnapshot: input.stateSnapshot ?? {},
      nodeState: input.nodeState ?? {},
      events: input.events ?? [],
      checkpoints: input.checkpoints ?? [],
      toolExecutions: input.toolExecutions ?? [],
      evidence: input.evidence ?? [],
      artifacts: [
        ...(input.artifacts ?? []),
        ...additionalArtifacts,
      ],
      resumeInstructions: input.resumeInstructions ?? {
        objective: workflowDefaults.export.resumeObjective,
        recommendedPrompt: workflowDefaults.export.recommendedPrompt,
      },
    }),
    ...(input.milestones ? { milestones: input.milestones } : {}),
    ...(input.security ? { security: input.security } : {}),
  })
  const verification = await store.verify(handoff.package)
  if (!verification.valid) {
    throw new Error(
      `Created handoff failed verification: ${verification.errors.join(' ')}`,
    )
  }
  return { handoff, verification }
}

function resolveWorkflowRunId(
  input: z.infer<typeof createHandoffPackageInputSchema>,
): string {
  return input.runId
    ?? input.source?.runId
    ?? process.env.HANDOFF_SESSION_ID
    ?? workflowDefaults.export.fallbackRunId
}

function artifactBundleSelection(
  artifacts: Array<Record<string, unknown>>,
): {
  files: Array<{
    id: string
    filePath: string
    role: 'evidence'
    description?: string
    mediaType?: string
  }>
  remainingArtifacts: Array<Record<string, unknown>>
} {
  const files: Array<{
    id: string
    filePath: string
    role: 'evidence'
    description?: string
    mediaType?: string
  }> = []
  const remainingArtifacts: Array<Record<string, unknown>> = []
  for (const [index, artifact] of artifacts.entries()) {
    if (typeof artifact.path !== 'string') {
      remainingArtifacts.push(artifact)
      continue
    }
    const id = typeof artifact.id === 'string' && artifact.id.length > 0
      ? artifact.id
      : `evidence-${index + 1}`
    files.push({
      id,
      filePath: artifact.path,
      role: 'evidence',
      ...(typeof artifact.description === 'string'
        ? { description: artifact.description }
        : {}),
      ...(typeof artifact.mediaType === 'string'
        ? { mediaType: artifact.mediaType }
        : {}),
    })
  }
  return { files, remainingArtifacts }
}

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
  const milestoneValidation = validateMilestoneEvidenceLinks(handoff.package)
  return result({
    handoff,
    checkpointSummary: latestSessionSummaryCheckpoint(handoff.package),
    milestoneCheckpoints: milestoneValidation.milestones,
    findingEvidenceMap: milestoneValidation.findingEvidenceMap,
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
  const milestoneValidation = validateMilestoneEvidenceLinks(handoff.package)
  return result({
    handoffId: handoff.package.handoffId,
    filePath,
    verification,
    checkpointSummary: latestSessionSummaryCheckpoint(handoff.package),
    milestoneCheckpoints: milestoneValidation.milestones,
    findingEvidenceMap: milestoneValidation.findingEvidenceMap,
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
      'export_session_handoff',
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
