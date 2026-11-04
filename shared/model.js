// The AI model that reads screenshots. One place to change it: the server
// sends this id to Anthropic and the top bar shows it, so the label on screen
// can't drift from the model actually called.
export const EXTRACT_MODEL = "claude-sonnet-4-6";

// "claude-sonnet-4-6" → "Claude Sonnet 4.6". An id that doesn't fit the
// claude-<family>-<version> pattern (a dated snapshot, say) shows as-is.
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id);
  if (!m) return id;
  const [, family, major, minor] = m;
  return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}
