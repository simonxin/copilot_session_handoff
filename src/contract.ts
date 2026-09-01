import { z } from 'zod'

export const actorKinds = ['agent', 'person', 'team', 'role', 'system'] as const

export const actorReferenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(actorKinds),
}).strict()

export const handoffAnalysisRecordSchema = z.object({
  summary: z.string(),
  hypotheses: z.array(z.unknown()).default([]),
  observations: z.array(z.unknown()).default([]),
  decisions: z.array(z.unknown()).default([]),
  rejectedAlternatives: z.array(z.unknown()).default([]),
  confidence: z.string().optional(),
  openQuestions: z.array(z.unknown()).default([]),
  nextSteps: z.array(z.unknown()).default([]),
}).strict()

export const handoffSourceSchema = z.object({
  platform: z.string().min(1),
  workflowId: z.string().min(1),
  workflowRevision: z.number().int().positive(),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  nodeLabel: z.string().optional(),
  agent: z.string().optional(),
  definitionHash: z.string().optional(),
}).strict()

export const handoffMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.unknown(),
  timestamp: z.string(),
  sourceEventId: z.string().optional(),
}).strict()

export const handoffSessionSummaryCheckpointSchema = z.object({
  kind: z.literal('session-summary'),
  id: z.string().min(1),
  timestamp: z.string(),
  title: z.string().min(1),
  summary: z.string(),
  completedWork: z.array(z.unknown()).default([]),
  decisions: z.array(z.unknown()).default([]),
  openQuestions: z.array(z.unknown()).default([]),
  nextSteps: z.array(z.unknown()).default([]),
  objective: z.string(),
}).strict()

export const handoffContentSchema = z.object({
  analysisRecord: handoffAnalysisRecordSchema,
  messages: z.array(handoffMessageSchema).default([]),
  stateSnapshot: z.record(z.string(), z.unknown()).default({}),
  nodeState: z.record(z.string(), z.unknown()).default({}),
  events: z.array(z.record(z.string(), z.unknown())).default([]),
  checkpoints: z.array(z.record(z.string(), z.unknown())).default([]),
  toolExecutions: z.array(z.record(z.string(), z.unknown())).default([]),
  evidence: z.array(z.unknown()).default([]),
  artifacts: z.array(z.record(z.string(), z.unknown())).default([]),
  resumeInstructions: z.object({
    objective: z.string(),
    recommendedPrompt: z.string(),
  }).strict(),
}).strict()

export const handoffSecuritySchema = z.object({
  classification: z.string().default('internal'),
  dataBoundary: z.enum(['local-only', 'tenant', 'region', 'external'])
    .default('local-only'),
  allowedActors: z.array(actorReferenceSchema).default([]),
  expiresAt: z.string().optional(),
  redactionStatus: z.enum(['secrets-redacted', 'review-required'])
    .default('secrets-redacted'),
  excludedFields: z.array(z.string()).default([
    'credentials',
    'oauthTokens',
    'providerPrivateState',
    'hiddenReasoning',
  ]),
}).strict()

export const portableHandoffPackageSchema = z.object({
  schemaVersion: z.literal('1.0'),
  handoffId: z.string().min(1),
  createdAt: z.string(),
  createdBy: actorReferenceSchema,
  source: handoffSourceSchema,
  content: handoffContentSchema,
  security: handoffSecuritySchema,
  integrity: z.object({
    algorithm: z.literal('sha256'),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict()

export const handoffTargetSessionSchema = z.object({
  id: z.string(),
  platform: z.enum(['copilot-cli', 'acp', 'context']),
  sessionRef: z.string(),
  sessionName: z.string(),
  agent: z.string().optional(),
  createdAt: z.string(),
  createdBy: actorReferenceSchema,
  status: z.enum(['created', 'initialized', 'failed']),
  initialResponse: z.string().optional(),
  launchDescriptor: z.record(z.string(), z.unknown()).optional(),
}).strict()

export const portableHandoffRecordSchema = z.object({
  package: portableHandoffPackageSchema,
  status: z.enum(['offered', 'accepted', 'materialized', 'revoked']),
  acceptedAt: z.string().optional(),
  acceptedBy: actorReferenceSchema.optional(),
  updatedAt: z.string(),
  targetSessions: z.array(handoffTargetSessionSchema).default([]),
}).strict()

export type ActorReference = z.infer<typeof actorReferenceSchema>
export type HandoffAnalysisRecord = z.infer<typeof handoffAnalysisRecordSchema>
export type HandoffContent = z.infer<typeof handoffContentSchema>
export type HandoffSecurity = z.infer<typeof handoffSecuritySchema>
export type HandoffSessionSummaryCheckpoint = z.infer<
  typeof handoffSessionSummaryCheckpointSchema
>
export type HandoffSource = z.infer<typeof handoffSourceSchema>
export type HandoffTargetSession = z.infer<typeof handoffTargetSessionSchema>
export type PortableHandoffPackage = z.infer<typeof portableHandoffPackageSchema>
export type PortableHandoffRecord = z.infer<typeof portableHandoffRecordSchema>
