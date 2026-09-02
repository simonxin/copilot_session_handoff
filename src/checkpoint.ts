import { randomUUID } from 'node:crypto'
import {
  handoffMilestoneCheckpointInputSchema,
  handoffMilestoneCheckpointSchema,
  handoffSessionSummaryCheckpointSchema,
  type HandoffAnalysisRecord,
  type HandoffMilestoneCheckpoint,
  type HandoffMilestoneCheckpointInput,
  type HandoffSessionSummaryCheckpoint,
  type PortableHandoffPackage,
} from './contract.js'

export interface FindingEvidenceLink {
  milestoneId: string
  milestoneTitle: string
  findingId: string
  statement: string
  status: HandoffMilestoneCheckpoint['findings'][number]['status']
  confidence?: string
  evidenceIds: string[]
}

export interface MilestoneValidation {
  errors: string[]
  warnings: string[]
  milestones: HandoffMilestoneCheckpoint[]
  findingEvidenceMap: FindingEvidenceLink[]
}

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

export function createMilestoneCheckpoints(
  inputs: HandoffMilestoneCheckpointInput[],
  timestamp: string,
): HandoffMilestoneCheckpoint[] {
  return handoffMilestoneCheckpointInputSchema.array().parse(inputs)
    .map((input) => handoffMilestoneCheckpointSchema.parse({
      ...input,
      kind: 'milestone',
      id: `milestone-${randomUUID()}`,
      timestamp,
    }))
}

export function milestoneCheckpoints(
  packageValue: PortableHandoffPackage,
): HandoffMilestoneCheckpoint[] {
  return packageValue.content.checkpoints.flatMap((checkpoint) => {
    const parsed = handoffMilestoneCheckpointSchema.safeParse(checkpoint)
    return parsed.success ? [parsed.data] : []
  })
}

export function validateMilestoneEvidenceLinks(
  packageValue: PortableHandoffPackage,
): MilestoneValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const milestones: HandoffMilestoneCheckpoint[] = []
  const evidenceIds = declaredEvidenceIds(packageValue, errors)
  const findingIds = new Set<string>()

  for (const [index, checkpoint] of packageValue.content.checkpoints.entries()) {
    if (checkpoint.kind !== 'milestone') continue
    const parsed = handoffMilestoneCheckpointSchema.safeParse(checkpoint)
    if (!parsed.success) {
      errors.push(
        `Milestone checkpoint at content.checkpoints[${index}] is invalid: ${
          parsed.error.issues.map((issue) => issue.message).join('; ')
        }`,
      )
      continue
    }
    milestones.push(parsed.data)
    for (const finding of parsed.data.findings) {
      if (findingIds.has(finding.id)) {
        errors.push(`Finding ID "${finding.id}" is duplicated.`)
      }
      findingIds.add(finding.id)
      const uniqueEvidenceIds = new Set(finding.evidenceIds)
      if (uniqueEvidenceIds.size !== finding.evidenceIds.length) {
        errors.push(
          `Finding "${finding.id}" contains duplicate evidence references.`,
        )
      }
      if (
        ['confirmed', 'supported'].includes(finding.status)
        && finding.evidenceIds.length === 0
      ) {
        errors.push(
          `Finding "${finding.id}" is ${finding.status} but has no evidenceIds.`,
        )
      }
      for (const evidenceId of finding.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          errors.push(
            `Finding "${finding.id}" references undeclared evidence ID "${evidenceId}".`,
          )
        }
      }
      if (
        ['hypothesis', 'unverified'].includes(finding.status)
        && finding.evidenceIds.length === 0
      ) {
        warnings.push(
          `Finding "${finding.id}" is ${finding.status} and has no evidence reference.`,
        )
      }
    }
  }

  return {
    errors,
    warnings,
    milestones,
    findingEvidenceMap: findingEvidenceLinks(milestones),
  }
}

export function findingEvidenceLinks(
  milestones: HandoffMilestoneCheckpoint[],
): FindingEvidenceLink[] {
  return milestones.flatMap((milestone) =>
    milestone.findings.map((finding) => ({
      milestoneId: milestone.id,
      milestoneTitle: milestone.title,
      findingId: finding.id,
      statement: finding.statement,
      status: finding.status,
      ...(finding.confidence ? { confidence: finding.confidence } : {}),
      evidenceIds: finding.evidenceIds,
    })))
}

export function formatMilestoneCheckpoints(
  milestones: HandoffMilestoneCheckpoint[],
): string {
  if (milestones.length === 0) return ''
  return [
    '## Milestone checkpoints',
    '',
    ...milestones.flatMap((milestone) => [
      `### ${milestone.title}`,
      ...(milestone.phase ? [`**Phase:** ${milestone.phase}`] : []),
      `**Summary:** ${milestone.summary}`,
      ...(milestone.findings.length > 0
        ? [
            '**Findings and evidence:**',
            ...milestone.findings.map((finding) => {
              const evidence = finding.evidenceIds.length > 0
                ? finding.evidenceIds.join(', ')
                : 'none declared'
              return `- [${finding.status}] ${finding.id}: ${finding.statement} (evidence: ${evidence})`
            }),
          ]
        : []),
      '',
    ]),
  ].join('\n').trimEnd()
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

function declaredEvidenceIds(
  packageValue: PortableHandoffPackage,
  errors: string[],
): Set<string> {
  const ids = new Set<string>()
  for (const [collection, values] of [
    ['evidence', packageValue.content.evidence],
    ['artifacts', packageValue.content.artifacts],
  ] as const) {
    for (const [index, value] of values.entries()) {
      if (!value || typeof value !== 'object' || !('id' in value)) continue
      const id = value.id
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(
          `${collection}[${index}].id must be a non-empty string when present.`,
        )
        continue
      }
      if (ids.has(id)) {
        errors.push(`Evidence ID "${id}" is duplicated.`)
      }
      ids.add(id)
    }
  }
  return ids
}
