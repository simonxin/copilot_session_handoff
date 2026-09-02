import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate'
import { z } from 'zod'
import {
  portableHandoffPackageSchema,
  type PortableHandoffPackage,
} from './contract.js'
import { verifyPackage } from './security.js'

const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024
const MAX_BUNDLE_CONTENT_BYTES = 250 * 1024 * 1024
const MAX_BUNDLE_FILE_BYTES = 250 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100

export const bundleSourceFileSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  description: z.string().optional(),
  mediaType: z.string().optional(),
}).strict()

export const bundleFileRoleSchema = z.enum([
  'session-history',
  'session-share',
  'evidence',
])

export const handoffBundleManifestEntrySchema = z.object({
  id: z.string().min(1),
  role: z.enum([
    'handoff-package',
    'session-history',
    'session-share',
    'evidence',
  ]),
  archivePath: z.string().min(1),
  fileName: z.string().min(1),
  description: z.string().optional(),
  mediaType: z.string().optional(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export const handoffBundleManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  bundleId: z.string().min(1),
  handoffId: z.string().min(1),
  createdAt: z.string(),
  classification: z.string(),
  contentReviewConfirmed: z.literal(true),
  excludedContent: z.array(z.string()),
  entries: z.array(handoffBundleManifestEntrySchema),
}).strict()

export type BundleSourceFile = z.infer<typeof bundleSourceFileSchema>
export type BundleFileRole = z.infer<typeof bundleFileRoleSchema>
export type HandoffBundleManifest = z.infer<
  typeof handoffBundleManifestSchema
>
export type HandoffBundleManifestEntry = z.infer<
  typeof handoffBundleManifestEntrySchema
>

export interface PreparedBundleFile {
  sourcePath: string
  data: Uint8Array
  entry: HandoffBundleManifestEntry
}

export function prepareGeneratedBundleFile(input: {
  id: string
  fileName: string
  data: Uint8Array
  role: BundleFileRole
  description?: string
  mediaType?: string
}): PreparedBundleFile {
  const id = bundleSourceFileSchema.shape.id.parse(input.id)
  const fileName = safeName(input.fileName)
  const role = bundleFileRoleSchema.parse(input.role)
  const folder = role === 'evidence' ? 'evidence' : 'session'
  const archivePath = `${folder}/${safeName(id)}-${fileName}`
  return {
    sourcePath: '<generated>',
    data: input.data,
    entry: {
      id,
      role,
      archivePath,
      fileName,
      ...(input.description ? { description: input.description } : {}),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      size: input.data.byteLength,
      sha256: sha256(input.data),
    },
  }
}

export interface VerifiedHandoffBundle {
  manifest: HandoffBundleManifest
  package: PortableHandoffPackage
  files: Unzipped
  bundlePath: string
}

export interface ExtractedBundle {
  directory: string
  packageFilePath: string
  files: Array<HandoffBundleManifestEntry & { extractedPath: string }>
}

export async function isZipArchive(filePath: string): Promise<boolean> {
  const handle = await open(resolve(filePath), 'r')
  try {
    const signature = Buffer.alloc(4)
    const { bytesRead } = await handle.read(signature, 0, 4, 0)
    if (bytesRead !== 4) return false
    return (
      signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      || signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
      || signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))
    )
  } finally {
    await handle.close()
  }
}

export async function prepareBundleFiles(
  inputs: Array<BundleSourceFile & { role: BundleFileRole }>,
): Promise<PreparedBundleFile[]> {
  const parsed = inputs.map((input) => {
    const { role, ...source } = input
    return {
      ...bundleSourceFileSchema.parse(source),
      role: bundleFileRoleSchema.parse(role),
    }
  })
  const ids = new Set<string>()
  const archivePaths = new Set<string>()
  const prepared: PreparedBundleFile[] = []
  let totalSize = 0

  for (const input of parsed) {
    if (ids.has(input.id)) {
      throw new Error(`Bundle file ID "${input.id}" is duplicated.`)
    }
    ids.add(input.id)
    const sourcePath = resolve(input.filePath)
    const sourceStat = await lstat(sourcePath)
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Bundle source "${sourcePath}" must not be a symlink.`)
    }
    if (!sourceStat.isFile()) {
      throw new Error(`Bundle source "${sourcePath}" is not a regular file.`)
    }
    if (sourceStat.size > MAX_SOURCE_FILE_BYTES) {
      throw new Error(
        `Bundle source "${sourcePath}" exceeds the 100 MiB per-file limit.`,
      )
    }
    totalSize += sourceStat.size
    if (totalSize > MAX_BUNDLE_CONTENT_BYTES) {
      throw new Error('Bundle sources exceed the 250 MiB total limit.')
    }

    const data = new Uint8Array(await readFile(sourcePath))
    const folder = input.role === 'evidence' ? 'evidence' : 'session'
    const archivePath = uniqueArchivePath(
      `${folder}/${safeName(input.id)}-${safeName(basename(sourcePath))}`,
      archivePaths,
    )
    archivePaths.add(archivePath)
    prepared.push({
      sourcePath,
      data,
      entry: {
        id: input.id,
        role: input.role,
        archivePath,
        fileName: basename(sourcePath),
        ...(input.description ? { description: input.description } : {}),
        ...(input.mediaType ? { mediaType: input.mediaType } : {}),
        size: data.byteLength,
        sha256: sha256(data),
      },
    })
  }
  return prepared
}

export function bundleArtifactReferences(
  files: PreparedBundleFile[],
): Array<Record<string, unknown>> {
  return files.map(({ entry }) => ({
    id: entry.id,
    uri: `bundle://${entry.archivePath}`,
    description:
      entry.description
      ?? `${entry.role} file included in the portable handoff bundle`,
    ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
    contentHash: entry.sha256,
    size: entry.size,
    bundled: true,
  }))
}

export async function createHandoffBundle(
  packageValue: PortableHandoffPackage,
  files: PreparedBundleFile[],
  destinationDirectory: string,
  overwrite: boolean,
): Promise<{
  bundlePath: string
  manifest: HandoffBundleManifest
  includedFiles: Array<
    HandoffBundleManifestEntry & { sourcePath: string }
  >
}> {
  const packageData = Buffer.from(
    JSON.stringify(packageValue, null, 2),
    'utf8',
  )
  const packageEntry: HandoffBundleManifestEntry = {
    id: 'handoff-package',
    role: 'handoff-package',
    archivePath: 'handoff.agent-handoff.json',
    fileName: 'handoff.agent-handoff.json',
    description: 'Structured portable session handoff package',
    mediaType: 'application/json',
    size: packageData.byteLength,
    sha256: sha256(packageData),
  }
  const manifest = handoffBundleManifestSchema.parse({
    schemaVersion: '1.0',
    bundleId: `bundle-${randomUUID()}`,
    handoffId: packageValue.handoffId,
    createdAt: new Date().toISOString(),
    classification: packageValue.security.classification,
    contentReviewConfirmed: true,
    excludedContent: [
      'credentials',
      'oauthTokens',
      'cookies',
      'providerPrivateState',
      'hiddenReasoning',
      'systemInstructions',
      'reasoningOpaque',
      'encryptedContent',
      'toolTelemetry',
    ],
    entries: [packageEntry, ...files.map(({ entry }) => entry)],
  })
  const checksums = checksumFile(manifest.entries)
  const zipInput: Zippable = {
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    'handoff.agent-handoff.json': packageData,
    'checksums.sha256': Buffer.from(checksums, 'utf8'),
  }
  for (const file of files) zipInput[file.entry.archivePath] = file.data

  const bundleData = zipSync(zipInput, { level: 6 })
  await mkdir(resolve(destinationDirectory), { recursive: true })
  const bundlePath = join(
    resolve(destinationDirectory),
    `${packageValue.handoffId}.handoff-bundle.zip`,
  )
  await atomicWrite(bundlePath, bundleData, overwrite)
  return {
    bundlePath,
    manifest,
    includedFiles: files.map(({ sourcePath, entry }) => ({
      ...entry,
      sourcePath,
    })),
  }
}

export async function verifyHandoffBundle(
  bundlePath: string,
): Promise<VerifiedHandoffBundle> {
  const resolvedPath = resolve(bundlePath)
  const bundleStat = await lstat(resolvedPath)
  if (bundleStat.isSymbolicLink() || !bundleStat.isFile()) {
    throw new Error('Handoff bundle must be a regular ZIP file.')
  }
  if (bundleStat.size > MAX_BUNDLE_FILE_BYTES) {
    throw new Error('Handoff bundle exceeds the 250 MiB archive limit.')
  }

  let entryCount = 0
  let expandedSize = 0
  const archiveEntryNames = new Set<string>()
  const archiveData = new Uint8Array(await readFile(resolvedPath))
  const files = unzipSync(archiveData, {
    filter: (entry) => {
      entryCount += 1
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error('Handoff bundle exceeds the 100-entry limit.')
      }
      assertSafeArchivePath(entry.name)
      if (archiveEntryNames.has(entry.name)) {
        throw new Error(`Archive entry "${entry.name}" is duplicated.`)
      }
      archiveEntryNames.add(entry.name)
      if (entry.originalSize > MAX_SOURCE_FILE_BYTES) {
        throw new Error(
          `Archive entry "${entry.name}" exceeds the 100 MiB limit.`,
        )
      }
      expandedSize += entry.originalSize
      if (expandedSize > MAX_BUNDLE_CONTENT_BYTES) {
        throw new Error('Expanded handoff bundle exceeds the 250 MiB limit.')
      }
      return true
    },
  })
  const manifest = handoffBundleManifestSchema.parse(
    parseJsonEntry(files, 'manifest.json'),
  )
  const packageValue = portableHandoffPackageSchema.parse(
    parseJsonEntry(files, 'handoff.agent-handoff.json'),
  )
  const packageVerification = verifyPackage(packageValue).report
  if (!packageVerification.valid) {
    throw new Error(
      `Bundled handoff package is invalid: ${
        packageVerification.errors.join(' ')
      }`,
    )
  }
  if (manifest.handoffId !== packageValue.handoffId) {
    throw new Error('Bundle manifest handoffId does not match the package.')
  }
  validateManifestEntries(manifest, packageValue)

  const expectedPaths = new Set([
    'manifest.json',
    'checksums.sha256',
    ...manifest.entries.map((entry) => entry.archivePath),
  ])
  for (const path of Object.keys(files)) {
    if (!expectedPaths.has(path)) {
      throw new Error(`Archive contains unmanifested entry "${path}".`)
    }
  }
  for (const path of expectedPaths) {
    if (!(path in files)) {
      throw new Error(`Archive is missing required entry "${path}".`)
    }
  }
  for (const entry of manifest.entries) {
    const data = files[entry.archivePath]
    if (!data) throw new Error(`Archive entry "${entry.archivePath}" is missing.`)
    if (data.byteLength !== entry.size) {
      throw new Error(`Archive entry "${entry.archivePath}" size mismatch.`)
    }
    if (sha256(data) !== entry.sha256) {
      throw new Error(`Archive entry "${entry.archivePath}" hash mismatch.`)
    }
  }
  const actualChecksums = Buffer.from(
    files['checksums.sha256'] ?? new Uint8Array(),
  ).toString('utf8')
  if (actualChecksums !== checksumFile(manifest.entries)) {
    throw new Error('Bundle checksum file does not match the manifest.')
  }
  return { manifest, package: packageValue, files, bundlePath: resolvedPath }
}

export async function extractVerifiedHandoffBundle(
  verified: VerifiedHandoffBundle,
  destinationRoot: string,
): Promise<ExtractedBundle> {
  const directory = join(resolve(destinationRoot), verified.manifest.bundleId)
  await mkdir(resolve(destinationRoot), { recursive: true })
  await mkdir(directory)
  try {
    for (const [archivePath, data] of Object.entries(verified.files)) {
      const outputPath = safeExtractionPath(directory, archivePath)
      await mkdir(resolve(outputPath, '..'), { recursive: true })
      await writeFile(outputPath, data, { flag: 'wx' })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const files = verified.manifest.entries.map((entry) => ({
    ...entry,
    extractedPath: safeExtractionPath(directory, entry.archivePath),
  }))
  return {
    directory,
    packageFilePath: safeExtractionPath(
      directory,
      'handoff.agent-handoff.json',
    ),
    files,
  }
}

function parseJsonEntry(files: Unzipped, path: string): unknown {
  const data = files[path]
  if (!data) throw new Error(`Archive is missing "${path}".`)
  try {
    return JSON.parse(Buffer.from(data).toString('utf8'))
  } catch {
    throw new Error(`Archive entry "${path}" is not valid JSON.`)
  }
}

function checksumFile(entries: HandoffBundleManifestEntry[]): string {
  return `${entries.map((entry) =>
    `${entry.sha256}  ${entry.archivePath}`).join('\n')}\n`
}

function validateManifestEntries(
  manifest: HandoffBundleManifest,
  packageValue: PortableHandoffPackage,
): void {
  const ids = new Set<string>()
  const paths = new Set<string>()
  const artifacts = new Map(
    packageValue.content.artifacts.flatMap((artifact) =>
      typeof artifact.id === 'string' ? [[artifact.id, artifact]] : []),
  )
  for (const entry of manifest.entries) {
    assertSafeArchivePath(entry.archivePath)
    if (ids.has(entry.id)) {
      throw new Error(`Bundle manifest ID "${entry.id}" is duplicated.`)
    }
    if (paths.has(entry.archivePath)) {
      throw new Error(
        `Bundle manifest path "${entry.archivePath}" is duplicated.`,
      )
    }
    ids.add(entry.id)
    paths.add(entry.archivePath)
    if (entry.role === 'handoff-package') {
      if (
        entry.id !== 'handoff-package'
        || entry.archivePath !== 'handoff.agent-handoff.json'
      ) {
        throw new Error('Bundle handoff package entry is invalid.')
      }
      continue
    }
    const artifact = artifacts.get(entry.id)
    if (!artifact) {
      throw new Error(
        `Bundle entry "${entry.id}" has no matching handoff artifact.`,
      )
    }
    if (
      artifact.uri !== `bundle://${entry.archivePath}`
      || artifact.contentHash !== entry.sha256
      || artifact.size !== entry.size
      || artifact.bundled !== true
    ) {
      throw new Error(
        `Bundle entry "${entry.id}" does not match its handoff artifact metadata.`,
      )
    }
  }
}

function assertSafeArchivePath(path: string): void {
  if (
    path.length === 0
    || path.includes('\\')
    || path.startsWith('/')
    || /^[A-Za-z]:/.test(path)
    || path.split('/').some((part) => part === '' || part === '..' || part === '.')
  ) {
    throw new Error(`Archive contains unsafe path "${path}".`)
  }
}

function safeExtractionPath(root: string, archivePath: string): string {
  assertSafeArchivePath(archivePath)
  const outputPath = resolve(root, ...archivePath.split('/'))
  const rootPrefix = `${resolve(root)}${sep}`
  if (!outputPath.startsWith(rootPrefix)) {
    throw new Error(`Archive path "${archivePath}" escapes extraction root.`)
  }
  return outputPath
}

function uniqueArchivePath(
  candidate: string,
  existing: Set<string>,
): string {
  if (!existing.has(candidate)) return candidate
  const dot = candidate.lastIndexOf('.')
  const stem = dot > candidate.lastIndexOf('/')
    ? candidate.slice(0, dot)
    : candidate
  const extension = dot > candidate.lastIndexOf('/')
    ? candidate.slice(dot)
    : ''
  let index = 2
  while (existing.has(`${stem}-${index}${extension}`)) index += 1
  return `${stem}-${index}${extension}`
}

function safeName(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'file'
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function atomicWrite(
  path: string,
  data: Uint8Array,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    await writeFile(path, data, { flag: 'wx' })
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { flag: 'wx' })
  try {
    await rm(path, { force: true })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
