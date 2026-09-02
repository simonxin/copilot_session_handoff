import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { redactValue } from './security.js'

const portableEventFields: Record<string, string[]> = {
  'session.start': [
    'sessionId',
    'version',
    'producer',
    'copilotVersion',
    'startTime',
    'selectedModel',
    'reasoningEffort',
    'contextTier',
    'context',
  ],
  'session.resume': [
    'resumeTime',
    'eventCount',
    'eventsFileSizeBytes',
    'selectedModel',
    'reasoningEffort',
    'contextTier',
    'context',
  ],
  'session.model_change': [
    'source',
    'newModel',
    'previousModel',
    'reasoningEffort',
    'previousReasoningEffort',
    'contextTier',
  ],
  'session.context_changed': ['context'],
  'session.info': ['message', 'infoType'],
  'session.warning': ['message', 'warningType'],
  'session.error': ['message', 'errorType'],
  'user.message': [
    'content',
    'delivery',
    'interactionId',
    'turnId',
    'parentAgentTaskId',
  ],
  'assistant.message': [
    'messageId',
    'model',
    'content',
    'toolRequests',
    'interactionId',
    'turnId',
  ],
  'assistant.turn_start': ['turnId'],
  'assistant.turn_end': ['turnId'],
  'tool.execution_start': [
    'toolCallId',
    'toolName',
    'arguments',
    'turnId',
    'model',
  ],
  'tool.execution_complete': [
    'toolCallId',
    'model',
    'interactionId',
    'turnId',
    'success',
    'result',
  ],
  'permission.requested': [
    'requestId',
    'permissionRequest',
    'promptRequest',
  ],
  'permission.completed': ['requestId', 'toolCallId', 'result'],
  'subagent.started': [
    'toolCallId',
    'agentName',
    'agentDisplayName',
    'agentDescription',
    'model',
  ],
  'subagent.completed': [
    'toolCallId',
    'agentName',
    'agentDisplayName',
    'model',
    'totalToolCalls',
    'totalTokens',
    'durationMs',
  ],
  'session.binary_asset': ['assetId', 'type', 'mimeType', 'byteLength'],
}

const forbiddenKey = /^(reasoningOpaque|encryptedContent|toolTelemetry|hiddenReasoning|providerPrivateState|systemInstructions|credentials?|password|secret|token|api[-_]?key|client[-_]?secret|private[-_]?key|cookie|(api|access|refresh|auth|bearer)[-_]?token)$/i

export interface SafeSessionExport {
  sourcePath: string
  fileName: string
  data: Uint8Array
  eventCount: number
  excludedEventCount: number
  excludedEventTypes: Record<string, number>
}

export interface DiscoveredSessionEvidence {
  id: string
  filePath: string
  description?: string
  mediaType?: string
}

export async function discoverSessionEvidence(
  sessionId: string,
  sessionStateRoot: string,
): Promise<DiscoveredSessionEvidence[]> {
  const sourcePath = resolve(sessionStateRoot, sessionId, 'events.jsonl')
  let input: string
  try {
    input = await readFile(sourcePath, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) return []
    throw error
  }
  const candidates: Array<Omit<DiscoveredSessionEvidence, 'id'>> = []

  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(
        `Session event line ${index + 1} is not valid JSON: "${sourcePath}".`,
      )
    }
    if (!value || typeof value !== 'object') continue
    const event = value as Record<string, unknown>
    if (event.type !== 'tool.execution_start') continue
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {}
    if (
      typeof data.toolName !== 'string'
      || !isHandoffExportTool(data.toolName)
      || !data.arguments
      || typeof data.arguments !== 'object'
    ) {
      continue
    }
    const args = data.arguments as Record<string, unknown>
    collectArtifactCandidates(args.artifacts, candidates)
    collectEvidenceFileCandidates(args.evidenceFiles, candidates)
  }

  const discovered: DiscoveredSessionEvidence[] = []
  const paths = new Set<string>()
  for (const candidate of candidates) {
    const filePath = resolve(candidate.filePath)
    if (paths.has(filePath)) continue
    let status: Awaited<ReturnType<typeof lstat>>
    try {
      status = await lstat(filePath)
    } catch (error) {
      if (isNotFoundError(error)) continue
      throw error
    }
    if (!status.isFile() || status.isSymbolicLink()) continue
    paths.add(filePath)
    discovered.push({
      id: `session-evidence-${discovered.length + 1}`,
      filePath,
      ...(candidate.description
        ? { description: candidate.description }
        : {}),
      ...(candidate.mediaType ? { mediaType: candidate.mediaType } : {}),
    })
  }
  return discovered
}

export async function exportSafeSessionEvents(
  sessionId: string,
  sessionStateRoot: string,
): Promise<SafeSessionExport> {
  const sourcePath = resolve(sessionStateRoot, sessionId, 'events.jsonl')
  const input = await readFile(sourcePath, 'utf8')
  const events: Array<Record<string, unknown>> = []
  const excludedEventTypes: Record<string, number> = {}

  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(
        `Session event line ${index + 1} is not valid JSON: "${sourcePath}".`,
      )
    }
    if (!value || typeof value !== 'object') continue
    const event = value as Record<string, unknown>
    const type = typeof event.type === 'string' ? event.type : 'unknown'
    const fields = portableEventFields[type]
    if (!fields) {
      excludedEventTypes[type] = (excludedEventTypes[type] ?? 0) + 1
      continue
    }
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {}
    const portableData = Object.fromEntries(
      fields.flatMap((field) =>
        field in data ? [[field, sanitizeValue(data[field])]] : []),
    )
    events.push({
      type,
      ...(typeof event.id === 'string' ? { id: event.id } : {}),
      ...(typeof event.timestamp === 'string'
        ? { timestamp: event.timestamp }
        : {}),
      ...(typeof event.parentId === 'string'
        ? { parentId: event.parentId }
        : {}),
      data: portableData,
    })
  }

  const output = {
    schemaVersion: '1.0',
    sessionId,
    source: 'github-copilot-cli-events',
    generatedAt: new Date().toISOString(),
    safety: {
      policy: 'event-and-field-allowlist',
      excludedEventPrefixes: ['model.', 'hook.', 'system.'],
      excludedFields: [
        'reasoningOpaque',
        'encryptedContent',
        'toolTelemetry',
        'hiddenReasoning',
        'providerPrivateState',
        'systemInstructions',
        'credentials',
        'tokens',
        'cookies',
      ],
      retainedEventCount: events.length,
      excludedEventCount:
        Object.values(excludedEventTypes).reduce(
          (total, count) => total + count,
          0,
        ),
      excludedEventTypes,
    },
    events,
  }
  const data = Buffer.from(JSON.stringify(output, null, 2), 'utf8')
  return {
    sourcePath,
    fileName: `${sessionId}.safe-session-events.json`,
    data,
    eventCount: events.length,
    excludedEventCount: output.safety.excludedEventCount,
    excludedEventTypes,
  }
}

function isHandoffExportTool(toolName: string): boolean {
  return [
    'export_session_handoff',
    'create_handoff_bundle',
    'create_handoff_package',
  ].some((name) => toolName.endsWith(name))
}

function collectArtifactCandidates(
  value: unknown,
  target: Array<Omit<DiscoveredSessionEvidence, 'id'>>,
): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const artifact = item as Record<string, unknown>
    if (typeof artifact.path !== 'string') continue
    target.push({
      filePath: artifact.path,
      ...(typeof artifact.description === 'string'
        ? { description: artifact.description }
        : {}),
      ...(typeof artifact.mediaType === 'string'
        ? { mediaType: artifact.mediaType }
        : {}),
    })
  }
}

function collectEvidenceFileCandidates(
  value: unknown,
  target: Array<Omit<DiscoveredSessionEvidence, 'id'>>,
): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const evidence = item as Record<string, unknown>
    if (typeof evidence.filePath !== 'string') continue
    target.push({
      filePath: evidence.filePath,
      ...(typeof evidence.description === 'string'
        ? { description: evidence.description }
        : {}),
      ...(typeof evidence.mediaType === 'string'
        ? { mediaType: evidence.mediaType }
        : {}),
    })
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT',
  )
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value && typeof value === 'object') {
    return redactValue(Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbiddenKey.test(key))
        .map(([key, item]) => [key, sanitizeValue(item)]),
    ))
  }
  return redactValue(value)
}
