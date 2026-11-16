export interface ContentStartupFailure {
  readonly reason: string;
  readonly packageId: string;
  readonly packageTitle: string;
  readonly resourceType?: string;
  readonly apiVersion?: number;
  readonly supportedApiVersions?: readonly number[];
}

/** Keep machine-readable context alongside the original diagnostic message. */
export class ContentStartupError extends Error {
  constructor(message: string, readonly failure: ContentStartupFailure, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContentStartupError";
  }
}

export function getContentStartupFailure(error: unknown): ContentStartupFailure | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof ContentStartupError) return error.failure;
    error = error.cause;
  }
  return undefined;
}
