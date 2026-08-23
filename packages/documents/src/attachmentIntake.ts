export type AttachmentKind =
  'archive' | 'audio' | 'data' | 'document' | 'image' | 'video';

export interface SupportedAttachmentFormat {
  readonly extension: string;
  readonly kind: AttachmentKind;
  readonly mediaType: string;
}

export const SUPPORTED_ATTACHMENT_FORMATS = [
  { extension: 'pdf', kind: 'document', mediaType: 'application/pdf' },
  {
    extension: 'docx',
    kind: 'document',
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    extension: 'xlsx',
    kind: 'document',
    mediaType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    extension: 'pptx',
    kind: 'document',
    mediaType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  { extension: 'jpg', kind: 'image', mediaType: 'image/jpeg' },
  { extension: 'jpeg', kind: 'image', mediaType: 'image/jpeg' },
  { extension: 'png', kind: 'image', mediaType: 'image/png' },
  { extension: 'gif', kind: 'image', mediaType: 'image/gif' },
  { extension: 'webp', kind: 'image', mediaType: 'image/webp' },
  { extension: 'mp3', kind: 'audio', mediaType: 'audio/mpeg' },
  { extension: 'm4a', kind: 'audio', mediaType: 'audio/mp4' },
  { extension: 'wav', kind: 'audio', mediaType: 'audio/wav' },
  { extension: 'mp4', kind: 'video', mediaType: 'video/mp4' },
  { extension: 'mov', kind: 'video', mediaType: 'video/quicktime' },
  { extension: 'csv', kind: 'data', mediaType: 'text/csv' },
  { extension: 'json', kind: 'data', mediaType: 'application/json' },
  { extension: 'vcf', kind: 'data', mediaType: 'text/vcard' },
  { extension: 'zip', kind: 'archive', mediaType: 'application/zip' },
] as const satisfies readonly SupportedAttachmentFormat[];

export interface AttachmentLimits {
  readonly maxBytes: number;
}

export interface AttachmentCandidate {
  readonly state: 'attachment_candidate';
  readonly sourceId: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly mediaType: string;
  readonly kind: AttachmentKind;
  readonly sizeBytes: number;
  readonly originalBytes: Uint8Array;
  readonly warnings: readonly string[];
}

export type AttachmentIntakeErrorCode =
  | 'EMPTY_ATTACHMENT'
  | 'INVALID_LIMITS'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_TYPE';

export class AttachmentIntakeError extends Error {
  readonly code: AttachmentIntakeErrorCode;

  constructor(code: AttachmentIntakeErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentIntakeError';
    this.code = code;
  }
}

export async function prepareAttachmentCandidate(
  upload: {
    readonly bytes: Uint8Array;
    readonly declaredMediaType: string;
    readonly filename: string;
  },
  limits: AttachmentLimits,
): Promise<AttachmentCandidate> {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new AttachmentIntakeError(
      'INVALID_LIMITS',
      'The Attachment byte limit must be a positive safe integer.',
    );
  }
  if (upload.bytes.byteLength === 0) {
    throw new AttachmentIntakeError(
      'EMPTY_ATTACHMENT',
      'Empty files cannot be staged as Attachments.',
    );
  }
  if (upload.bytes.byteLength > limits.maxBytes) {
    throw new AttachmentIntakeError(
      'SIZE_LIMIT_EXCEEDED',
      `The Attachment exceeds the ${limits.maxBytes}-byte session limit.`,
    );
  }

  const filename = leafFilename(upload.filename);
  const extension = filename.match(/\.([^.]+)$/u)?.[1]?.toLowerCase();
  const format = SUPPORTED_ATTACHMENT_FORMATS.find(
    (candidate) => candidate.extension === extension,
  );
  if (format === undefined) {
    throw new AttachmentIntakeError(
      'UNSUPPORTED_TYPE',
      'This synthetic Attachment intake does not accept that file type.',
    );
  }

  const originalBytes = Uint8Array.from(upload.bytes);
  const declaredMediaType = normalizeMediaType(upload.declaredMediaType);
  const warnings =
    declaredMediaType.length === 0 || declaredMediaType === format.mediaType
      ? []
      : [
          `The browser reported ${declaredMediaType}; this synthetic fixture classified the file by its .${format.extension} extension.`,
        ];

  return {
    state: 'attachment_candidate',
    sourceId: `sha256:${await sha256(originalBytes)}`,
    filename,
    declaredMediaType,
    mediaType: format.mediaType,
    kind: format.kind,
    sizeBytes: originalBytes.byteLength,
    originalBytes,
    warnings,
  };
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function leafFilename(filename: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1)?.trim();
  return leaf === undefined || leaf.length === 0 ? 'unnamed' : leaf;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
