// Bridges pi-permission-system prompts to Herdr's agent lifecycle.
//
// Problem: when pi-permission-system shows its "Permission Required" dialog,
// pi is waiting for user intervention, but Herdr still sees it as "working".
//
// How it works:
// - Herdr's pi integration (herdr integration install pi) listens on
//   pi.events for "herdr:blocked" ({active, label}) and reports the agent
//   as blocked/working/idle to Herdr.
// - pi-permission-system broadcasts "permissions:ui_prompt" immediately
//   before showing its dialog, and "permissions:decision" after every gate
//   resolution (see its docs/cross-extension-api.md).
//
// This extension pairs the two: it marks pi blocked while one or more
// permission dialogs are up, and unblocks when the user resolves them.
// Without pi-permission-system installed, the channels simply never fire
// and this extension is a no-op.

const UI_PROMPT_CHANNEL = "permissions:ui_prompt";
const DECISION_CHANNEL = "permissions:decision";
const HERDR_BLOCKED = "herdr:blocked";

// Resolutions that close a user-facing dialog. Policy/automatic resolutions
// (policy_allow, policy_deny, session_approved, infrastructure_auto_allowed,
// auto_approved) never showed a prompt, so they must not touch the counter.
const USER_RESOLUTIONS = new Set([
  "user_approved",
  "user_approved_for_session",
  "user_denied",
  "confirmation_unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildLabel(event: Record<string, unknown>): string {
  const surface = asString(event.surface);
  const value = asString(event.value);
  const subagent = isRecord(event.forwarding) ? " (Subagent)" : "";
  const what = [surface, value].filter(Boolean).join(": ");
  return what
    ? `Permission required${subagent} — ${what}`
    : `Permission required${subagent}`;
}

export default function (pi: any) {
  let pending = 0;

  pi.events.on(UI_PROMPT_CHANNEL, (raw: unknown) => {
    if (!isRecord(raw)) return;
    pending += 1;
    pi.events.emit(HERDR_BLOCKED, { active: true, label: buildLabel(raw) });
  });

  pi.events.on(DECISION_CHANNEL, (raw: unknown) => {
    if (pending === 0 || !isRecord(raw)) return;
    if (!USER_RESOLUTIONS.has(asString(raw.resolution) ?? "")) return;
    pending -= 1;
    if (pending === 0) {
      pi.events.emit(HERDR_BLOCKED, { active: false });
    }
  });
}
