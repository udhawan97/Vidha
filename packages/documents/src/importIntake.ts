export type SupportedTextMediaType = 'text/markdown' | 'text/plain';
export type ScanVerdict = 'clean' | 'malicious' | 'unavailable';
export type ScanIsolationProfile =
  'isolated_process_no_network' | 'synthetic_fixture';

export interface UntrustedUpload {
  readonly bytes: Uint8Array;
  readonly declaredMediaType: string;
  readonly filename: string;
}

export interface ImportLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

export interface QuarantinedImport {
  readonly state: 'quarantined';
  readonly sourceId: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly detectedMediaType: SupportedTextMediaType;
  readonly sizeBytes: number;
  readonly originalBytes: Uint8Array;
  readonly warnings: readonly string[];
}

export interface ImportScanResult {
  readonly scannerId: string;
  readonly engineVersion: string;
  readonly signatureSetVersion: string;
  readonly sourceId: string;
  readonly scannedBytes: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly isolationProfile: ScanIsolationProfile;
  readonly verdict: ScanVerdict;
}

export interface ImportInspectionPolicy {
  readonly acceptedIsolationProfiles: readonly ScanIsolationProfile[];
  readonly maxScanDurationMs: number;
}

export interface InspectedImport extends Omit<QuarantinedImport, 'state'> {
  readonly state: 'inspected';
  readonly scan: ImportScanResult;
}

export interface ApprovedTextImport extends Omit<InspectedImport, 'state'> {
  readonly state: 'approved';
  readonly text: string;
  readonly conversionWarnings: readonly string[];
}

export interface ImportScanner {
  scan(source: QuarantinedImport): Promise<ImportScanResult>;
}

export interface TextImportConverter {
  readonly converterId: string;
  convert(source: InspectedImport): Promise<{
    readonly text: string;
    readonly warnings: readonly string[];
  }>;
}

export type ImportIntakeErrorCode =
  | 'ACTIVE_CONTENT'
  | 'INVALID_LIMITS'
  | 'INVALID_UTF8'
  | 'INSPECTION_EVIDENCE_INVALID'
  | 'INSPECTION_MISMATCH'
  | 'LINE_LIMIT_EXCEEDED'
  | 'SCAN_BLOCKED'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_TYPE';

export class ImportIntakeError extends Error {
  readonly code: ImportIntakeErrorCode;

  constructor(code: ImportIntakeErrorCode, message: string) {
    super(message);
    this.name = 'ImportIntakeError';
    this.code = code;
  }
}

export interface ImportIntake {
  prepare(upload: UntrustedUpload): Promise<QuarantinedImport>;
  inspect(source: QuarantinedImport): Promise<InspectedImport>;
  approve(source: InspectedImport): Promise<ApprovedTextImport>;
}

interface CreateImportIntakeInput {
  readonly converter: TextImportConverter;
  readonly inspectionPolicy: ImportInspectionPolicy;
  readonly limits: ImportLimits;
  readonly scanner: ImportScanner;
}

export function createImportIntake({
  converter,
  inspectionPolicy,
  limits,
  scanner,
}: CreateImportIntakeInput): ImportIntake {
  validateLimits(limits);
  validateInspectionPolicy(inspectionPolicy);
  const preparedSources = new Map<string, QuarantinedImport>();
  const inspections = new Map<
    string,
    { readonly source: QuarantinedImport; readonly scan: ImportScanResult }
  >();

  return {
    async prepare(upload) {
      const filename = leafFilename(upload.filename);
      const detectedMediaType = detectSupportedTextType(filename);
      if (upload.bytes.byteLength > limits.maxBytes) {
        throw new ImportIntakeError(
          'SIZE_LIMIT_EXCEEDED',
          `The import exceeds the ${limits.maxBytes}-byte intake limit.`,
        );
      }
      const originalBytes = Uint8Array.from(upload.bytes);
      const text = decodeUtf8(originalBytes);
      const lineCount = text.length === 0 ? 0 : text.split(/\r\n?|\n/u).length;
      if (lineCount > limits.maxLines) {
        throw new ImportIntakeError(
          'LINE_LIMIT_EXCEEDED',
          `The import exceeds the ${limits.maxLines}-line intake limit.`,
        );
      }
      if (containsActiveContent(text)) {
        throw new ImportIntakeError(
          'ACTIVE_CONTENT',
          'Active HTML or script-like content cannot enter text conversion.',
        );
      }

      const normalizedDeclaredType = normalizeMediaType(
        upload.declaredMediaType,
      );
      const warnings =
        normalizedDeclaredType === detectedMediaType
          ? []
          : [
              `Declared type ${normalizedDeclaredType || 'missing'} does not match supported classification ${detectedMediaType}.`,
            ];
      const prepared: QuarantinedImport = {
        state: 'quarantined',
        sourceId: `sha256:${await sha256(originalBytes)}`,
        filename,
        declaredMediaType: normalizedDeclaredType,
        detectedMediaType,
        sizeBytes: originalBytes.byteLength,
        originalBytes,
        warnings,
      };
      preparedSources.set(prepared.sourceId, cloneQuarantined(prepared));
      return cloneQuarantined(prepared);
    },
    async inspect(source) {
      const submitted = cloneQuarantined(source);
      await assertSourceDigest(submitted);
      const prepared = preparedSources.get(submitted.sourceId);
      if (prepared === undefined) {
        throw new ImportIntakeError(
          'INSPECTION_MISMATCH',
          'Inspection requires bytes prepared by this intake.',
        );
      }
      const ownedSource = cloneQuarantined(prepared);
      const scan = {
        ...(await scanner.scan(cloneQuarantined(ownedSource))),
      };
      validateScanEvidence(scan, ownedSource, inspectionPolicy);
      inspections.set(ownedSource.sourceId, {
        source: cloneQuarantined(ownedSource),
        scan,
      });
      return {
        ...cloneQuarantined(ownedSource),
        state: 'inspected',
        scan: { ...scan },
      };
    },
    async approve(source) {
      const submitted = cloneInspected(source);
      await assertSourceDigest(submitted);
      const inspection = inspections.get(submitted.sourceId);
      if (
        inspection === undefined ||
        !sameScanEvidence(inspection.scan, submitted.scan)
      ) {
        throw new ImportIntakeError(
          'INSPECTION_MISMATCH',
          'Approval requires the exact bytes and scanner result inspected by this intake.',
        );
      }
      if (inspection.scan.verdict !== 'clean') {
        throw new ImportIntakeError(
          'SCAN_BLOCKED',
          `Conversion is blocked because ${inspection.scan.scannerId} reported ${inspection.scan.verdict}.`,
        );
      }
      const inspected: InspectedImport = {
        ...cloneQuarantined(inspection.source),
        state: 'inspected',
        scan: { ...inspection.scan },
      };
      const converted = await converter.convert(cloneInspected(inspected));
      return {
        ...cloneInspected(inspected),
        state: 'approved',
        text: converted.text,
        conversionWarnings: [...converted.warnings],
      };
    },
  };
}

export const utf8TextConverter: TextImportConverter = {
  converterId: 'vidha-utf8-text-v1',
  async convert(source) {
    return {
      text: decodeUtf8(source.originalBytes),
      warnings: [],
    };
  },
};

function validateLimits(limits: ImportLimits): void {
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes <= 0 ||
    !Number.isSafeInteger(limits.maxLines) ||
    limits.maxLines <= 0
  ) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'Import byte and line limits must be positive safe integers.',
    );
  }
}

function validateInspectionPolicy(policy: ImportInspectionPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxScanDurationMs) ||
    policy.maxScanDurationMs <= 0 ||
    policy.acceptedIsolationProfiles.length === 0 ||
    policy.acceptedIsolationProfiles.some(
      (profile) =>
        profile !== 'isolated_process_no_network' &&
        profile !== 'synthetic_fixture',
    )
  ) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'Inspection policy requires a positive duration and explicit isolation profiles.',
    );
  }
}

function validateScanEvidence(
  scan: ImportScanResult,
  source: QuarantinedImport,
  policy: ImportInspectionPolicy,
): void {
  const boundedIdentifier = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
  if (
    !boundedIdentifier.test(scan.scannerId) ||
    !boundedIdentifier.test(scan.engineVersion) ||
    !boundedIdentifier.test(scan.signatureSetVersion) ||
    scan.sourceId !== source.sourceId ||
    scan.scannedBytes !== source.sizeBytes ||
    !Number.isSafeInteger(scan.startedAt) ||
    !Number.isSafeInteger(scan.completedAt) ||
    scan.completedAt < scan.startedAt ||
    scan.completedAt - scan.startedAt > policy.maxScanDurationMs ||
    !policy.acceptedIsolationProfiles.includes(scan.isolationProfile) ||
    (scan.verdict !== 'clean' &&
      scan.verdict !== 'malicious' &&
      scan.verdict !== 'unavailable')
  ) {
    throw new ImportIntakeError(
      'INSPECTION_EVIDENCE_INVALID',
      'Scanner evidence must bind the exact bytes, bounded versions, duration, and accepted isolation profile.',
    );
  }
}

function sameScanEvidence(
  left: ImportScanResult,
  right: ImportScanResult,
): boolean {
  return (
    left.scannerId === right.scannerId &&
    left.engineVersion === right.engineVersion &&
    left.signatureSetVersion === right.signatureSetVersion &&
    left.sourceId === right.sourceId &&
    left.scannedBytes === right.scannedBytes &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.isolationProfile === right.isolationProfile &&
    left.verdict === right.verdict
  );
}

function detectSupportedTextType(filename: string): SupportedTextMediaType {
  if (/\.(md|markdown)$/iu.test(filename)) {
    return 'text/markdown';
  }
  if (/\.txt$/iu.test(filename)) {
    return 'text/plain';
  }
  throw new ImportIntakeError(
    'UNSUPPORTED_TYPE',
    'Only TXT, Markdown, and MD enter this bounded intake.',
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\u0000')) {
      throw new Error('NUL is not accepted in the text intake.');
    }
    return text;
  } catch {
    throw new ImportIntakeError(
      'INVALID_UTF8',
      'The source is not bounded UTF-8 text.',
    );
  }
}

function containsActiveContent(text: string): boolean {
  return /<\s*(script|iframe|object|embed|svg|math|link|style)\b|javascript\s*:|on\w+\s*=/iu.test(
    text,
  );
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function leafFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1)?.trim();
  return leaf === undefined || leaf.length === 0 ? 'unnamed.txt' : leaf;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function assertSourceDigest(
  source: Pick<QuarantinedImport, 'originalBytes' | 'sourceId'>,
): Promise<void> {
  if (source.sourceId !== `sha256:${await sha256(source.originalBytes)}`) {
    throw new ImportIntakeError(
      'INSPECTION_MISMATCH',
      'The import bytes no longer match their prepared source identifier.',
    );
  }
}

function cloneQuarantined(source: QuarantinedImport): QuarantinedImport {
  return {
    ...source,
    originalBytes: Uint8Array.from(source.originalBytes),
    warnings: [...source.warnings],
  };
}

function cloneInspected(source: InspectedImport): InspectedImport {
  return {
    ...source,
    originalBytes: Uint8Array.from(source.originalBytes),
    warnings: [...source.warnings],
    scan: { ...source.scan },
  };
}
