import type { ArtifactMedia } from '../../types/index.ts';

/**
 * Screenshot and browser-recording capture.
 *
 * Antigravity captures these with a driven browser. This project intentionally
 * does not depend on a headless browser (Playwright/CDP), so nothing is
 * captured automatically. What this module does instead is recognise media the
 * agent produced itself — for example a PNG written by a matplotlib or Pillow
 * script — so it can be attached to an artifact and rendered in the review
 * pane through `/api/files?mode=raw`.
 */

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.gif'];

function extensionOf(filePath: string): string {
  const normalized = filePath.toLowerCase();
  const dot = normalized.lastIndexOf('.');
  return dot === -1 ? '' : normalized.slice(dot);
}

/** Classifies a workspace-relative path as image, video or neither. */
export function classifyMedia(filePath: string): ArtifactMedia['kind'] | null {
  const extension = extensionOf(filePath);
  if (!extension) return null;
  // `.gif` is in both lists; treat it as an image so it renders inline.
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  return null;
}

/**
 * Turns the list of files the agent touched into renderable media entries.
 * Paths are kept workspace-relative; the UI resolves them via the files API.
 */
export function collectMediaFromFiles(filesTouched: string[]): ArtifactMedia[] {
  const seen = new Set<string>();
  const media: ArtifactMedia[] = [];

  for (const filePath of filesTouched) {
    const kind = classifyMedia(filePath);
    if (!kind || seen.has(filePath)) continue;
    seen.add(filePath);
    media.push({ kind, path: filePath, caption: filePath });
  }

  return media;
}

export interface CaptureUnavailable {
  captured: false;
  reason: string;
}

/**
 * Placeholder for driving a browser to capture a screenshot or recording.
 * Always reports unavailable: adding a headless-browser dependency is out of
 * scope for this local agent. Callers should fall back to
 * `collectMediaFromFiles` for media the agent generated on disk.
 */
export function captureBrowserMedia(): CaptureUnavailable {
  return {
    captured: false,
    reason:
      'Browser capture is not available: this agent has no headless-browser dependency. Generate the image with a script instead (matplotlib / Pillow) and it will be attached automatically.'
  };
}
