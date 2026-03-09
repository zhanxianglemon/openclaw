/**
 * 日志文件监听模块
 *
 * 负责监听两条日志链路并将解析好的条目通过回调交给调用方上报：
 *   1. 应用运行日志 (/tmp/openclaw/openclaw-YYYY-MM-DD.log)
 *   2. Session JSONL (~/.openclaw/agents/*\/sessions/*.jsonl)
 *
 * 上报方式由调用方决定（diagnostics-cls 使用 tencentcloud-cls-sdk-nodejs）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 解析后的日志条目，交给调用方上报 */
export type LogEntry = {
  /** 日志时间戳（毫秒） */
  time: number;
  /** 日志内容键值对 */
  contents: Array<{ key: string; value: string }>;
};

/** 文件尾部监听状态 */
type FileTailState = {
  filePath: string;
  offset: number;
  /** 缓冲区，保留扩展空间 */
  buffer: string;
  rl: readline.Interface | null;
  stream: fs.ReadStream | null;
};

// ─── JSONL 解析 ───────────────────────────────────────────────────────────────

/**
 * 将一行 JSONL 文本解析为日志条目
 */
function parseJsonlLine(line: string, source: "session" | "app"): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const time =
      typeof obj["time"] === "number"
        ? obj["time"]
        : typeof obj["ts"] === "number"
          ? obj["ts"]
          : typeof obj["timestamp"] === "string"
            ? new Date(obj["timestamp"] as string).getTime()
            : typeof obj["timestamp"] === "number"
              ? obj["timestamp"]
              : Date.now();

    const contents: Array<{ key: string; value: string }> = [
      { key: "source", value: source },
      { key: "raw", value: trimmed },
    ];

    // 提取常用字段作为独立索引字段，方便 CLS 检索
    for (const field of ["type", "level", "subsystem", "channel", "sessionId", "sessionKey"]) {
      const val = obj[field];
      if (val !== undefined && val !== null) {
        contents.push({ key: field, value: String(val) });
      }
    }

    // ── Session JSONL 费用/Token 字段提取 ──────────────────────────────────────
    if (source === "session" && obj["type"] === "message") {
      const msgId = obj["id"];
      if (msgId !== undefined) {
        contents.push({ key: "msgId", value: String(msgId) });
      }
      const parentId = obj["parentId"];
      if (parentId !== undefined && parentId !== null) {
        contents.push({ key: "parentId", value: String(parentId) });
      }

      const msg = obj["message"] as Record<string, unknown> | undefined;
      if (msg && typeof msg === "object") {
        const role = msg["role"];
        if (role !== undefined) {
          contents.push({ key: "role", value: String(role) });
        }

        for (const field of ["api", "provider", "model"]) {
          const val = msg[field];
          if (val !== undefined && val !== null) {
            contents.push({ key: field, value: String(val) });
          }
        }

        const stopReason = msg["stopReason"];
        if (stopReason !== undefined && stopReason !== null) {
          contents.push({ key: "stopReason", value: String(stopReason) });
        }

        const usage = msg["usage"] as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
            const val = usage[field];
            if (typeof val === "number") {
              contents.push({ key: `usage_${field}`, value: String(val) });
            }
          }

          const cost = usage["cost"] as Record<string, unknown> | undefined;
          if (cost && typeof cost === "object") {
            for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
              const val = cost[field];
              if (typeof val === "number") {
                contents.push({ key: `cost_${field}`, value: val.toFixed(8) });
              }
            }
          }
        }

        // ── 提取消息文本内容（用户问题 / AI 回复 / 工具结果）──────────────────
        const roleStr = typeof msg["role"] === "string" ? msg["role"] : "";
        const contentArr = Array.isArray(msg["content"]) ? (msg["content"] as unknown[]) : null;

        if (contentArr) {
          if (roleStr === "user") {
            // 用户消息：提取所有 type=text 的文本拼接为问题内容
            const textParts: string[] = [];
            for (const block of contentArr) {
              if (
                block !== null &&
                typeof block === "object" &&
                (block as Record<string, unknown>)["type"] === "text"
              ) {
                const t = (block as Record<string, unknown>)["text"];
                if (typeof t === "string" && t.trim()) {
                  textParts.push(t.trim());
                }
              }
            }
            if (textParts.length > 0) {
              contents.push({ key: "userMessage", value: textParts.join("\n") });
            }
          } else if (roleStr === "assistant") {
            // AI 回复：提取所有 type=text 的文本拼接为回复内容（跳过 thinking）
            const textParts: string[] = [];
            const toolCalls: string[] = [];
            for (const block of contentArr) {
              if (block === null || typeof block !== "object") continue;
              const b = block as Record<string, unknown>;
              if (b["type"] === "text") {
                const t = b["text"];
                if (typeof t === "string" && t.trim()) {
                  textParts.push(t.trim());
                }
              } else if (b["type"] === "toolCall") {
                const name = b["name"];
                if (typeof name === "string") {
                  toolCalls.push(name);
                }
              }
            }
            if (textParts.length > 0) {
              contents.push({ key: "assistantMessage", value: textParts.join("\n") });
            }
            if (toolCalls.length > 0) {
              contents.push({ key: "toolCalls", value: toolCalls.join(",") });
            }
          } else if (roleStr === "toolResult") {
            // 工具结果：提取工具名称和结果文本
            const toolName = msg["toolName"];
            if (typeof toolName === "string") {
              contents.push({ key: "toolName", value: toolName });
            }
            const isError = msg["isError"];
            if (isError !== undefined) {
              contents.push({ key: "toolIsError", value: String(isError) });
            }
            const resultParts: string[] = [];
            for (const block of contentArr) {
              if (block === null || typeof block !== "object") continue;
              const b = block as Record<string, unknown>;
              if (b["type"] === "text") {
                const t = b["text"];
                if (typeof t === "string" && t.trim()) {
                  resultParts.push(t.trim());
                }
              }
            }
            if (resultParts.length > 0) {
              // 工具结果可能很长，截断到 2000 字符避免 CLS 单条日志过大
              const resultText = resultParts.join("\n");
              contents.push({
                key: "toolResult",
                value: resultText.length > 2000 ? resultText.slice(0, 2000) + "…" : resultText,
              });
            }
          }
        }
      }
    }

    return { time, contents };
  } catch {
    // 非 JSON 行，作为纯文本上报
    return {
      time: Date.now(),
      contents: [
        { key: "source", value: source },
        { key: "raw", value: trimmed },
      ],
    };
  }
}

// ─── LogFileUploader ──────────────────────────────────────────────────────────

export type LogFileUploaderOptions = {
  /**
   * 是否启用应用运行日志监听（/tmp/openclaw/openclaw-YYYY-MM-DD.log），默认 false
   */
  enableAppLog?: boolean;
  /**
   * 是否启用 Session JSONL 监听（~/.openclaw/agents/*\/sessions/*.jsonl），默认 false
   */
  enableSessionLog?: boolean;
  /**
   * Gateway 状态目录，用于定位 Session JSONL 文件，默认 ~/.openclaw
   */
  stateDir?: string;
  /**
   * 解析到日志条目时的回调，由调用方负责上报
   */
  onAppLogEntry: (entry: LogEntry) => void;
  /**
   * 解析到 Session 日志条目时的回调，由调用方负责上报
   */
  onSessionLogEntry: (entry: LogEntry) => void;
  /**
   * 上报批次大小（条数），默认 100
   */
  batchSize?: number;
  /**
   * 定时刷新间隔（ms），默认 5000
   */
  flushIntervalMs?: number;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  };
};

/**
 * 日志文件监听器
 *
 * 监听应用运行日志和 Session JSONL 文件，将解析好的条目通过回调交给调用方上报。
 * 上报方式完全由调用方决定，本类不做任何网络请求。
 */
export class LogFileUploader {
  private readonly _opts: Required<
    Pick<
      LogFileUploaderOptions,
      "enableAppLog" | "enableSessionLog" | "stateDir" | "batchSize" | "flushIntervalMs"
    >
  > &
    Omit<
      LogFileUploaderOptions,
      "enableAppLog" | "enableSessionLog" | "stateDir" | "batchSize" | "flushIntervalMs"
    >;

  private _appLogBuffer: LogEntry[] = [];
  private _sessionLogBuffer: LogEntry[] = [];
  private _flushTimer: NodeJS.Timeout | null = null;
  private _appLogTail: FileTailState | null = null;
  private _sessionWatcher: fs.FSWatcher | null = null;
  private _sessionTails: Map<string, FileTailState> = new Map();
  private _stopped = false;

  constructor(opts: LogFileUploaderOptions) {
    this._opts = {
      enableAppLog: opts.enableAppLog ?? false,
      enableSessionLog: opts.enableSessionLog ?? false,
      stateDir: opts.stateDir ?? path.join(os.homedir(), ".openclaw"),
      batchSize: opts.batchSize ?? 100,
      flushIntervalMs: opts.flushIntervalMs ?? 5000,
      onAppLogEntry: opts.onAppLogEntry,
      onSessionLogEntry: opts.onSessionLogEntry,
      logger: opts.logger,
    };
  }

  /**
   * 启动监听
   */
  start(): void {
    if (this._stopped) {
      return;
    }
    if (this._opts.enableAppLog) {
      this._startAppLogTail();
    }
    if (this._opts.enableSessionLog) {
      this._startSessionLogWatch();
    }
    // 定时批量 flush
    this._flushTimer = setInterval(() => {
      void this._flush();
    }, this._opts.flushIntervalMs);
    this._flushTimer.unref?.();
    this._opts.logger.info(
      `log-file-uploader: started (appLog=${this._opts.enableAppLog}, sessionLog=${this._opts.enableSessionLog})`,
    );
  }

  /**
   * 停止监听
   */
  async stop(): Promise<void> {
    this._stopped = true;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._stopAppLogTail();
    this._stopSessionWatch();
    // stop 时最后一次 flush
    await this._flush();
    this._opts.logger.info("log-file-uploader: stopped");
  }

  // ─── 应用运行日志监听 ──────────────────────────────────────────────────────

  private _startAppLogTail(): void {
    // 使用 /tmp 而非 os.tmpdir()，因为 macOS 上 os.tmpdir() 返回 /var/folders/...
    // 而 gateway 实际写日志路径是 /tmp/openclaw/...（/tmp 是 /private/tmp 的软链接）
    const logDir = path.join("/tmp", "openclaw");
    const today = this._formatDate(new Date());
    const logFile = path.join(logDir, `openclaw-${today}.log`);

    this._openAppLogTail(logFile);

    // 每天零点切换日志文件
    setTimeout(() => {
      this._rotateAppLogFile();
    }, this._msUntilMidnight()).unref?.();
  }

  private _openAppLogTail(filePath: string): void {
    this._stopAppLogTail();
    try {
      let offset = 0;
      try {
        const stat = fs.statSync(filePath);
        offset = stat.size;
      } catch {
        offset = 0;
      }

      const tail: FileTailState = { filePath, offset, buffer: "", rl: null, stream: null };
      this._appLogTail = tail;
      this._opts.logger.debug(
        `log-file-uploader: tailing app log ${filePath} from offset ${offset}`,
      );
      this._startStreamTail(tail, "app");
    } catch (err) {
      this._opts.logger.warn(`log-file-uploader: failed to open app log tail: ${String(err)}`);
    }
  }

  private _stopAppLogTail(): void {
    if (this._appLogTail) {
      this._closeStreamTail(this._appLogTail);
      this._appLogTail = null;
    }
  }

  private _rotateAppLogFile(): void {
    const logDir = path.join("/tmp", "openclaw");
    const today = this._formatDate(new Date());
    const logFile = path.join(logDir, `openclaw-${today}.log`);
    this._openAppLogTail(logFile);

    setTimeout(() => {
      this._rotateAppLogFile();
    }, this._msUntilMidnight()).unref?.();
  }

  // ─── Session JSONL 监听 ────────────────────────────────────────────────────

  private _startSessionLogWatch(): void {
    const agentsDir = path.join(this._opts.stateDir, "agents");
    this._scanSessionFiles(agentsDir);

    try {
      this._sessionWatcher = fs.watch(agentsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith(".jsonl")) {
          const fullPath = path.join(agentsDir, filename);
          if (!this._sessionTails.has(fullPath)) {
            this._openSessionTail(fullPath);
          }
        }
      });
    } catch (err) {
      this._opts.logger.warn(`log-file-uploader: failed to watch agents dir: ${String(err)}`);
    }
  }

  private _scanSessionFiles(agentsDir: string): void {
    try {
      if (!fs.existsSync(agentsDir)) {
        return;
      }
      const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const agent of agents) {
        if (!agent.isDirectory()) {
          continue;
        }
        const sessionsDir = path.join(agentsDir, agent.name, "sessions");
        try {
          const files = fs.readdirSync(sessionsDir, { withFileTypes: true });
          for (const file of files) {
            if (file.isFile() && file.name.endsWith(".jsonl")) {
              this._openSessionTail(path.join(sessionsDir, file.name));
            }
          }
        } catch {
          // sessions 目录可能不存在
        }
      }
    } catch {
      // agents 目录可能不存在
    }
  }

  private _openSessionTail(filePath: string): void {
    if (this._sessionTails.has(filePath)) {
      return;
    }
    let offset = 0;
    try {
      const stat = fs.statSync(filePath);
      offset = stat.size;
    } catch {
      offset = 0;
    }
    const tail: FileTailState = { filePath, offset, buffer: "", rl: null, stream: null };
    this._sessionTails.set(filePath, tail);
    this._opts.logger.debug(`log-file-uploader: tailing session log ${filePath}`);
    this._startStreamTail(tail, "session");
  }

  private _stopSessionWatch(): void {
    if (this._sessionWatcher) {
      try {
        this._sessionWatcher.close();
      } catch {
        // ignore
      }
      this._sessionWatcher = null;
    }
    for (const [, tail] of this._sessionTails) {
      this._closeStreamTail(tail);
    }
    this._sessionTails.clear();
  }

  // ─── 流式 tail ─────────────────────────────────────────────────────────────

  /**
   * 启动流式 tail：从 offset 处创建 ReadStream，通过 readline 逐行读取。
   * 流读完后监听文件变化，有新内容时重新打开流继续读取。
   */
  private _startStreamTail(tail: FileTailState, source: "app" | "session"): void {
    if (this._stopped) {
      return;
    }
    this._closeStreamTail(tail);

    const openStream = () => {
      if (this._stopped) {
        return;
      }
      try {
        const stream = fs.createReadStream(tail.filePath, {
          encoding: "utf8",
          start: tail.offset,
          autoClose: true,
        });

        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        tail.stream = stream;
        tail.rl = rl;

        rl.on("line", (line) => {
          tail.offset += Buffer.byteLength(line, "utf8") + 1;
          const entry = parseJsonlLine(line, source);
          if (!entry) {
            return;
          }
          // 先入缓冲区，由 _flush 批量上报
          if (source === "app") {
            this._appLogBuffer.push(entry);
          } else {
            this._sessionLogBuffer.push(entry);
          }
        });

        stream.on("end", () => {
          tail.rl = null;
          tail.stream = null;
          if (!this._stopped) {
            fs.watchFile(tail.filePath, { persistent: false, interval: 500 }, (curr, prev) => {
              if (curr.size > prev.size) {
                fs.unwatchFile(tail.filePath);
                openStream();
              }
            });
          }
        });

        stream.on("error", (err) => {
          tail.rl = null;
          tail.stream = null;
          this._opts.logger.warn(
            `log-file-uploader: stream error on ${tail.filePath}: ${String(err)}`,
          );
        });
      } catch (err) {
        this._opts.logger.warn(
          `log-file-uploader: failed to create stream for ${tail.filePath}: ${String(err)}`,
        );
      }
    };

    openStream();
  }

  private _closeStreamTail(tail: FileTailState): void {
    fs.unwatchFile(tail.filePath);
    if (tail.rl) {
      try {
        tail.rl.close();
      } catch {
        // ignore
      }
      tail.rl = null;
    }
    if (tail.stream) {
      try {
        tail.stream.destroy();
      } catch {
        // ignore
      }
      tail.stream = null;
    }
  }

  // ─── 批量上报 ──────────────────────────────────────────────────────

  /**
   * 批量将缓冲区中的条目通过回调上报
   * 上报失败时将日志放回缓冲区头部（最多保留 1000 条防止内存溢出）
   */
  private async _flush(): Promise<void> {
    // 早退优化：与 otel 保持一致，_stopped 且缓冲区为空时直接返回
    if (this._stopped && this._appLogBuffer.length === 0 && this._sessionLogBuffer.length === 0) {
      return;
    }
    // 正常运行时缓冲区为空也直接跳过
    if (this._appLogBuffer.length === 0 && this._sessionLogBuffer.length === 0) {
      return;
    }
    // 上报应用日志
    if (this._appLogBuffer.length > 0) {
      const batch = this._appLogBuffer.splice(0, this._opts.batchSize);
      try {
        for (const entry of batch) {
          this._opts.onAppLogEntry(entry);
        }
      } catch (err) {
        this._opts.logger.error(`log-file-uploader: app log flush failed: ${String(err)}`);
        // 上报失败时将日志放回缓冲区头部
        this._appLogBuffer.unshift(
          ...batch.slice(0, Math.max(0, 1000 - this._appLogBuffer.length)),
        );
      }
    }

    // 上报 Session 日志
    if (this._sessionLogBuffer.length > 0) {
      const batch = this._sessionLogBuffer.splice(0, this._opts.batchSize);
      try {
        for (const entry of batch) {
          this._opts.onSessionLogEntry(entry);
        }
      } catch (err) {
        this._opts.logger.error(`log-file-uploader: session log flush failed: ${String(err)}`);
        this._sessionLogBuffer.unshift(
          ...batch.slice(0, Math.max(0, 1000 - this._sessionLogBuffer.length)),
        );
      }
    }
  }

  // ─── 工具方法 ──────────────────────────────────────────────────────

  private _formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private _msUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  }
}
