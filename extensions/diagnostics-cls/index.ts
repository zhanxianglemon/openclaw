import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookBeforeMessageWriteEvent,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "openclaw/plugin-sdk/diagnostics-cls";
import { createDiagnosticsClsTraceService } from "./src/service.js";

const plugin = {
  id: "diagnostics-cls",
  name: "Diagnostics CLS",
  description: "将诊断 trace 事件和运行日志上传到腾讯云日志服务（CLS）",
  register(api: OpenClawPluginApi) {
    const service = createDiagnosticsClsTraceService(api.pluginConfig);
    api.registerService(service);

    // 通过 Plugin Hook 实现零磁盘实时流：直接在模型调用前后上报对话内容
    // 仅当 enableConversationLog: true 时生效（由 service 内部判断 producer 是否就绪）
    api.on("llm_input", (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => {
      service.sendConversationLog({
        logType: "conversation",
        eventType: "llm_input",
        sessionKey: ctx.sessionKey ?? "",
        sessionId: event.sessionId ?? "",
        runId: event.runId ?? "",
        provider: event.provider ?? "",
        model: event.model ?? "",
        prompt: event.prompt ?? "",
        imagesCount: String(event.imagesCount ?? 0),
        historyCount: String(
          Array.isArray(event.historyMessages) ? event.historyMessages.length : 0,
        ),
        timestamp: new Date().toISOString(),
      });
    });

    api.on("llm_output", (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => {
      service.sendConversationLog({
        logType: "conversation",
        eventType: "llm_output",
        sessionKey: ctx.sessionKey ?? "",
        sessionId: event.sessionId ?? "",
        runId: event.runId ?? "",
        provider: event.provider ?? "",
        model: event.model ?? "",
        assistantText: (event.assistantTexts ?? []).join(""),
        usage_input: String(event.usage?.input ?? 0),
        usage_output: String(event.usage?.output ?? 0),
        usage_total: String(event.usage?.total ?? 0),
        timestamp: new Date().toISOString(),
      });
    });

    // 通过 before_message_write Hook 实现 Session 日志实时流：直接拦截消息写入，零磁盘 I/O
    // 仅当 enableSessionLog: true 时生效（由 service 内部判断 sessionLogProducer 是否就绪）
    api.on(
      "before_message_write",
      (
        event: PluginHookBeforeMessageWriteEvent,
        ctx: { agentId?: string; sessionKey?: string },
      ) => {
        service.sendSessionMessage(event.message, ctx.sessionKey);
      },
    );
  },
};

export default plugin;
