# 金十实时终端 · JIN10 MCP TERMINAL

通过**标准 MCP 协议**接入 [金十数据](https://mcp.jin10.com) 与 [智堡 Wisburg](https://mcp.wisburg.com) 的实时财经终端。

一个 Node 进程同时承担 MCP 客户端、额度调度器、SSE 广播器与前端静态托管，Railway 上只需要部署一个服务。

---

## 它解决的核心问题

金十的限制是**每个工具每天 1500 次调用**。这跟"实时"是直接冲突的：1 秒轮询一次，25 分钟就把当天额度烧光。

这个项目的整套架构都是围绕这个约束设计的：

| 手段 | 效果 |
|---|---|
| **服务端单例轮询 + SSE 扇出** | 100 个浏览器和 1 个浏览器消耗完全相同的额度 |
| **额度铺满调度** | `86400s ÷ (1500 × 0.9) = 64 秒/次`，正好把日额度摊平到 24 小时，永不提前断供 |
| **双通道并行** | `get_quote` 与 `get_kline` 是两套独立的 1500/天，合计 **2700 次/天 ≈ 32 秒一次调用** |
| **加权最陈旧优先** | 宏观锚（黄金/原油/美元/美股/中国）刷得快，长尾慢慢补，冷启动一次性冲满 |
| **在途请求合并** | 同一秒 10 个页面点开同一根 K 线 = 1 次真实调用 |
| **本地额度账本** | 按北京时间自然日计数，快耗尽时自动拉长间隔而不是撞墙 429 |

### 覆盖范围与刷新率的取舍

这是硬算术，界面上如实显示，不做粉饰：

```
2700 次/天 ÷ 288 次（5 分钟刷新一个品种所需） ≈ 9
```

**24 小时不间断 + 5 分钟刷新，最多只能覆盖 9 个品种。** 所以提供两档，随时可切：

| 档位 | 覆盖 | 核心品种刷新 | 长尾刷新 |
|---|---|---|---|
| **核心** | 9 个宏观锚 | **约 4.6 分钟** | — |
| **全部**（默认） | 33 个品种 | 约 10 分钟 | 约 31 分钟 |

快讯 / 资讯 / 日历各有独立的 1500/天，按 64 秒轮询只用掉 90%，全天候无压力。

---

## 功能

### 终端页
- 自选行情，报价跳动时闪烁提示，红涨绿跌 / 绿涨红跌可切换
- 分钟级 K 线（TradingView lightweight-charts），北京时间轴，实时价推动最后一根蜡烛
- 7×24 快讯流，新条目高亮滑入，关键词搜索 + 热词
- 财经日历，星级重要性、利多/利空标注，自动定位到"下一个待公布"
- 深度资讯列表 + 全文阅读

### 总览页
- 市场宽度条（涨/平/跌分布 + 多头占比）
- 领涨/领跌榜
- 按**地区**或**品种**汇总的中心发散条形图
- 分组热力矩阵，色阶按涨跌幅分五档，超时数据打斜纹标记
- 覆盖度面板：实时显示当前刷新间隔、整轮周期、日调用预算

### 研究页（智堡）
- 资讯流 / 市场日报 / 投行研报 / 企业研究 / 资管报告 / 公开文献 / 电话会纪要 / 深度文章 / 数据图表
- 全文搜索 + 游标翻页
- Markdown 正文渲染

### 一键导出报告
顶栏「⤓ 导出报告」，服务端用内存快照生成完整市场日报 —— **导出本身不消耗任何金十额度**，可以随便点。

| 格式 | 用途 |
|---|---|
| **HTML** | 新标签打开，自带打印按钮，A4 排版可直接存为 PDF |
| **Markdown** | 下载 `.md`，可粘进微信 / 邮件 / 笔记 |
| **JSON** | 下载结构化数据，便于二次处理 |

报告内容：市场概况（涨跌分布 + 按地区/按品种汇总 + 领涨领跌）、全品种行情明细（按地区分组，含今开/最高/最低/更新时延）、今日财经日历（已公布带前值预期实际与利多利空 / 待公布）、重要快讯、深度资讯。勾选「含智堡研究」会额外打 2 次智堡调用，附上市场日报与投研资讯流。

```bash
curl "http://localhost:8080/api/report?format=md&flash=40&news=10&star=3&research=1"
```

### 通用
- 日间 / 夜间主题（跟随系统，可手动覆盖，对比度 AAA 级）
- 额度水位条常驻顶栏
- 完全响应式，手机到宽屏

---

## MCP 接入实现

`server/src/mcp/client.ts` 是一个从零实现的 **Streamable HTTP** MCP 客户端，不依赖 `mcp-remote` 之类的 stdio 桥接。

**握手流程**（严格按协议）：

```
initialize → notifications/initialized → tools/list / resources/list → tools/call
```

- 协议版本 `2025-11-25`
- 认证：`Authorization: Bearer <token>`
- 会话：从 `initialize` 响应头取 `mcp-session-id`，后续请求带上；服务端不下发时自动降级为无状态模式
- 响应体同时支持 `application/json` 与 `text/event-stream`（金十走 SSE 单响应流）
- **服务端推送通道**：`GET /mcp` 长连接接收 `notifications/*`，支持 `Last-Event-ID` 断点续传与指数退避重连
- 会话失效（HTTP 404 / JSON-RPC `-32001`）自动重新握手并重放一次原请求

**两个数据源的关键差异**：

|  | 金十 | 智堡 |
|---|---|---|
| 服务 | `mcp-server v1.0.0` | `wisburg-mcp v0.7.0` |
| 工具数 | 8 | 11 |
| 资源 | `quote://codes` | 无 |
| 会话 | 下发 `mcp-session-id` | 无状态 |
| **结果格式** | **`structuredContent`**（机器解析主来源） | **仅 `content[0].text`**（markdown，需解析） |
| 分页 | `cursor` → `next_cursor` / `has_more` | `first` + `after` → `Next cursor: N` |

> 金十官方文档的示例写的是 `next_offset`，且快讯 item 带 `id`/`title`。**线上实际返回是 `next_cursor`，快讯只有 `content`/`time`/`url`。**
> 本项目按线上实测实现，并对文档里的可选字段做了容错。
> 另外文档未提及 `list_calendar`，但线上 `tools/list` 确实存在且可用 —— 本项目实现的是文档的超集。

**已接入的全部工具**

金十（8/8）：`get_quote` `get_kline` `list_flash` `search_flash` `list_news` `search_news` `get_news` `list_calendar`
资源：`quote://codes`

智堡（11/11）：`list-feed` `list-market-daily` `list-articles` `get-article-detail` `list-images` `list-institutional-reports` `list-company-reports` `list-am-reports` `list-archive-reports` `list-earning-calls` `get-report-detail`

---

## 本地运行

```bash
npm install
cp .env.example .env      # 填入 JIN10_TOKEN（必需）与 WISBURG_TOKEN（可选）
npm run dev               # server :8080 + vite :5173
```

生产模式（同一进程托管前端）：

```bash
npm run build && npm start   # → http://localhost:8080
```

---

## 部署到 Railway

仓库已包含 `railway.json` 与 `nixpacks.toml`，单服务即可。

```bash
railway link          # 关联项目
railway up            # 部署
```

在 Railway 的 **Variables** 面板配置（**不要**提交 `.env`）：

| 变量 | 必需 | 说明 |
|---|:--:|---|
| `JIN10_TOKEN` | ✅ | 金十 MCP Bearer Token |
| `WISBURG_TOKEN` | | 智堡 API Key，留空则关闭研究模块 |
| `SUSTAIN_HOURS` | | 默认 `24`（额度铺满 24 小时 = 64 秒/次） |
| `POLL_WHEN_IDLE` | | 默认 `true`（无人访问也持续刷新） |
| `ALWAYS_ON_UNIVERSE` | | 默认 `true`（始终覆盖 33 个品种） |
| `DAILY_TOOL_LIMIT` | | 默认 `1500` |
| `QUOTA_RESERVE_RATIO` | | 默认 `0.1`（10% 安全垫） |
| `PORT` | | Railway 自动注入 |

健康检查：`GET /api/health`

> Railway 会休眠无流量的服务。要真正 24/7 常驻，需要保证服务不被休眠（付费计划或外部保活）。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stream?codes=A,B&focus=A` | **SSE 实时通道**，事件：`hello` `quote` `kline` `flash` `news` `calendar` `quota` `status` `ping` |
| GET | `/api/health` | 健康检查 |
| GET | `/api/report?format=html\|md\|json` | **导出市场日报**。参数：`research=1` 含智堡、`flash=` 快讯条数、`news=` 资讯条数、`star=` 日历最低星级、`download=1` 强制下载。不消耗金十额度 |
| GET | `/api/universe` | 品种分类元数据 + 覆盖度 |
| POST | `/api/scope` | 切换覆盖范围 `{"scope":"core"\|"full"}` |
| GET | `/api/quota` | 额度快照 |
| GET | `/api/codes` | 支持的品种列表（走 `quote://codes` 资源，不计工具额度） |
| GET | `/api/quotes?codes=` | 行情快照 |
| GET | `/api/kline/:code?count=` | K 线 |
| GET | `/api/flash?cursor=` · `/api/flash/search?keyword=` | 快讯 |
| GET | `/api/news?cursor=` · `/api/news/search?keyword=` · `/api/news/:id` | 资讯 |
| GET | `/api/calendar` | 财经日历 |
| GET | `/api/research/feed\|daily\|articles\|images` | 智堡列表 |
| GET | `/api/research/reports/:category` | 智堡研报（`ib` `company` `am` `archive` `ec`） |
| GET | `/api/research/report/:category/:id` · `/api/research/article/:id` | 智堡详情 |

错误映射：工具业务错误 → `502`，触发限流 → `429`，协议错误 → `502`。

---

## 结构

```
server/src/
  mcp/client.ts       Streamable HTTP MCP 客户端（握手/SSE/会话自愈/推送流）
  mcp/jin10.ts        金十类型化门面（8 工具 + 1 资源）
  mcp/wisburg.ts      智堡类型化门面（11 工具 + markdown 解析器）
  core/quota.ts       按北京时间自然日的额度账本 + 自适应间隔
  core/scheduler.ts   双通道加权轮询调度器
  core/bus.ts         SSE 扇出中心
  core/cache.ts       TTL 缓存 + 在途请求合并
  core/universe.ts    33 品种宇宙的地区/资产分类
  routes/             REST + SSE 路由
web/src/
  components/         Header Sidebar Watchlist Hero Chart FlashFeed
                      NewsPanel CalendarPanel Overview Research CodePicker
  lib/                api / useStream / format
  styles.css          设计系统（双主题 + 双涨跌配色）
```

---

## 技术栈

Node 20+ · TypeScript · Express 5 · React 19 · Vite 6 · lightweight-charts 5 · 零 UI 框架（手写 CSS 设计系统）
