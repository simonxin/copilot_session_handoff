import { createHash } from 'node:crypto'
import {
  portableHandoffPackageSchema,
  type PortableHandoffPackage,
} from './contract.js'
import { validateMilestoneEvidenceLinks } from './checkpoint.js'

const sensitiveKey = /^(authorization|credentials?|password|secret|token|api[-_]?key|client[-_]?secret|private[-_]?key|cookie|(api|access|refresh|auth|bearer)[-_]?token)$/i
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

export interface VerificationReport {
  valid: boolean
  schemaValid: boolean
  integrityValid: boolean
  secretsAbsent: boolean
  expired: boolean
  errors: string[]
  warnings: string[]
  counts?: {
    messages: number
    events: number
    checkpoints: number
    toolExecutions: number
    evidence: number
    artifacts: number
    milestones: number
    findings: number
  }
}

export function createPackage(
  value: Omit<PortableHandoffPackage, 'integrity'>,
): PortableHandoffPackage {
  const payload = portableHandoffPackageSchema
    .omit({ integrity: true })
    .parse(value)
  return portableHandoffPackageSchema.parse({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      contentHash: sha256Json(payload),
    },
  })
}

export function verifyPackage(value: unknown): {
  package?: PortableHandoffPackage
  report: VerificationReport
} {
  const parsed = portableHandoffPackageSchema.safeParse(value)
  if (!parsed.success) {
    return {
      report: {
        valid: false,
        schemaValid: false,
        integrityValid: false,
        secretsAbsent: false,
        expired: false,
        errors: parsed.error.issues.map((issue) =>
          `${issue.path.join('.') || '$'}: ${issue.message}`),
        warnings: [],
      },
    }
  }

  const packageValue = parsed.data
  const { integrity: _integrity, ...rawPayload } = packageValue
  const payload = portableHandoffPackageSchema
    .omit({ integrity: true })
    .parse(rawPayload)
  const integrityValid =
    sha256Json(payload) === packageValue.integrity.contentHash
  const sensitivePath = findSensitivePath(packageValue.content)
  const expired = packageValue.security.expiresAt
    ? isExpired(packageValue.security.expiresAt)
    : false
  const errors: string[] = []
  const warnings: string[] = []
  const milestoneValidation = validateMilestoneEvidenceLinks(packageValue)

  if (!integrityValid) errors.push('Handoff package integrity validation failed.')
  if (sensitivePath) {
    errors.push(`Handoff package contains sensitive data at "${sensitivePath}".`)
  }
  if (expired) errors.push('Handoff package has expired.')
  errors.push(...milestoneValidation.errors)
  warnings.push(...milestoneValidation.warnings)

  const content = packageValue.content
  if (
    content.evidence.length === 0
    && content.toolExecutions.length === 0
    && content.artifacts.length === 0
  ) {
    warnings.push(
      'The package contains conclusions but no evidence, tool execution, or artifact records; treat claims as unverified context.',
    )
  }
  if (content.artifacts.length > 0) {
    warnings.push(
      'Artifact references are not dereferenced automatically; authorize and verify each artifact under the importing user credential.',
    )
  }

  return {
    package: packageValue,
    report: {
      valid:
        integrityValid
        && !sensitivePath
        && !expired
        && milestoneValidation.errors.length === 0,
      schemaValid: true,
      integrityValid,
      secretsAbsent: !sensitivePath,
      expired,
      errors,
      warnings,
      counts: {
        messages: content.messages.length,
        events: content.events.length,
        checkpoints: content.checkpoints.length,
        toolExecutions: content.toolExecutions.length,
        evidence: content.evidence.length,
        artifacts: content.artifacts.length,
        milestones: milestoneValidation.milestones.length,
        findings: milestoneValidation.findingEvidenceMap.length,
      },
    },
  }
}

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : redactValue(item),
      ]),
    )
  }
  return typeof value === 'string'
    ? value.replace(bearerValue, '******')
    : value
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`)
      .join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new Error('Handoff values must be JSON serializable.')
  }
  return encoded
}

function findSensitivePath(value: unknown, path = '$.content'): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitivePath(item, `${path}[${index}]`)
      if (found) return found
    }
    return undefined
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      if (sensitiveKey.test(key) && item !== '[REDACTED]') return childPath
      const found = findSensitivePath(item, childPath)
      if (found) return found
    }
    return undefined
  }
  if (typeof value === 'string' && bearerValue.test(value)) {
    bearerValue.lastIndex = 0
    return path
  }
  bearerValue.lastIndex = 0
  return undefined
}

function isExpired(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) || timestamp <= Date.now()
}
