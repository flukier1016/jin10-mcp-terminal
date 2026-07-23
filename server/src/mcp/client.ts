import { EventEmitter } from 'node:events';

/**
 * 标准 MCP 客户端（Streamable HTTP 传输）。
 *
 * 严格按协议握手：
 *   initialize -> notifications/initialized -> tools/list / resources/list -> tools/call
 *
 * 服务端以 text/event-stream 返回单条响应，并通过 `mcp-session-id` 响应头下发会话。
 * 会话失效（HTTP 404 / -32001）时自动重新握手并重放一次原请求。
 */

export interface McpClientOptions {
  url: string;
  token: string;
  protocolVersion: string;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?: number | string;
  result?: T;
  error?: JsonRpcError;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ToolCallResult<T = unknown> {
  /** 机器解析的主来源。 */
  structuredContent?: T;
  /** 仅作可读文本补充。 */
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** 工具返回业务错误（isError=true）时抛出。 */
export class McpToolError extends Error {
  readonly tool: string;
  readonly detail: string;
  constructor(tool: string, detail: string) {
    super(`[${tool}] ${detail}`);
    this.name = 'McpToolError';
    this.tool = tool;
    this.detail = detail;
  }
}

/** JSON-RPC 协议层错误。 */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = 'McpProtocolError';
    this.code = err.code;
    this.data = err.data;
  }
}

/** 金十的每日限流命中。 */
export class McpRateLimitError extends McpToolError {
  constructor(tool: string, detail: string) {
    super(tool, detail);
    this.name = 'McpRateLimitError';
  }
}

const RATE_LIMIT_HINT = '调用次数已达上限';

export class McpClient extends EventEmitter {
  private readonly opts: Required<McpClientOptions>;
  private sessionId: string | null = null;
  private handshake: Promise<void> | null = null;
  private nextId = 1;
  private serverInfo: { name?: string; version?: string } | null = null;
  private serverCapabilities: Record<string, unknown> | null = null;
  private notifyAbort: AbortController | null = null;
  private lastEventId: string | null = null;
  private notifyBackoff = 1_000;
  private closed = false;

  constructor(options: McpClientOptions) {
    super();
    this.opts = {
      clientName: 'jin10-mcp-terminal',
      clientVersion: '1.0.0',
      requestTimeoutMs: 20_000,
      maxRetries: 2,
      ...options,
    };
  }

  get connected(): boolean {
    return this.sessionId !== null;
  }

  get info() {
    return { sessionId: this.sessionId, serverInfo: this.serverInfo, capabilities: this.serverCapabilities };
  }

  // ── 公共 API ───────────────────────────────────────────────────

  async listTools(): Promise<ToolDefinition[]> {
    const r = await this.request<{ tools: ToolDefinition[] }>('tools/list', {});
    return r.tools ?? [];
  }

  async listResources(): Promise<ResourceDefinition[]> {
    const r = await this.request<{ resources: ResourceDefinition[] }>('resources/list', {});
    return r.resources ?? [];
  }

  /**
   * 调用工具。返回 structuredContent 中的 `data` 字段（金十统一信封）。
   * 约定：{ status, message, data }。
   */
  async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.request<ToolCallResult<{ status?: number; message?: string; data?: T }>>(
      'tools/call',
      { name, arguments: args },
    );

    if (result.isError) {
      const detail = textOf(result) || '工具返回未知业务错误';
      throw detail.includes(RATE_LIMIT_HINT)
        ? new McpRateLimitError(name, detail)
        : new McpToolError(name, detail);
    }

    // 主来源：structuredContent。content 仅在 structuredContent 缺失时兜底。
    let envelope = result.structuredContent;
    if (envelope === undefined) {
      const raw = textOf(result);
      if (raw) {
        try {
          envelope = JSON.parse(raw);
        } catch {
          /* 保持 undefined，走下面的报错 */
        }
      }
    }
    if (envelope === undefined) throw new McpToolError(name, '响应缺少 structuredContent');

    if (typeof envelope.status === 'number' && envelope.status !== 200) {
      const msg = envelope.message || `status=${envelope.status}`;
      throw msg.includes(RATE_LIMIT_HINT) ? new McpRateLimitError(name, msg) : new McpToolError(name, msg);
    }
    return envelope.data as T;
  }

  /**
   * 调用工具并返回未加工的 result。
   *
   * 智堡这类服务端不提供 structuredContent（只给人读的 markdown 文本），
   * 调用方需要自己拿 content 解析，因此单开这个不做信封假设的入口。
   */
  async callToolRaw(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return this.request<ToolCallResult>('tools/call', { name, arguments: args });
  }

  /** 读取资源，解析 JSON 型 contents。 */
  async readResource<T>(uri: string): Promise<T> {
    const r = await this.request<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>(
      'resources/read',
      { uri },
    );
    const first = r.contents?.[0];
    if (!first?.text) throw new McpToolError(uri, '资源内容为空');
    const parsed = JSON.parse(first.text) as { status?: number; message?: string; data?: T };
    return (parsed.data ?? parsed) as T;
  }

  /** 设置服务端日志级别；日志会通过 GET 推送流以 notifications/message 回来。 */
  async setLogLevel(level: 'debug' | 'info' | 'notice' | 'warning' | 'error'): Promise<void> {
    await this.request('logging/setLevel', { level });
  }

  /**
   * 打开 server→client 推送流（Streamable HTTP 的 GET 通道）。
   *
   * 用于接收 notifications/tools/list_changed、resources/list_changed 与 logging 消息。
   * 断线按指数退避重连，并用 Last-Event-ID 请求补发中断期间的事件。
   */
  openNotificationStream(): void {
    if (this.notifyAbort || this.closed) return;
    void this.runNotificationStream();
  }

  private async runNotificationStream(): Promise<void> {
    while (!this.closed) {
      try {
        await this.ensureSession();
        const ac = new AbortController();
        this.notifyAbort = ac;

        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.opts.token}`,
          'MCP-Protocol-Version': this.opts.protocolVersion,
        };
        if (this.sessionId && this.sessionId !== 'stateless') headers['Mcp-Session-Id'] = this.sessionId;
        if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

        const res = await fetch(this.opts.url, { method: 'GET', headers, signal: ac.signal });

        // 405 表示服务端不提供推送通道 —— 合法，直接放弃重试
        if (res.status === 405 || res.status === 501) {
          this.emit('notifyStream', 'unsupported');
          return;
        }
        if (res.status === 404 || res.status === 401) {
          this.invalidate(`notify stream HTTP ${res.status}`);
          throw new Error(`推送流会话失效 ${res.status}`);
        }
        if (!res.ok || !res.body) throw new Error(`推送流 HTTP ${res.status}`);

        this.emit('notifyStream', 'open');
        this.notifyBackoff = 1_000;
        await this.consumeStream(res.body);
        this.emit('notifyStream', 'closed');
      } catch (err) {
        if (this.closed) return;
        this.emit('notifyStream', `error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.notifyAbort = null;
      }
      if (this.closed) return;
      await sleep(this.notifyBackoff);
      this.notifyBackoff = Math.min(this.notifyBackoff * 2, 30_000);
    }
  }

  /** 增量解析 SSE：按空行切帧，逐条派发 JSON-RPC 通知。 */
  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
        this.dispatchFrame(frame);
      }
    }
  }

  private dispatchFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) this.lastEventId = line.slice(3).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let msg: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      msg = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params);
  }

  /** 主动关闭会话（优雅退出）。 */
  async close(): Promise<void> {
    this.closed = true;
    this.notifyAbort?.abort();
    this.notifyAbort = null;
    const sid = this.sessionId;
    this.sessionId = null;
    this.handshake = null;
    if (!sid || sid === 'stateless') return;
    try {
      await fetch(this.opts.url, {
        method: 'DELETE',
        headers: { ...this.baseHeaders(), 'Mcp-Session-Id': sid },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* 关闭失败无所谓 */
    }
  }

  // ── 传输层 ────────────────────────────────────────────────────

  private baseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.opts.token}`,
      'MCP-Protocol-Version': this.opts.protocolVersion,
    };
  }

  /** 确保已完成 initialize + notifications/initialized；并发调用只握手一次。 */
  private ensureSession(): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    if (!this.handshake) {
      this.handshake = this.doHandshake().catch((err) => {
        this.handshake = null;
        throw err;
      });
    }
    return this.handshake;
  }

  private async doHandshake(): Promise<void> {
    this.emit('status', 'connecting');
    const res = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: this.opts.protocolVersion,
        capabilities: {},
        clientInfo: { name: this.opts.clientName, version: this.opts.clientVersion },
      },
    });

    const sid = res.headers.get('mcp-session-id');
    const body = await readRpc(res);
    if (body?.error) throw new McpProtocolError(body.error);

    const result = body?.result as
      | { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> }
      | undefined;
    this.serverInfo = result?.serverInfo ?? null;
    this.serverCapabilities = result?.capabilities ?? null;
    this.sessionId = sid; // 服务端可能不下发会话，此时以 null 走无状态模式

    // 协议要求：initialize 之后必须发 initialized 通知，之后才能调用其它方法。
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sid ?? undefined);

    if (!this.sessionId) this.sessionId = 'stateless';
    this.emit('status', 'up');
    this.emit('ready', this.info);
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        await this.ensureSession();
        const id = this.nextId++;
        const res = await this.post(
          { jsonrpc: '2.0', id, method, params },
          this.sessionId === 'stateless' ? undefined : this.sessionId ?? undefined,
        );

        if (res.status === 404 || res.status === 401) {
          // 会话过期 / 鉴权刷新 —— 丢弃会话后重来
          this.invalidate(`HTTP ${res.status}`);
          lastErr = new Error(`会话失效 (HTTP ${res.status})`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
        }

        const body = await readRpc(res, id);
        if (body?.error) {
          // -32001 通常表示会话不存在
          if (body.error.code === -32001) {
            this.invalidate('session not found');
            lastErr = new McpProtocolError(body.error);
            continue;
          }
          throw new McpProtocolError(body.error);
        }
        if (body?.result === undefined) throw new Error('MCP 响应缺少 result');
        return body.result as T;
      } catch (err) {
        // 业务/协议错误不重试，只有传输层问题才重试
        if (err instanceof McpToolError || err instanceof McpProtocolError) throw err;
        lastErr = err;
        this.invalidate(err instanceof Error ? err.message : String(err));
        if (attempt < this.opts.maxRetries) await sleep(300 * 2 ** attempt);
      }
    }
    this.emit('status', 'down');
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private invalidate(reason: string) {
    if (this.sessionId) this.emit('reconnect', reason);
    this.sessionId = null;
    this.handshake = null;
  }

  private async post(payload: unknown, sessionId?: string): Promise<Response> {
    const headers = this.baseHeaders();
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return fetch(this.opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
    });
  }
}

// ── 工具函数 ────────────────────────────────────────────────────

/** 解析响应体：既支持 application/json，也支持 text/event-stream 单响应流。 */
async function readRpc(res: Response, wantId?: number | string): Promise<JsonRpcResponse | null> {
  if (res.status === 202) return null; // 通知的正常应答
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (!text) return null;

  if (contentType.includes('text/event-stream')) {
    const messages = parseSse(text);
    if (wantId !== undefined) {
      const matched = messages.find((m) => m.id === wantId);
      if (matched) return matched;
    }
    return messages.at(-1) ?? null;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

/** 从 SSE 文本里抽出所有 data: 行并解析为 JSON-RPC 消息。 */
function parseSse(text: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      /* 忽略非 JSON 的注释帧 */
    }
  }
  return out;
}

function textOf(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')
    .trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
