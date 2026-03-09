// Narrow plugin-sdk surface for the bundled diagnostics-cls plugin.
// Keep this list additive and scoped to symbols used under extensions/diagnostics-cls.

export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
export { registerLogTransport } from "../logging/logger.js";
export { redactSensitiveText } from "../logging/redact.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginHookAgentContext,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
  PluginHookMessageReceivedEvent,
  PluginHookMessageContext,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginHookBeforeMessageWriteEvent,
} from "../plugins/types.js";
