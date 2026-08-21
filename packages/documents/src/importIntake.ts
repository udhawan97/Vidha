export type SupportedTextMediaType = 'text/markdown' | 'text/plain';
export type ScanVerdict = 'clean' | 'malicious' | 'unavailable';

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
  readonly verdict: ScanVerdict;
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
  readonly limits: ImportLimits;
  readonly scanner: ImportScanner;
}

export function createImportIntake({
  converter,
  limits,
  scanner,
}: CreateImportIntakeInput): ImportIntake {
  validateLimits(limits);

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
      return {
        state: 'quarantined',
        sourceId: `sha256:${await sha256(originalBytes)}`,
        filename,
        declaredMediaType: normalizedDeclaredType,
        detectedMediaType,
        sizeBytes: originalBytes.byteLength,
        originalBytes,
        warnings,
      };
    },
    async inspect(source) {
      const scan = await scanner.scan(cloneQuarantined(source));
      return {
        ...cloneQuarantined(source),
        state: 'inspected',
        scan,
      };
    },
    async approve(source) {
      if (source.scan.verdict !== 'clean') {
        throw new ImportIntakeError(
          'SCAN_BLOCKED',
          `Conversion is blocked because ${source.scan.scannerId} reported ${source.scan.verdict}.`,
        );
      }
      const converted = await converter.convert(source);
      return {
        ...cloneInspected(source),
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
