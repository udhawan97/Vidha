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
  readonly intakeId: string;
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
  readonly signatureSetIdentity: string;
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

export interface ReviewableTextImport extends Omit<InspectedImport, 'state'> {
  readonly state: 'reviewable';
  readonly converterId: string;
  readonly text: string;
  readonly conversionWarnings: readonly string[];
}

export interface ApprovedTextImport extends Omit<
  ReviewableTextImport,
  'state'
> {
  readonly state: 'approved';
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
  | 'CONVERSION_OUTPUT_INVALID'
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
  review(source: InspectedImport): Promise<ReviewableTextImport>;
  approve(source: ReviewableTextImport): Promise<ApprovedTextImport>;
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
  const reviews = new Map<string, ReviewableTextImport>();
  const converterId = converter.converterId;
  const convert = converter.convert.bind(converter);
  let intakeSequence = 0;

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
        intakeId: `intake-${++intakeSequence}`,
        sourceId: `sha256:${await sha256(originalBytes)}`,
        filename,
        declaredMediaType: normalizedDeclaredType,
        detectedMediaType,
        sizeBytes: originalBytes.byteLength,
        originalBytes,
        warnings,
      };
      preparedSources.set(prepared.intakeId, cloneQuarantined(prepared));
      return cloneQuarantined(prepared);
    },
    async inspect(source) {
      const submitted = cloneQuarantined(source);
      await assertSourceDigest(submitted);
      const prepared = preparedSources.get(submitted.intakeId);
      if (prepared === undefined || !samePreparedSource(prepared, submitted)) {
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
      inspections.set(ownedSource.intakeId, {
        source: cloneQuarantined(ownedSource),
        scan,
      });
      return {
        ...cloneQuarantined(ownedSource),
        state: 'inspected',
        scan: { ...scan },
      };
    },
    async review(source) {
      const submitted = cloneInspected(source);
      await assertSourceDigest(submitted);
      const inspection = inspections.get(submitted.intakeId);
      if (
        inspection === undefined ||
        !samePreparedSource(inspection.source, submitted) ||
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
      const converted = await convert(cloneInspected(inspected));
      const validated = validateConvertedText(converted, converterId, limits);
      const reviewable: ReviewableTextImport = {
        ...cloneInspected(inspected),
        state: 'reviewable',
        converterId: validated.converterId,
        text: validated.text,
        conversionWarnings: validated.warnings,
      };
      reviews.set(reviewable.intakeId, cloneReviewable(reviewable));
      return cloneReviewable(reviewable);
    },
    async approve(source) {
      const submitted = cloneReviewable(source);
      await assertSourceDigest(submitted);
      const reviewed = reviews.get(submitted.intakeId);
      if (reviewed === undefined || !sameReview(reviewed, submitted)) {
        throw new ImportIntakeError(
          'INSPECTION_MISMATCH',
          'Approval requires the exact converted copy and warnings reviewed through this intake.',
        );
      }
      return {
        ...cloneReviewable(reviewed),
        state: 'approved',
      };
    },
  };
}

export const utf8TextConverter: TextImportConverter = {
  converterId: 'vidha-utf8-text-v1',
  async convert(source) {
    return {
      text: decodeUtf8(source.originalBytes),
      warnings: [
        source.detectedMediaType === 'text/markdown'
          ? 'Markdown formatting will remain editable source text.'
          : 'Plain text has no formatting metadata; line breaks will be preserved.',
      ],
    };
  },
};

function validateConvertedText(
  converted: unknown,
  converterId: unknown,
  limits: ImportLimits,
): {
  readonly converterId: string;
  readonly text: string;
  readonly warnings: readonly string[];
} {
  if (typeof converted !== 'object' || converted === null) {
    invalidConversionOutput();
  }
  let text: unknown;
  let warningValues: unknown;
  try {
    const candidate = converted as { text?: unknown; warnings?: unknown };
    text = candidate.text;
    warningValues = candidate.warnings;
  } catch {
    invalidConversionOutput();
  }
  if (typeof text !== 'string' || !Array.isArray(warningValues)) {
    invalidConversionOutput();
  }
  let warnings: unknown[];
  try {
    warnings = Array.from(warningValues);
  } catch {
    invalidConversionOutput();
  }
  const encodedBytes = new TextEncoder().encode(text).byteLength;
  const lineCount = text.length === 0 ? 0 : text.split(/\r\n?|\n/u).length;
  const boundedIdentifier = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
  if (
    typeof converterId !== 'string' ||
    !boundedIdentifier.test(converterId) ||
    encodedBytes > limits.maxBytes ||
    lineCount > limits.maxLines ||
    hasDisallowedConvertedTextControl(text) ||
    warnings.length > 16 ||
    warnings.some(
      (warning) =>
        typeof warning !== 'string' ||
        warning.length === 0 ||
        warning.length > 500 ||
        hasDisallowedConvertedControl(warning),
    )
  ) {
    invalidConversionOutput();
  }
  return {
    converterId,
    text,
    warnings: warnings as string[],
  };
}

function invalidConversionOutput(): never {
  throw new ImportIntakeError(
    'CONVERSION_OUTPUT_INVALID',
    'Converted text and warnings must remain within the bounded Editable Document contract.',
  );
}

function hasDisallowedConvertedControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10) ||
      codePoint === 127
    );
  });
}

function hasDisallowedConvertedTextControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    );
  });
}

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
  const signatureSetIdentity = /^sha256-[a-f0-9]{64}$/u;
  if (
    !boundedIdentifier.test(scan.scannerId) ||
    !boundedIdentifier.test(scan.engineVersion) ||
    !signatureSetIdentity.test(scan.signatureSetIdentity) ||
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
    left.signatureSetIdentity === right.signatureSetIdentity &&
    left.signatureSetVersion === right.signatureSetVersion &&
    left.sourceId === right.sourceId &&
    left.scannedBytes === right.scannedBytes &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.isolationProfile === right.isolationProfile &&
    left.verdict === right.verdict
  );
}

function samePreparedSource(
  left: Omit<QuarantinedImport, 'state'>,
  right: Omit<QuarantinedImport, 'state'>,
): boolean {
  return (
    left.intakeId === right.intakeId &&
    left.sourceId === right.sourceId &&
    left.filename === right.filename &&
    left.declaredMediaType === right.declaredMediaType &&
    left.detectedMediaType === right.detectedMediaType &&
    left.sizeBytes === right.sizeBytes &&
    left.warnings.length === right.warnings.length &&
    left.warnings.every((warning, index) => warning === right.warnings[index])
  );
}

function sameReview(
  left: ReviewableTextImport,
  right: ReviewableTextImport,
): boolean {
  return (
    sameScanEvidence(left.scan, right.scan) &&
    samePreparedSource(left, right) &&
    left.converterId === right.converterId &&
    left.text === right.text &&
    left.conversionWarnings.length === right.conversionWarnings.length &&
    left.conversionWarnings.every(
      (warning, index) => warning === right.conversionWarnings[index],
    )
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

function cloneReviewable(source: ReviewableTextImport): ReviewableTextImport {
  const inspected: InspectedImport = {
    ...source,
    state: 'inspected',
  };
  return {
    ...cloneInspected(inspected),
    state: 'reviewable',
    converterId: source.converterId,
    text: source.text,
    conversionWarnings: [...source.conversionWarnings],
  };
}
