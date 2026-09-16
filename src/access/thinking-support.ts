import type { PiThinkingLevel } from '../runtime/pi/index.js';

/**
 * Provider/model compatibility guard for Pi thinking levels.
 *
 * Verified against Google's official model documentation:
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
 *
 * google/gemini-3.8-flash supports thinking levels: low, medium, high.
 * Passing "minimal" returns HTTP 400. Because Pi 0.85.1 maps "off" to
 * MINIMAL internally, "off" is also unsupported through this pinned SDK.
 *
 * This guard does NOT claim all Gemini-3 variants share this restriction.
 * Only the exact provider+id pair below is checked; all others pass through.
 */

const SUPPORTED: Record<string, ReadonlySet<string>> = {
  'google/gemini-3.8-flash': new Set(['low', 'medium', 'high']),
};

export function assertPiThinkingSupported(
  model: { readonly provider: string; readonly id: string },
  level: PiThinkingLevel,
): void {
  const key = `${model.provider}/${model.id}`;
  const allowed = SUPPORTED[key];
  if (allowed === undefined) {
    // Unknown provider/model identity — no opinion, do nothing.
    return;
  }
  if (!allowed.has(level as string)) {
    const supported = [...allowed].join(', ');
    throw new Error(
      `Thinking level "${level}" is not supported for ${key}. ` +
        `Supported levels: ${supported}. ` +
        `See https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash`,
    );
  }
}
