import { randomUUID } from 'node:crypto'
import {
  handoffSessionSummaryCheckpointSchema,
  type HandoffAnalysisRecord,
  type HandoffSessionSummaryCheckpoint,
  type PortableHandoffPackage,
} from './contract.js'

export function createSessionSummaryCheckpoint(
  analysisRecord: HandoffAnalysisRecord,
  objective: string,
  timestamp: string,
): HandoffSessionSummaryCheckpoint {
  return handoffSessionSummaryCheckpointSchema.parse({
    kind: 'session-summary',
    id: `checkpoint-${randomUUID()}`,
    timestamp,
    title: 'Session handoff summary',
    summary: analysisRecord.summary,
    completedWork: analysisRecord.observations,
    decisions: analysisRecord.decisions,
    openQuestions: analysisRecord.openQuestions,
    nextSteps: analysisRecord.nextSteps,
    objective,
  })
}

export function latestSessionSummaryCheckpoint(
  packageValue: PortableHandoffPackage,
): HandoffSessionSummaryCheckpoint {
  for (
    let index = packageValue.content.checkpoints.length - 1;
    index >= 0;
    index -= 1
  ) {
    const parsed = handoffSessionSummaryCheckpointSchema.safeParse(
      packageValue.content.checkpoints[index],
    )
    if (parsed.success) return parsed.data
  }

  return {
    kind: 'session-summary',
    id: `derived-${packageValue.handoffId}`,
    timestamp: packageValue.createdAt,
    title: 'Session handoff summary',
    summary: packageValue.content.analysisRecord.summary,
    completedWork: packageValue.content.analysisRecord.observations,
    decisions: packageValue.content.analysisRecord.decisions,
    openQuestions: packageValue.content.analysisRecord.openQuestions,
    nextSteps: packageValue.content.analysisRecord.nextSteps,
    objective: packageValue.content.resumeInstructions.objective,
  }
}

export function formatCheckpoint(
  checkpoint: HandoffSessionSummaryCheckpoint,
): string {
  return [
    '## Previous session checkpoint',
    '',
    `**Summary:** ${checkpoint.summary}`,
    listSection('Completed work', checkpoint.completedWork),
    listSection('Decisions', checkpoint.decisions),
    listSection('Open questions', checkpoint.openQuestions),
    listSection('Next steps', checkpoint.nextSteps),
    '',
    `**Objective:** ${checkpoint.objective}`,
  ].filter(Boolean).join('\n')
}

export function continuationSessionName(
  packageValue: PortableHandoffPackage,
): string {
  const checkpoint = latestSessionSummaryCheckpoint(packageValue)
  const candidate = normalizeTitle(
    packageValue.source.nodeLabel
    || checkpoint.objective
    || checkpoint.summary
    || packageValue.source.nodeId,
  )
  const suffix = ' (handoff)'
  const withoutSuffix = candidate.replace(/\s*\(handoff\)$/i, '')
  const maximumLength = 80
  const available = maximumLength - suffix.length
  const title = withoutSuffix.length <= available
    ? withoutSuffix
    : `${withoutSuffix.slice(0, available - 3).trimEnd()}...`
  return `${title || 'Imported session'}${suffix}`
}

function listSection(title: string, values: unknown[]): string {
  if (values.length === 0) return ''
  return [
    '',
    `**${title}:**`,
    ...values.map((value) => `- ${displayValue(value)}`),
  ].join('\n')
}

function displayValue(value: unknown): string {
  if (
    value
    && typeof value === 'object'
    && 'item' in value
    && typeof value.item === 'string'
  ) return value.item
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
