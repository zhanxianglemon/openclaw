/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/diagnostics-cls";
import {
  onDiagnosticEvent,
  redactSensitiveText,
  registerLogTransport,
} from "openclaw/plugin-sdk/diagnostics-cls";

// ─── 常量 ───────────────────────────────────────────────────────────────────

/** toolResult 字段最大上报字符数，超出则截断 */
const TOOL_RESULT_MAX_LENGTH = 2000;

/** raw 字段（整条消息 JSON 序列化）最大上报字符数，超出则截断 */
const RAW_MESSAGE_MAX_LENGTH = 10000;

// ─── 日志级别权重 ──────────────────────────────────────────────────────────────

const LOG_LEVEL_WEIGHT: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

// ─── 配置 ────────────────────────────────────────────────────────────────────

interface ClsTraceConfig {
  topicId: string;
  secretId: string;
  secretKey: string;
  endpoint: string;
  source: string;
  /** 是否启用诊断 trace 事件上传，默认 true */
  enableTraceEvent: boolean;
  /** 是否启用运行日志上传，默认 true */
  enableLogTransport: boolean;
  /** 最低上传日志级别，默认 info */
  minLevel: string;
  /** 异步发送时间阈值（秒），默认 2s */
  sendTimeThreshold: number;
  /** 异步发送条数阈值，默认 1000 */
  sendCountThreshold: number;
  /** 是否启用应用运行日志文件监听上报（/tmp/openclaw/*.log），默认 false */
  enableAppLog: boolean;
  /** 是否启用 Session 消息实时流上报（通过 before_message_write Hook，零磁盘 I/O），默认 false */
  enableSessionLog: boolean;
  /** 应用日志上报到的 CLS 主题 ID（不填则使用 topicId） */
  appLogTopicId: string;
  /** Session 日志上报到的 CLS 主题 ID（不填则使用 topicId） */
  sessionLogTopicId: string;
  /** Trace 事件上报到的 CLS 主题 ID（不填则使用 topicId） */
  traceTopicId: string;
  /** 框架运行日志上报到的 CLS 主题 ID（不填则使用 topicId） */
  logTopicId: string;
  /** 是否启用 Metrics 指标上报（model.usage / webhook.received / webhook.processed / message.queued / message.processed / queue.lane.enqueue / queue.lane.dequeue / session.state / session.stuck / run.attempt / diagnostic.heartbeat），默认 true */
  enableMetrics: boolean;
  /** Metrics 上报到的 CLS 主题 ID（不填则使用 topicId） */
  metricsTopicId: string;
  /** 是否启用对话日志上报（llm_input / llm_output Hook 实时流），默认 false */
  enableConversationLog: boolean;
  /** 对话日志上报到的 CLS 主题 ID（不填则使用 topicId） */
  conversationLogTopicId: string;
}

function resolveConfig(pluginConfig: Record<string, unknown> | undefined): ClsTraceConfig | null {
  const topicId = typeof pluginConfig?.topicId === "string" ? pluginConfig.topicId.trim() : "";
  const secretId = typeof pluginConfig?.secretId === "string" ? pluginConfig.secretId.trim() : "";
  const secretKey =
    typeof pluginConfig?.secretKey === "string" ? pluginConfig.secretKey.trim() : "";
  const endpoint = typeof pluginConfig?.endpoint === "string" ? pluginConfig.endpoint.trim() : "";

  if (!topicId || !secretId || !secretKey || !endpoint) {
    return null;
  }

  const source =
    typeof pluginConfig?.source === "string" && pluginConfig.source.trim()
      ? pluginConfig.source.trim()
      : "openclaw";

  // enableTraceEvent / enableLogTransport / enableMetrics 默认 true（opt-out），用 !== false 判断
  // enableAppLog / enableSessionLog / enableConversationLog 默认 false（opt-in），用 === true 判断
  const enableTraceEvent = pluginConfig?.enableTraceEvent !== false;
  const enableLogTransport = pluginConfig?.enableLogTransport !== false;

  const minLevel =
    typeof pluginConfig?.minLevel === "string" &&
    LOG_LEVEL_WEIGHT[pluginConfig.minLevel] !== undefined
      ? pluginConfig.minLevel
      : "info";

  const sendTimeThreshold =
    typeof pluginConfig?.sendTimeThreshold === "number" && pluginConfig.sendTimeThreshold >= 1
      ? Math.floor(pluginConfig.sendTimeThreshold)
      : 2;

  const sendCountThreshold =
    typeof pluginConfig?.sendCountThreshold === "number" && pluginConfig.sendCountThreshold >= 1
      ? Math.floor(pluginConfig.sendCountThreshold)
      : 1000;

  const enableAppLog = pluginConfig?.enableAppLog === true;
  const enableSessionLog = pluginConfig?.enableSessionLog === true;

  const appLogTopicId =
    typeof pluginConfig?.appLogTopicId === "string" && pluginConfig.appLogTopicId.trim()
      ? pluginConfig.appLogTopicId.trim()
      : topicId;

  const sessionLogTopicId =
    typeof pluginConfig?.sessionLogTopicId === "string" && pluginConfig.sessionLogTopicId.trim()
      ? pluginConfig.sessionLogTopicId.trim()
      : topicId;

  const traceTopicId =
    typeof pluginConfig?.traceTopicId === "string" && pluginConfig.traceTopicId.trim()
      ? pluginConfig.traceTopicId.trim()
      : topicId;

  const logTopicId =
    typeof pluginConfig?.logTopicId === "string" && pluginConfig.logTopicId.trim()
      ? pluginConfig.logTopicId.trim()
      : topicId;

  const enableMetrics = pluginConfig?.enableMetrics !== false;

  const metricsTopicId =
    typeof pluginConfig?.metricsTopicId === "string" && pluginConfig.metricsTopicId.trim()
      ? pluginConfig.metricsTopicId.trim()
      : topicId;

  const enableConversationLog = pluginConfig?.enableConversationLog === true;

  const conversationLogTopicId =
    typeof pluginConfig?.conversationLogTopicId === "string" &&
    pluginConfig.conversationLogTopicId.trim()
      ? pluginConfig.conversationLogTopicId.trim()
      : topicId;

  return {
    topicId,
    secretId,
    secretKey,
    endpoint,
    source,
    enableTraceEvent,
    enableLogTransport,
    minLevel,
    sendTimeThreshold,
    sendCountThreshold,
    enableAppLog,
    enableSessionLog,
    appLogTopicId,
    sessionLogTopicId,
    traceTopicId,
    logTopicId,
    enableMetrics,
    metricsTopicId,
    enableConversationLog,
    conversationLogTopicId,
  };
}

// ─── Span 结构 ────────────────────────────────────────────────────────────────

interface TraceSpan {
  name: string;
  eventType: string;
  startTime: string;
  endTime: string;
  durationMs?: number;
  status: "ok" | "error";
  errorMessage?: string;
  attributes: Record<string, string | number | boolean>;
  seq: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function spanTime(durationMs?: number): { startTime: string; endTime: string } {
  const end = new Date();
  const start =
    typeof durationMs === "number" && durationMs >= 0 ? new Date(end.getTime() - durationMs) : end;
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

// ─── Span 构建 ────────────────────────────────────────────────────────────────

function buildModelUsageSpan(
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
): TraceSpan {
  const { startTime, endTime } = spanTime(evt.durationMs);
  return {
    name: "openclaw.model.usage",
    eventType: evt.type,
    startTime,
    endTime,
    durationMs: evt.durationMs,
    status: "ok",
    seq: evt.seq,
    attributes: {
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.provider": evt.provider ?? "unknown",
      "openclaw.model": evt.model ?? "unknown",
      "openclaw.sessionKey": evt.sessionKey ?? "",
      "openclaw.sessionId": evt.sessionId ?? "",
      "openclaw.tokens.input": evt.usage?.input ?? 0,
      "openclaw.tokens.output": evt.usage?.output ?? 0,
      // 统一使用驼峰命名风格
      "openclaw.tokens.cacheRead": evt.usage?.cacheRead ?? 0,
      "openclaw.tokens.cacheWrite": evt.usage?.cacheWrite ?? 0,
      // 补充 promptTokens
      ...(evt.usage?.promptTokens ? { "openclaw.tokens.prompt": evt.usage.promptTokens } : {}),
      "openclaw.tokens.total": evt.usage?.total ?? 0,
      ...(evt.costUsd !== undefined ? { "openclaw.costUsd": evt.costUsd } : {}),
      ...(evt.context?.limit !== undefined ? { "openclaw.context.limit": evt.context.limit } : {}),
      ...(evt.context?.used !== undefined ? { "openclaw.context.used": evt.context.used } : {}),
    },
  };
}

function buildWebhookProcessedSpan(
  evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
): TraceSpan {
  const { startTime, endTime } = spanTime(evt.durationMs);
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  if (evt.chatId !== undefined) attrs["openclaw.chatId"] = String(evt.chatId);
  return {
    name: "openclaw.webhook.processed",
    eventType: evt.type,
    startTime,
    endTime,
    durationMs: evt.durationMs,
    status: "ok",
    seq: evt.seq,
    attributes: attrs,
  };
}

function buildWebhookErrorSpan(
  evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
): TraceSpan {
  const redactedError = redactSensitiveText(evt.error);
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
    "openclaw.error": redactedError,
  };
  if (evt.chatId !== undefined) attrs["openclaw.chatId"] = String(evt.chatId);
  const now = nowIso();
  return {
    name: "openclaw.webhook.error",
    eventType: evt.type,
    startTime: now,
    endTime: now,
    status: "error",
    errorMessage: redactedError,
    seq: evt.seq,
    attributes: attrs,
  };
}

function buildMessageProcessedSpan(
  evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
): TraceSpan {
  const { startTime, endTime } = spanTime(evt.durationMs);
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.outcome": evt.outcome ?? "unknown",
  };
  if (evt.sessionKey) attrs["openclaw.sessionKey"] = evt.sessionKey;
  if (evt.sessionId) attrs["openclaw.sessionId"] = evt.sessionId;
  if (evt.chatId !== undefined) attrs["openclaw.chatId"] = String(evt.chatId);
  if (evt.messageId !== undefined) attrs["openclaw.messageId"] = String(evt.messageId);
  if (evt.reason) attrs["openclaw.reason"] = redactSensitiveText(evt.reason);

  const isError = evt.outcome === "error";
  const span: TraceSpan = {
    name: "openclaw.message.processed",
    eventType: evt.type,
    startTime,
    endTime,
    durationMs: evt.durationMs,
    status: isError ? "error" : "ok",
    seq: evt.seq,
    attributes: attrs,
  };
  if (isError && evt.error) {
    span.errorMessage = redactSensitiveText(evt.error);
  }
  return span;
}

function buildSessionStuckSpan(
  evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
): TraceSpan {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.state": evt.state,
    "openclaw.ageMs": evt.ageMs,
    "openclaw.queueDepth": evt.queueDepth ?? 0,
  };
  if (evt.sessionKey) attrs["openclaw.sessionKey"] = evt.sessionKey;
  if (evt.sessionId) attrs["openclaw.sessionId"] = evt.sessionId;
  const now = nowIso();
  return {
    name: "openclaw.session.stuck",
    eventType: evt.type,
    startTime: now,
    endTime: now,
    status: "error",
    errorMessage: "session stuck",
    seq: evt.seq,
    attributes: attrs,
  };
}

// ─── Metrics 条目结构 ─────────────────────────────────────────────────────────

/**
 * Metrics 条目：以结构化日志形式上报到 CLS，logType=metric 用于区分 Span 事件
 */
interface MetricEntry {
  metricName: string;
  eventType: string;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
  seq: number;
}

// ─── 额外 Metrics 条目构建 ────────

/**
 * model.usage 额外 Metric：按 token 类型拆分上报（对应 otel 的 tokensCounter）
 */
function buildModelUsageTokensMetrics(
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
  now: string,
): MetricEntry[] {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.provider": evt.provider ?? "unknown",
    "openclaw.model": evt.model ?? "unknown",
  };
  const usage = evt.usage;
  const entries: MetricEntry[] = [];
  const tokenTypes: Array<[keyof typeof usage, string]> = [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cacheRead"],
    ["cacheWrite", "cacheWrite"],
    ["promptTokens", "prompt"],
    ["total", "total"],
  ];
  for (const [field, tokenType] of tokenTypes) {
    const val = usage?.[field];
    if (typeof val === "number" && val > 0) {
      entries.push({
        metricName: "openclaw.tokens",
        eventType: evt.type,
        timestamp: now,
        seq: evt.seq,
        attributes: { ...attrs, "openclaw.token": tokenType, "openclaw.value": val },
      });
    }
  }
  return entries;
}

/**
 * model.usage 额外 Metric：上报 cost（对应 otel 的 costCounter）
 */
function buildModelUsageCostMetric(
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
  now: string,
): MetricEntry | null {
  if (!evt.costUsd) return null;
  return {
    metricName: "openclaw.cost.usd",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.provider": evt.provider ?? "unknown",
      "openclaw.model": evt.model ?? "unknown",
      "openclaw.value": evt.costUsd,
    },
  };
}

/**
 * model.usage 额外 Metric：上报运行耗时（对应 otel 的 durationHistogram）
 */
function buildModelUsageDurationMetric(
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
  now: string,
): MetricEntry | null {
  if (!evt.durationMs) return null;
  return {
    metricName: "openclaw.run.duration_ms",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.provider": evt.provider ?? "unknown",
      "openclaw.model": evt.model ?? "unknown",
      "openclaw.value": evt.durationMs,
    },
  };
}

/**
 * model.usage 额外 Metric：上报上下文窗口大小（对应 otel 的 contextHistogram）
 */
function buildModelUsageContextMetrics(
  evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
  now: string,
): MetricEntry[] {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.provider": evt.provider ?? "unknown",
    "openclaw.model": evt.model ?? "unknown",
  };
  const entries: MetricEntry[] = [];
  if (evt.context?.limit) {
    entries.push({
      metricName: "openclaw.context.tokens",
      eventType: evt.type,
      timestamp: now,
      seq: evt.seq,
      attributes: { ...attrs, "openclaw.context": "limit", "openclaw.value": evt.context.limit },
    });
  }
  if (evt.context?.used) {
    entries.push({
      metricName: "openclaw.context.tokens",
      eventType: evt.type,
      timestamp: now,
      seq: evt.seq,
      attributes: { ...attrs, "openclaw.context": "used", "openclaw.value": evt.context.used },
    });
  }
  return entries;
}

/**
 * webhook.processed 额外 Metric：记录 webhook 处理耗时
 */
function buildWebhookProcessedDurationMetric(
  evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
  now: string,
): MetricEntry | null {
  if (typeof evt.durationMs !== "number") return null;
  return {
    metricName: "openclaw.webhook.duration_ms",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.webhook": evt.updateType ?? "unknown",
      "openclaw.durationMs": evt.durationMs,
    },
  };
}

/**
 * message.processed 额外 Metric：记录消息处理计数和耗时
 */
function buildMessageProcessedMetric(
  evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.outcome": evt.outcome ?? "unknown",
  };
  if (typeof evt.durationMs === "number") attrs["openclaw.durationMs"] = evt.durationMs;
  return {
    metricName: "openclaw.message.processed",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

/**
 * message.queued 额外 Metric：记录队列深度
 */
function buildMessageQueuedDepthMetric(
  evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
  now: string,
): MetricEntry | null {
  if (typeof evt.queueDepth !== "number") return null;
  return {
    metricName: "openclaw.queue.depth",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.source": evt.source ?? "unknown",
      "openclaw.queueDepth": evt.queueDepth,
    },
  };
}

/**
 * queue.lane.enqueue 额外 Metric：记录队列深度 histogram
 */
function buildLaneEnqueueDepthMetric(
  evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
  now: string,
): MetricEntry {
  return {
    metricName: "openclaw.queue.depth",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.lane": evt.lane,
      "openclaw.queueSize": evt.queueSize,
    },
  };
}

/**
 * queue.lane.dequeue 额外 Metric：记录队列深度 + 等待时间 histogram
 */
function buildLaneDequeueDepthMetric(
  evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.lane": evt.lane,
    "openclaw.queueSize": evt.queueSize,
  };
  if (typeof evt.waitMs === "number") attrs["openclaw.waitMs"] = evt.waitMs;
  return {
    metricName: "openclaw.queue.depth",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

/**
 * session.stuck 额外 Metric：记录 stuck 年龄 histogram
 */
function buildSessionStuckAgeMetric(
  evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.state": evt.state,
    "openclaw.ageMs": evt.ageMs,
  };
  if (evt.sessionKey) attrs["openclaw.sessionKey"] = evt.sessionKey;
  if (evt.sessionId) attrs["openclaw.sessionId"] = evt.sessionId;
  return {
    metricName: "openclaw.session.stuck_age_ms",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

// ─── Metrics 条目构建 ─────────────────────────────────────────────────────────

function buildWebhookReceivedMetric(
  evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
  now: string,
): MetricEntry {
  return {
    metricName: "openclaw.webhook.received",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.channel": evt.channel ?? "unknown",
      "openclaw.webhook": evt.updateType ?? "unknown",
    },
  };
}

function buildMessageQueuedMetric(
  evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.source": evt.source ?? "unknown",
  };
  if (typeof evt.queueDepth === "number") attrs["openclaw.queueDepth"] = evt.queueDepth;
  return {
    metricName: "openclaw.message.queued",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

function buildLaneEnqueueMetric(
  evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
  now: string,
): MetricEntry {
  return {
    metricName: "openclaw.queue.lane.enqueue",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.lane": evt.lane,
      "openclaw.queueSize": evt.queueSize,
    },
  };
}

function buildLaneDequeueMetric(
  evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.lane": evt.lane,
    "openclaw.queueSize": evt.queueSize,
  };
  if (typeof evt.waitMs === "number") attrs["openclaw.waitMs"] = evt.waitMs;
  return {
    metricName: "openclaw.queue.lane.dequeue",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

function buildSessionStateMetric(
  evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.state": evt.state,
  };
  if (evt.reason) attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
  if (evt.sessionKey) attrs["openclaw.sessionKey"] = evt.sessionKey;
  if (evt.sessionId) attrs["openclaw.sessionId"] = evt.sessionId;
  return {
    metricName: "openclaw.session.state",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

function buildRunAttemptMetric(
  evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>,
  now: string,
): MetricEntry {
  return {
    metricName: "openclaw.run.attempt",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.attempt": evt.attempt,
    },
  };
}

function buildHeartbeatMetric(
  evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
  now: string,
): MetricEntry {
  return {
    metricName: "openclaw.diagnostic.heartbeat",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: {
      "openclaw.queued": evt.queued,
    },
  };
}

function buildSessionStuckMetric(
  evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
  now: string,
): MetricEntry {
  const attrs: Record<string, string | number | boolean> = {
    "openclaw.state": evt.state,
    "openclaw.ageMs": evt.ageMs,
    "openclaw.queueDepth": evt.queueDepth ?? 0,
  };
  if (evt.sessionKey) attrs["openclaw.sessionKey"] = evt.sessionKey;
  if (evt.sessionId) attrs["openclaw.sessionId"] = evt.sessionId;
  return {
    metricName: "openclaw.session.stuck",
    eventType: evt.type,
    timestamp: now,
    seq: evt.seq,
    attributes: attrs,
  };
}

// ─── logObj 解析 ──────────────────────────────────────────────────────────────

/**
 * 从 tslog 的 logObj 中提取结构化字段
 * logObj 结构：
 *   - _meta: { logLevelName, date, name, parentNames, path }
 *   - 0, 1, 2, ... : 日志参数（数字键）
 *     - 第一个参数若是 JSON 对象字符串，则为 bindings（subsystem 等）
 *     - 最后一个字符串参数为 message
 */
function parseLogObj(logObj: Record<string, unknown>): {
  level: string;
  message: string;
  timestamp: number;
  subsystem?: string;
  logger?: string;
  parentNames?: string;
  codePath?: string;
  codeLine?: number;
  codeFunction?: string;
  codeLocation?: string;
  extra: Record<string, string>;
} {
  const meta = logObj._meta as
    | {
        logLevelName?: string;
        date?: Date;
        name?: string;
        parentNames?: string[];
        path?: {
          filePath?: string;
          fileLine?: string;
          fileColumn?: string;
          filePathWithLine?: string;
          method?: string;
        };
      }
    | undefined;

  const level = (meta?.logLevelName ?? "INFO").toLowerCase();
  const timestamp = meta?.date instanceof Date ? meta.date.getTime() : Date.now();
  const loggerName = meta?.name;
  const parentNames = meta?.parentNames?.length ? meta.parentNames.join(".") : undefined;
  const codePath = meta?.path?.filePath;
  const codeLine = meta?.path?.fileLine ? Number(meta.path.fileLine) : undefined;
  const codeFunction = meta?.path?.method;
  const codeLocation = meta?.path?.filePathWithLine;

  // 收集数字键参数，按序排列
  const numericArgs = Object.entries(logObj)
    .filter(([key]) => /^\d+$/.test(key))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);

  // 尝试解析第一个参数为 bindings（subsystem 信息）
  let subsystem: string | undefined;
  const extra: Record<string, string> = {};
  if (typeof numericArgs[0] === "string" && numericArgs[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(numericArgs[0]) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (typeof parsed.subsystem === "string") {
          subsystem = parsed.subsystem;
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (
            k !== "subsystem" &&
            (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
          ) {
            // bindings 字段加 openclaw. 前缀
            extra[`openclaw.${k}`] = String(v);
          }
        }
        numericArgs.shift();
      }
    } catch {
      // 不是 JSON，忽略
    }
  }

  // 最后一个字符串参数为 message（向后找第一个字符串）
  let message = "";
  for (let i = numericArgs.length - 1; i >= 0; i--) {
    if (typeof numericArgs[i] === "string") {
      message = String(numericArgs[i]);
      numericArgs.splice(i, 1);
      break;
    }
  }
  if (!message && numericArgs.length === 1) {
    try {
      message = JSON.stringify(numericArgs[0]);
    } catch {
      message = String(numericArgs[0]);
    }
    numericArgs.length = 0;
  }
  if (!message) {
    message = "(empty)";
  }

  // 剩余参数序列化为 extra.args
  if (numericArgs.length > 0) {
    try {
      extra["openclaw.log.args"] = JSON.stringify(numericArgs);
    } catch {
      extra["openclaw.log.args"] = String(numericArgs);
    }
  }

  return {
    level,
    message,
    timestamp,
    subsystem,
    logger: loggerName,
    parentNames,
    codePath,
    codeLine,
    codeFunction,
    codeLocation,
    extra,
  };
}

// ─── 服务主体 ─────────────────────────────────────────────────────────────────

/** diagnostics-cls 服务的扩展类型，在 OpenClawPluginService 基础上暴露实时流上报方法 */
export type DiagnosticsClsService = OpenClawPluginService & {
  /** 供外部 Plugin Hook 调用，将对话日志实时上报到 CLS（零磁盘 I/O） */
  sendConversationLog: (fields: Record<string, string>) => void;
  /** 供外部 before_message_write Hook 调用，将 Session 消息实时上报到 CLS（零磁盘 I/O） */
  sendSessionMessage: (message: unknown, sessionKey?: string) => void;
};

/**
 * CLS LogItem 实例最小接口
 * （tencentcloud-cls-sdk-nodejs 无官方类型声明，此处手动声明最小接口）
 */
interface LogItemInstance {
  setTime(time: number): void;
  pushBack(content: unknown): void;
}

/**
 * CLS Producer 最小接口，用于替代 any 类型，提供基本类型安全
 * （tencentcloud-cls-sdk-nodejs 无官方类型声明，此处手动声明最小接口）
 */
interface Producer {
  send(item: LogItemInstance): Promise<unknown>;
}

/**
 * 创建 CLS Producer 实例的工厂函数，避免重复的初始化样板代码
 */
function createProducer(
  ns: Record<string, unknown>,
  topicId: string,
  cfg: ClsTraceConfig,
  label: string,
  onError: (msg: string) => void,
): Producer {
  const ProducerCtor = ns.Producer as new (...args: unknown[]) => Producer;
  return new ProducerCtor({
    topic_id: topicId,
    endpoint: cfg.endpoint,
    credential: {
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
    },
    time: cfg.sendTimeThreshold,
    count: cfg.sendCountThreshold,
    onSendLogsError: (result: unknown) => {
      if (
        result !== null &&
        typeof result === "object" &&
        (result as Record<string, unknown>).status === 200
      ) {
        return;
      }
      let errMsg: string;
      if (result instanceof Error) {
        errMsg = result.message;
      } else if (typeof result === "object" && result !== null) {
        try {
          errMsg = JSON.stringify(result);
        } catch {
          errMsg = Object.prototype.toString.call(result);
        }
      } else {
        errMsg = String(result);
      }
      onError(`${label} - ${errMsg}`);
    },
  });
}

export function createDiagnosticsClsTraceService(
  pluginConfig?: Record<string, unknown>,
): DiagnosticsClsService {
  // ctx 提升为闭包变量，在 start(ctx) 时赋值，供 sendSpan / sendMetric 等闭包使用
  let serviceCtx: Parameters<OpenClawPluginService["start"]>[0] | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopTransport: (() => void) | null = null;
  let stopAppLogTransport: (() => void) | null = null;
  let producer: Producer | null = null;
  let traceProducer: Producer | null = null;
  let logProducer: Producer | null = null;
  let metricsProducer: Producer | null = null;
  let conversationLogProducer: Producer | null = null;
  let sessionLogProducer: Producer | null = null;
  let appLogProducer: Producer | null = null;
  let LogItem: (new () => LogItemInstance) | null = null;
  let Content: (new (key: string, value: string) => unknown) | null = null;

  const cfg = resolveConfig(pluginConfig);
  const minLevelWeight = cfg ? (LOG_LEVEL_WEIGHT[cfg.minLevel] ?? 0) : 0;

  /**
   * 将 TraceSpan 转换为 CLS LogItem 并通过 traceProducer.send 异步发送
   */
  const sendSpan = (span: TraceSpan): void => {
    if (!traceProducer || !LogItem || !Content) return;
    try {
      const item = new LogItem();
      // 使用 span 的实际结束时间作为 CLS 日志时间，而非发送时刻
      item.setTime(Math.floor(new Date(span.endTime).getTime() / 1000));

      item.pushBack(new Content("name", span.name));
      item.pushBack(new Content("eventType", span.eventType));
      item.pushBack(new Content("startTime", span.startTime));
      item.pushBack(new Content("endTime", span.endTime));
      item.pushBack(new Content("status", span.status));
      item.pushBack(new Content("seq", String(span.seq)));

      if (span.durationMs !== undefined) {
        item.pushBack(new Content("durationMs", String(span.durationMs)));
      }
      if (span.errorMessage !== undefined) {
        item.pushBack(new Content("errorMessage", span.errorMessage));
      }

      for (const [k, v] of Object.entries(span.attributes)) {
        item.pushBack(new Content(k, String(v)));
      }

      traceProducer.send(item).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        serviceCtx?.logger.warn(`diagnostics-cls: span send 失败: ${msg}`);
      });
    } catch {
      // 构建或发送失败时静默忽略
    }
  };

  /**
   * 将 Session 消息（before_message_write Hook）实时上报到 CLS（零磁盘 I/O）
   * 由外部 Hook 处理器调用，直接拿到结构化 AgentMessage，无需读取磁盘文件
   */
  const sendSessionMessage = (message: unknown, sessionKey?: string): void => {
    if (!sessionLogProducer || !LogItem || !Content) return;
    try {
      const msg = message as Record<string, unknown>;
      const msgType = typeof msg["type"] === "string" ? msg["type"] : "unknown";
      const time = typeof msg["ts"] === "number" ? msg["ts"] : Date.now();

      const contents: Array<{ key: string; value: string }> = [
        { key: "source", value: "session" },
        { key: "type", value: msgType },
      ];

      if (sessionKey) {
        contents.push({ key: "sessionKey", value: sessionKey });
      }

      // 提取常用字段
      for (const field of ["id", "parentId", "sessionId"]) {
        const val = msg[field];
        if (val !== undefined && val !== null) {
          contents.push({ key: field, value: String(val) });
        }
      }

      // 提取 message 子对象字段
      if (msgType === "message") {
        const inner = msg["message"] as Record<string, unknown> | undefined;
        if (inner && typeof inner === "object") {
          const role = typeof inner["role"] === "string" ? inner["role"] : "";
          contents.push({ key: "role", value: role });

          for (const field of ["api", "provider", "model", "stopReason"]) {
            const val = inner[field];
            if (val !== undefined && val !== null) {
              contents.push({ key: field, value: String(val) });
            }
          }

          // usage / cost
          const usage = inner["usage"] as Record<string, unknown> | undefined;
          if (usage && typeof usage === "object") {
            for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
              const val = usage[field];
              if (typeof val === "number") {
                // 使用驼峰风格：usage.input / usage.output / usage.cacheRead 等
                const key = `usage.${field}`;
                contents.push({ key, value: String(val) });
              }
            }
            const cost = usage["cost"] as Record<string, unknown> | undefined;
            if (cost && typeof cost === "object") {
              for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
                const val = cost[field];
                if (typeof val === "number") {
                  // 使用驼峰风格：cost.input / cost.output / cost.cacheRead 等
                  contents.push({ key: `cost.${field}`, value: val.toFixed(8) });
                }
              }
            }
          }

          // 提取消息文本内容
          const contentArr = Array.isArray(inner["content"])
            ? (inner["content"] as unknown[])
            : null;
          if (contentArr) {
            if (role === "user") {
              const textParts: string[] = [];
              for (const block of contentArr) {
                if (block !== null && typeof block === "object") {
                  const b = block as Record<string, unknown>;
                  if (
                    b["type"] === "text" &&
                    typeof b["text"] === "string" &&
                    (b["text"] as string).trim()
                  ) {
                    textParts.push((b["text"] as string).trim());
                  }
                }
              }
              if (textParts.length > 0) {
                contents.push({ key: "userMessage", value: textParts.join("\n") });
              }
            } else if (role === "assistant") {
              const textParts: string[] = [];
              const toolCalls: string[] = [];
              for (const block of contentArr) {
                if (block === null || typeof block !== "object") continue;
                const b = block as Record<string, unknown>;
                if (
                  b["type"] === "text" &&
                  typeof b["text"] === "string" &&
                  (b["text"] as string).trim()
                ) {
                  textParts.push((b["text"] as string).trim());
                } else if (b["type"] === "toolCall" && typeof b["name"] === "string") {
                  toolCalls.push(b["name"] as string);
                }
              }
              if (textParts.length > 0) {
                contents.push({ key: "assistantMessage", value: textParts.join("\n") });
              }
              if (toolCalls.length > 0) {
                contents.push({ key: "toolCalls", value: toolCalls.join(",") });
              }
            } else if (role === "toolResult") {
              // 优先取 msg 顶层的 toolName，再 fallback 到 inner.toolName
              const toolName = msg["toolName"] ?? inner["toolName"];
              if (typeof toolName === "string") {
                contents.push({ key: "toolName", value: toolName });
              }
              const isError = inner["isError"];
              if (isError !== undefined) {
                contents.push({ key: "toolIsError", value: String(isError) });
              }
              const resultParts: string[] = [];
              for (const block of contentArr) {
                if (block === null || typeof block !== "object") continue;
                const b = block as Record<string, unknown>;
                if (
                  b["type"] === "text" &&
                  typeof b["text"] === "string" &&
                  (b["text"] as string).trim()
                ) {
                  resultParts.push((b["text"] as string).trim());
                }
              }
              if (resultParts.length > 0) {
                const resultText = resultParts.join("\n");
                contents.push({
                  key: "toolResult",
                  value:
                    resultText.length > TOOL_RESULT_MAX_LENGTH
                      ? resultText.slice(0, TOOL_RESULT_MAX_LENGTH) + "…"
                      : resultText,
                });
              }
            }
          }
        }
      }

      // 原始 JSON 备份（截断超长内容，避免超出 CLS 单条日志大小限制）
      try {
        const rawStr = JSON.stringify(msg);
        contents.push({
          key: "raw",
          value:
            rawStr.length > RAW_MESSAGE_MAX_LENGTH
              ? rawStr.slice(0, RAW_MESSAGE_MAX_LENGTH) + "…"
              : rawStr,
        });
      } catch {
        // ignore
      }

      const item = new LogItem();
      item.setTime(Math.floor(time / 1000));
      for (const { key, value } of contents) {
        item.pushBack(new Content(key, value));
      }
      sessionLogProducer.send(item).catch((e: unknown) => {
        const errMsg = e instanceof Error ? e.message : JSON.stringify(e);
        serviceCtx?.logger.warn(`diagnostics-cls: session message send 失败: ${errMsg}`);
      });
    } catch {
      // 静默忽略
    }
  };

  /**
   * 将对话日志（llm_input / llm_output）发送到 CLS
   * 由外部 Hook 处理器调用，实现零磁盘实时流上报
   */
  const sendConversationLog = (fields: Record<string, string>): void => {
    if (!conversationLogProducer || !LogItem || !Content) return;
    try {
      const item = new LogItem();
      // 优先使用 fields 中的 timestamp 字段作为 CLS 日志时间，fallback 到当前时间
      const tsMs = fields["timestamp"] ? new Date(fields["timestamp"]).getTime() : NaN;
      item.setTime(Math.floor((isNaN(tsMs) ? Date.now() : tsMs) / 1000));
      for (const [k, v] of Object.entries(fields)) {
        item.pushBack(new Content(k, v));
      }
      conversationLogProducer.send(item).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        serviceCtx?.logger.warn(`diagnostics-cls: conversation log send 失败: ${msg}`);
      });
    } catch {
      // 静默忽略
    }
  };

  /**
   * 将 MetricEntry 转换为 CLS LogItem 并通过 metricsProducer.send 异步发送
   */
  const sendMetric = (metric: MetricEntry): void => {
    if (!metricsProducer || !LogItem || !Content) return;
    try {
      const item = new LogItem();
      // 使用 metric 的实际事件时间作为 CLS 日志时间，而非发送时刻
      item.setTime(Math.floor(new Date(metric.timestamp).getTime() / 1000));

      item.pushBack(new Content("logType", "metric"));
      item.pushBack(new Content("metricName", metric.metricName));
      item.pushBack(new Content("eventType", metric.eventType));
      item.pushBack(new Content("timestamp", metric.timestamp));
      item.pushBack(new Content("seq", String(metric.seq)));

      for (const [k, v] of Object.entries(metric.attributes)) {
        item.pushBack(new Content(k, String(v)));
      }

      metricsProducer.send(item).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        serviceCtx?.logger.warn(`diagnostics-cls: metric send 失败: ${msg}`);
      });
    } catch {
      // 构建或发送失败时静默忽略
    }
  };

  return {
    id: "diagnostics-cls",
    /** 供外部 Hook 处理器调用，将对话日志实时上报到 CLS（零磁盘 I/O） */
    sendConversationLog,
    /** 供外部 before_message_write Hook 调用，将 Session 消息实时上报到 CLS（零磁盘 I/O） */
    sendSessionMessage,

    async start(ctx) {
      // 将 ctx 赋值给外部闭包变量，供 sendSpan / sendMetric 等函数使用
      serviceCtx = ctx;
      if (!cfg) {
        ctx.logger.warn(
          "diagnostics-cls: 缺少必要配置（topicId / secretId / secretKey / endpoint），插件已禁用",
        );
        return;
      }

      // 动态导入 CLS SDK
      let ns: Record<string, unknown> = {};
      try {
        // @ts-ignore tencentcloud-cls-sdk-nodejs 无类型声明
        const clsSdk = await import("tencentcloud-cls-sdk-nodejs");
        ns = (clsSdk.Producer ? clsSdk : clsSdk.default) as Record<string, unknown>;
        LogItem = ns.LogItem as (new () => LogItemInstance) | null;
        Content = ns.Content as (new (key: string, value: string) => unknown) | null;

        producer = createProducer(ns, cfg.topicId, cfg, "日志上传失败", (msg) =>
          ctx.logger.warn(`diagnostics-cls: ${msg}`),
        );
      } catch (err) {
        ctx.logger.error(
          `diagnostics-cls: 加载 tencentcloud-cls-sdk-nodejs 失败，请确认已安装该依赖。错误：${String(err)}`,
        );
        // SDK 启动失败向上抛出，让框架感知
        throw err;
      }

      // 初始化 Trace 事件 producer（若 traceTopicId 与主 topicId 不同则创建独立实例）
      traceProducer =
        cfg.traceTopicId === cfg.topicId
          ? producer
          : createProducer(ns, cfg.traceTopicId, cfg, "Trace 事件上传失败", (msg) =>
              ctx.logger.warn(`diagnostics-cls: ${msg}`),
            );

      // 初始化框架运行日志 producer（若 logTopicId 与主 topicId 不同则创建独立实例）
      logProducer =
        cfg.logTopicId === cfg.topicId
          ? producer
          : createProducer(ns, cfg.logTopicId, cfg, "框架运行日志上传失败", (msg) =>
              ctx.logger.warn(`diagnostics-cls: ${msg}`),
            );

      // 初始化 Metrics producer（若 metricsTopicId 与主 topicId 不同则创建独立实例）
      if (cfg.enableMetrics) {
        metricsProducer =
          cfg.metricsTopicId === cfg.topicId
            ? producer
            : createProducer(ns, cfg.metricsTopicId, cfg, "Metrics 上传失败", (msg) =>
                ctx.logger.warn(`diagnostics-cls: ${msg}`),
              );
      }

      // 初始化 Session 日志 producer（若 sessionLogTopicId 与主 topicId 不同则创建独立实例）
      if (cfg.enableSessionLog) {
        sessionLogProducer =
          cfg.sessionLogTopicId === cfg.topicId
            ? producer
            : createProducer(ns, cfg.sessionLogTopicId, cfg, "Session 日志上传失败", (msg) =>
                ctx.logger.warn(`diagnostics-cls: ${msg}`),
              );
      }

      // 初始化应用日志 producer（若 appLogTopicId 与主 topicId 不同则创建独立实例）
      if (cfg.enableAppLog) {
        appLogProducer =
          cfg.appLogTopicId === cfg.topicId
            ? producer
            : createProducer(ns, cfg.appLogTopicId, cfg, "应用日志上传失败", (msg) =>
                ctx.logger.warn(`diagnostics-cls: ${msg}`),
              );
      }

      // 初始化对话日志 producer（若 conversationLogTopicId 与主 topicId 不同则创建独立实例）
      if (cfg.enableConversationLog) {
        conversationLogProducer =
          cfg.conversationLogTopicId === cfg.topicId
            ? producer
            : createProducer(ns, cfg.conversationLogTopicId, cfg, "对话日志上传失败", (msg) =>
                ctx.logger.warn(`diagnostics-cls: ${msg}`),
              );
      }

      ctx.logger.info(
        `diagnostics-cls: 启动，CLS endpoint=${cfg.endpoint}，topicId=${cfg.topicId}，` +
          `traceTopicId=${cfg.traceTopicId}，logTopicId=${cfg.logTopicId}，` +
          `metricsTopicId=${cfg.metricsTopicId}，appLogTopicId=${cfg.appLogTopicId}，` +
          `sessionLogTopicId=${cfg.sessionLogTopicId}，conversationLogTopicId=${cfg.conversationLogTopicId}，` +
          `enableTraceEvent=${cfg.enableTraceEvent}，enableLogTransport=${cfg.enableLogTransport}，minLevel=${cfg.minLevel}，` +
          `enableMetrics=${cfg.enableMetrics}，enableAppLog=${cfg.enableAppLog}（实时流），enableSessionLog=${cfg.enableSessionLog}（实时流）`,
      );

      // enableAppLog：通过 registerLogTransport 实现实时流（零磁盘 I/O，替代文件 tail）
      if (cfg.enableAppLog && appLogProducer) {
        stopAppLogTransport = registerLogTransport((logObj) => {
          if (!appLogProducer || !LogItem || !Content) return;
          try {
            const parsed = parseLogObj(logObj);
            // 过滤低于 minLevel 的日志
            const levelWeight = LOG_LEVEL_WEIGHT[parsed.level] ?? 0;
            if (levelWeight < minLevelWeight) return;

            const item = new LogItem();
            item.setTime(Math.floor(parsed.timestamp / 1000));
            item.pushBack(new Content("source", "app"));
            item.pushBack(new Content("level", parsed.level));
            item.pushBack(new Content("message", redactSensitiveText(parsed.message)));
            if (parsed.subsystem) {
              item.pushBack(new Content("subsystem", parsed.subsystem));
            }
            if (parsed.logger) {
              item.pushBack(new Content("openclaw.logger", parsed.logger));
            }
            if (parsed.parentNames) {
              item.pushBack(new Content("openclaw.logger.parents", parsed.parentNames));
            }
            if (parsed.codePath) {
              item.pushBack(new Content("code.filepath", parsed.codePath));
            }
            if (parsed.codeLine !== undefined) {
              item.pushBack(new Content("code.lineno", String(parsed.codeLine)));
            }
            if (parsed.codeFunction) {
              item.pushBack(new Content("code.function", parsed.codeFunction));
            }
            if (parsed.codeLocation) {
              item.pushBack(new Content("openclaw.code.location", parsed.codeLocation));
            }
            for (const [k, v] of Object.entries(parsed.extra)) {
              item.pushBack(new Content(k, v));
            }
            appLogProducer.send(item).catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : JSON.stringify(e);
              ctx.logger.warn(`diagnostics-cls: app log send 失败: ${msg}`);
            });
          } catch (err) {
            ctx.logger.error(
              `diagnostics-cls: app log transport failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      }

      // 订阅诊断事件（Span 可通过 enableTraceEvent: false 关闭，Metrics 可通过 enableMetrics: false 关闭）
      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          // 在事件入口统一生成时间戳，确保同一事件的所有 Metric 时间戳一致
          const now = nowIso();
          switch (evt.type) {
            // ── Span 事件 ──────────────────────────────────────────────────────
            case "model.usage":
              if (cfg.enableTraceEvent) sendSpan(buildModelUsageSpan(evt));
              // 补充 tokensCounter / costCounter / durationHistogram / contextHistogram
              if (cfg.enableMetrics) {
                for (const m of buildModelUsageTokensMetrics(evt, now)) sendMetric(m);
                const costMetric = buildModelUsageCostMetric(evt, now);
                if (costMetric) sendMetric(costMetric);
                const durationMetric2 = buildModelUsageDurationMetric(evt, now);
                if (durationMetric2) sendMetric(durationMetric2);
                for (const m of buildModelUsageContextMetrics(evt, now)) sendMetric(m);
              }
              return;
            case "webhook.processed": {
              if (cfg.enableTraceEvent) sendSpan(buildWebhookProcessedSpan(evt));
              // 补充 webhookDurationHistogram
              if (cfg.enableMetrics) {
                const durationMetric = buildWebhookProcessedDurationMetric(evt, now);
                if (durationMetric) sendMetric(durationMetric);
              }
              return;
            }
            case "webhook.error":
              if (cfg.enableTraceEvent) sendSpan(buildWebhookErrorSpan(evt));
              return;
            case "message.processed":
              if (cfg.enableTraceEvent) sendSpan(buildMessageProcessedSpan(evt));
              // 补充 messageProcessedCounter + messageDurationHistogram
              if (cfg.enableMetrics) sendMetric(buildMessageProcessedMetric(evt, now));
              return;
            case "session.stuck":
              if (cfg.enableTraceEvent) sendSpan(buildSessionStuckSpan(evt));
              if (cfg.enableMetrics) {
                sendMetric(buildSessionStuckMetric(evt, now));
                // 补充 sessionStuckAgeHistogram
                sendMetric(buildSessionStuckAgeMetric(evt, now));
              }
              return;
            // ── 纯 Metrics 事件 ────────────────────────────────────────────────
            case "webhook.received":
              if (cfg.enableMetrics) sendMetric(buildWebhookReceivedMetric(evt, now));
              return;
            case "message.queued":
              if (cfg.enableMetrics) {
                sendMetric(buildMessageQueuedMetric(evt, now));
                // 补充 queueDepthHistogram（message.queued 时）
                const depthMetric = buildMessageQueuedDepthMetric(evt, now);
                if (depthMetric) sendMetric(depthMetric);
              }
              return;
            case "queue.lane.enqueue":
              if (cfg.enableMetrics) {
                sendMetric(buildLaneEnqueueMetric(evt, now));
                // 补充 queueDepthHistogram（enqueue 时）
                sendMetric(buildLaneEnqueueDepthMetric(evt, now));
              }
              return;
            case "queue.lane.dequeue":
              if (cfg.enableMetrics) {
                sendMetric(buildLaneDequeueMetric(evt, now));
                // 补充 queueDepthHistogram + queueWaitHistogram（dequeue 时）
                sendMetric(buildLaneDequeueDepthMetric(evt, now));
              }
              return;
            case "session.state":
              if (cfg.enableMetrics) sendMetric(buildSessionStateMetric(evt, now));
              return;
            case "run.attempt":
              if (cfg.enableMetrics) sendMetric(buildRunAttemptMetric(evt, now));
              return;
            case "diagnostic.heartbeat":
              if (cfg.enableMetrics) sendMetric(buildHeartbeatMetric(evt, now));
              return;
            case "tool.loop":
              // tool.loop 事件触发频率极高（每次工具调用循环均会触发），无诊断价值，跳过上报
              return;
          }
        } catch (err) {
          // 事件处理失败时记录错误日志
          ctx.logger.error(
            `diagnostics-cls: event handler failed (${(evt as { type: string }).type}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      // 注册运行日志 transport（可通过 enableLogTransport: false 关闭）
      if (cfg.enableLogTransport) {
        stopTransport = registerLogTransport((logObj) => {
          if (!logProducer || !LogItem || !Content) return;
          try {
            // transport 失败时记录错误日志（而非静默忽略）
            const parsed = parseLogObj(logObj);

            // 过滤低于 minLevel 的日志
            const levelWeight = LOG_LEVEL_WEIGHT[parsed.level] ?? 0;
            if (levelWeight < minLevelWeight) return;

            const item = new LogItem();
            item.setTime(Math.floor(parsed.timestamp / 1000));

            item.pushBack(new Content("level", parsed.level));
            // message 脱敏后上报
            item.pushBack(new Content("message", redactSensitiveText(parsed.message)));
            item.pushBack(new Content("source", cfg.source));

            if (parsed.subsystem) {
              item.pushBack(new Content("subsystem", parsed.subsystem));
            }
            if (parsed.logger) {
              item.pushBack(new Content("openclaw.logger", parsed.logger));
            }
            // 父 logger 名称
            if (parsed.parentNames) {
              item.pushBack(new Content("openclaw.logger.parents", parsed.parentNames));
            }
            // 代码位置信息
            if (parsed.codePath) {
              item.pushBack(new Content("code.filepath", parsed.codePath));
            }
            if (parsed.codeLine !== undefined) {
              item.pushBack(new Content("code.lineno", String(parsed.codeLine)));
            }
            if (parsed.codeFunction) {
              item.pushBack(new Content("code.function", parsed.codeFunction));
            }
            if (parsed.codeLocation) {
              item.pushBack(new Content("openclaw.code.location", parsed.codeLocation));
            }

            for (const [k, v] of Object.entries(parsed.extra)) {
              item.pushBack(new Content(k, v));
            }

            logProducer.send(item).catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : JSON.stringify(e);
              ctx.logger.warn(`diagnostics-cls: log send 失败: ${msg}`);
            });
          } catch (err) {
            // transport 失败时记录错误日志
            ctx.logger.error(
              `diagnostics-cls: log transport failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      }
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      stopTransport?.();
      stopTransport = null;
      stopAppLogTransport?.();
      stopAppLogTransport = null;
      // 统一置空所有 producer 及 serviceCtx（SDK 无 shutdown 接口，依赖 GC 回收）
      serviceCtx = null;
      producer = null;
      traceProducer = null;
      logProducer = null;
      metricsProducer = null;
      conversationLogProducer = null;
      sessionLogProducer = null;
      appLogProducer = null;
      LogItem = null;
      Content = null;
    },
  } satisfies DiagnosticsClsService;
}
