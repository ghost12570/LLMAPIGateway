# LLM API Gateway

企业级统一大模型中转网关 —— 100% 兼容 OpenAI 协议，聚合 OpenAI / Azure OpenAI / Anthropic Claude / DeepSeek / 阿里云百炼 / vLLM 等上游，提供智能路由、跨厂商故障降级、多级配额、限流、审计计费与可视化管理台。

- **零第三方依赖**：仅依赖 Node.js 24（内置 `fetch`、`node:sqlite`、`crypto`），无需 `npm install`
- **单文件数据库**：SQLite WAL，开箱即用，便于内网离线部署
- **双控制台**：管理后台 `/admin` + 开发者自助门户 `/portal`（原生 SPA，无 CDN 依赖）
- **完整测试**：23 项端到端测试覆盖代理、SSE、协议转换、熔断、配额、RBAC、SSO 加密等

---

## 目录

- [界面预览](#界面预览)
- [功能总览](#功能总览)
- [架构](#架构)
- [快速开始](#快速开始)
- [生产部署](#生产部署)
- [客户端接入](#客户端接入)
- [上游渠道配置](#上游渠道配置)
- [路由、熔断与 Fallback](#路由熔断与-fallback)
- [配额、限流与计费](#配额限流与计费)
- [安全设计](#安全设计)
- [企业 SSO](#企业-sso)
- [管理后台与自助门户](#管理后台与自助门户)
- [运维与监控](#运维与监控)
- [性能压测](#性能压测)
- [测试](#测试)
- [配置参考](#配置参考)
- [项目结构](#项目结构)
- [与 PRD 的覆盖关系与已知边界](#与-prd-的覆盖关系与已知边界)

---

## 界面预览

| 管理后台 · 运营概览 | 开发者门户 · 工作台 |
|---|---|
| ![管理后台运营概览](docs/screenshots/admin-overview.jpg) | ![开发者工作台](docs/screenshots/portal-overview.jpg) |

| 在线 Playground（SSE） | 财务报表与导出 |
|---|---|
| ![在线 Playground](docs/screenshots/playground.jpg) | ![财务报表](docs/screenshots/billing.jpg) |

---

## 功能总览

| 能力 | 实现 |
|---|---|
| OpenAI 协议兼容 | `/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/models`、`/v1/models/:id` |
| SSE 流式 | 逐行即时转发、首字节 TTFT 统计、Usage 自动补全、下游断连取消上游、心跳保活、背压 |
| 异构协议 | Anthropic Claude Messages API ↔ OpenAI 双向转换（请求/响应/SSE/工具调用/视觉）；Azure 部署名与 `api-version`；DeepSeek `reasoning_content` 透传；DashScope 兼容端点；私有 vLLM/Ollama |
| 路由 | 模型别名、模型级 Fallback Chain、智能路由 `auto` / `smart-fast` / `smart-coding` / `smart-reasoning`、渠道优先级 + 加权随机、单渠道并发上限 |
| 高可用 | 健康探测、断路器（连续失败 / 错误率）、30s 冷却、半开试探、首字节前自动换渠道、最多 3 跳 |
| 认证 | `sk-corp-` 内部 Key（SHA-256 + HMAC 查找哈希）、掩码、过期、启停、吊销、模型白名单、IP/CIDR 白名单 |
| 配额 | 公司 → 部门 → 用户 → Key 多级月度配额 + Key 总额度；软限 85% 告警、硬限 100% 熔断；PROD Key 可配置透支比例 |
| 限流 | 每 Key QPS 令牌桶 + TPM 滑动窗口；Redis 非必需（见[边界](#与-prd-的覆盖关系与已知边界)） |
| 计量 | 优先上游 `usage`；缺失时网关估算并标记 `estimated`；按模型价格 × 加价系数结算 |
| 管理 | 渠道 / Key 池 / 模型 / 组织 / 用户 / Key / 日志 / 账单 / 审计 / 系统设置 |
| 门户 | 工作台、Key 自助签发、模型广场、流式 Playground、用量与账单 |
| SSO | OIDC（自动发现 + JWKS + nonce 校验）、飞书、钉钉、通用 OAuth2 |
| 安全 | 上游 Key 与 SSO Secret AES-256-GCM 加密、会话 HttpOnly Cookie、CSRF 同源校验、CSP、不落盘 Prompt |
| 可观测 | Prometheus `/metrics`、实时 QPS / P95 / TTFT、按模型/渠道/组织统计、Webhook 告警、CSV 对账导出 |

---

## 架构

```text
                          ┌─────────────────────────────────────────────┐
  OpenAI SDK / Cursor     │                LLM Gateway                  │
  LangChain / 业务服务 ───▶│                                             │
  (Authorization:         │  边缘层  Request-ID · 32MB Body 上限 · 并发上限 │
   Bearer sk-corp-...)    │          CORS · 安全响应头 · 背压 503         │
                          │            │                                │
                          │  鉴权层    Key 哈希查找缓存 · 过期/冻结/CIDR     │
                          │            │                                │
                          │  限流层    QPS 令牌桶 · TPM 滑动窗口            │
                          │            │                                │
                          │  配额层    预估预扣 → 上游调用 → 精确结算       │
                          │            │                                │
                          │  路由层    别名 → Fallback Chain → 可用渠道     │
                          │            │  优先级/权重 · 断路器 · 半开探测   │
                          │            │                                │
                          │  适配层    OpenAI 直通 │ Anthropic 转换 │ Azure │
                          │            │                                │
                          │  SSE 管道  逐行透传 · TTFT · Usage 补全 · 取消  │
                          └────────────┬────────────────────────────────┘
                                       │ HTTP/1.1 Keep-Alive（Undici 连接池）
                     ┌─────────────────┼──────────────────┬─────────────────┐
                     ▼                 ▼                  ▼                 ▼
                 OpenAI            Anthropic          DeepSeek         vLLM / Ollama
                 Azure             Claude             DashScope        内网模型
```

**持久化与旁路：**

- SQLite（WAL）保存渠道、模型、用户、Key、日志、审计、设置
- 请求日志使用 120ms 批量写入缓冲，优雅关闭时强制 Flush
- 内存中维护速率桶、TPM 窗口、渠道断路器、路由快照、Key 鉴权缓存
- 配额与计费以 `request_logs` 为唯一账本，服务重启后按当前账期回算

---

## 快速开始

### 环境要求

- **Node.js ≥ 24.0**（使用内置 `node:sqlite`，无需安装依赖）
- 可选：Docker / Docker Compose

### 一键演示（推荐首次体验）

```bash
cd E:\MyTools\LLMGateway
npm run demo
```

该命令会：

1. 在 `127.0.0.1:9900` 启动一个同时兼容 OpenAI / Anthropic / Azure 协议的 Mock 上游；
2. 在 `data/demo` 初始化演示数据库、组织、用户、渠道、模型与 Key；
3. 生成约 1200 条跨 21 天的历史调用记录与实时示例流量；
4. 在 `127.0.0.1:8080` 启动网关。

访问：

| 入口 | 地址 |
|---|---|
| 管理后台 | http://127.0.0.1:8080/admin |
| 开发者门户 | http://127.0.0.1:8080/portal |
| OpenAI Base URL | http://127.0.0.1:8080/v1 |

演示账号（密码均为 `Admin@12345`）：

| 角色 | 邮箱 |
|---|---|
| 超级管理员 | `admin@corp.local` |
| 部门管理员 | `orgadmin@corp.local` |
| 普通开发者 | `dev@corp.local` |
| 财务审计员 | `auditor@corp.local` |

> 演示 API Key 会打印在终端，同时写入 `data/demo/demo-keys.json`。该文件包含明文 Key，仅用于本地演示。
>
> `npm run demo` 使用独立数据库，不会污染正式数据。按 `Ctrl+C` 同时关闭 Mock 与网关。

### 启动空环境

```bash
cp .env.example .env
# 编辑 .env，至少修改 BOOTSTRAP_ADMIN_PASSWORD
npm start
```

首次启动会创建 SQLite 数据库与首任超级管理员（默认 `admin@corp.local / Admin@12345`，请立即修改）。随后：

1. 登录 `/admin`；
2. 在「渠道管理」添加上游 Provider、Base URL、Master Key 与模型映射；
3. 在「模型与路由」启用模型、配置价格与降级链；
4. 在「用户与组织」创建成员和部门配额；
5. 用户在 `/portal` 自助创建 API Key，或管理员在「API Key」页面代为签发。

### 修改首任管理员密码

```bash
# 登录后调用（需要当前密码）
curl -X POST http://127.0.0.1:8080/api/portal/password \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"old_password":"Admin@12345","new_password":"your-new-password"}'
```

也可直接在数据库删除 `data/gateway.db` 后重新初始化（会丢失全部数据）。

---

## 生产部署

### Docker

```bash
cp .env.example .env
# 必须设置强随机 MASTER_SECRET
mkdir -p data && sudo chown -R 1000:1000 data   # 容器以 node(uid 1000) 运行
docker compose up -d --build
docker compose logs -f gateway
```

- `MASTER_SECRET` 用于派生 API Key 查找哈希、AES-256-GCM 加密密钥与会话签名。**一旦设置不可随意更改**，否则已加密的上游 Key 与 SSO Secret 将无法解密。
- 不配置 `MASTER_SECRET` 时，网关会生成 `data/master.key` 并持久化；生产环境建议显式注入。
- 数据卷 `./data:/app/data`；备份时同时备份 `gateway.db*` 与 `master.key`。

### 反向代理要点（Nginx）

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE 必须关闭缓冲
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    chunked_transfer_encoding on;
}
```

- 反向代理后请设置 `TRUST_PROXY=true`，否则 IP 白名单与日志中的客户端 IP 会变成代理 IP。
- 设置 `PUBLIC_BASE_URL=https://llm-gateway.corp.internal`，SSO 回调地址与快速接入示例会使用该地址。
- 建议在 TLS 终止层启用 HTTP/2；网关本身监听 HTTP/1.1。

---

## 客户端接入

只需替换 `BaseURL` 与 `APIKey`。

### cURL

```bash
curl https://llm-gateway.corp.internal/v1/chat/completions \
  -H "Authorization: Bearer sk-corp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"你好"}],
    "stream": true
  }'
```

### Python（官方 OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm-gateway.corp.internal/v1",
    api_key="sk-corp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
)

resp = client.chat.completions.create(
    model="smart-coding",
    messages=[{"role": "user", "content": "用 Python 写一个快速排序"}],
)
print(resp.choices[0].message.content)
```

### Node.js（官方 OpenAI SDK）

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://llm-gateway.corp.internal/v1',
  apiKey: 'sk-corp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
});

const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
});
for await (const part of stream) {
  process.stdout.write(part.choices[0]?.delta?.content || '');
}
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="claude-3-5-sonnet",
    base_url="https://llm-gateway.corp.internal/v1",
    api_key="sk-corp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
)
print(llm.invoke("总结这份文档").content)
```

### 智能路由别名

| 别名 | 行为 |
|---|---|
| `auto` | 根据 Prompt 长度、代码特征、工具调用自动选择分组 |
| `smart-fast` | 优先低延迟低成本模型 |
| `smart-coding` | 优先代码能力模型 |
| `smart-reasoning` | 优先思维链 / 推理模型 |

分组顺序在「系统设置 → smart_routes」中配置，默认：

```json
{
  "groups": {
    "fast": ["gpt-4o-mini", "deepseek-chat", "qwen-plus"],
    "coding": ["claude-3-5-sonnet", "qwen2.5-coder-32b", "deepseek-chat"],
    "reasoning": ["deepseek-reasoner", "o3-mini", "o1"],
    "flagship": ["gpt-4o", "claude-3-5-sonnet", "qwen-max"]
  }
}
```

---

## 上游渠道配置

每个渠道包含：`provider`、`base_url`、多个 Master Key、优先级、权重、超时、并发上限、额外请求头、模型映射。

| Provider | 协议 | Base URL 示例 | 说明 |
|---|---|---|---|
| `openai` | OpenAI 原生 | `https://api.openai.com/v1` | Bearer |
| `azure` | OpenAI 兼容 | `https://{resource}.openai.azure.com` | 使用 `api-key`，自动拼接 `/openai/deployments/{deployment}/...&api-version=`；需填写 API Version |
| `anthropic` | Claude Messages | `https://api.anthropic.com` | `x-api-key` + `anthropic-version`；请求/响应/SSE 自动转换 |
| `deepseek` | OpenAI 兼容 | `https://api.deepseek.com/v1` | `reasoning_content` 透传 |
| `dashscope` | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里百炼兼容端点 |
| `custom` | OpenAI 兼容 | `http://vllm.internal:8000/v1` | vLLM / Ollama / 内网代理；可加自定义鉴权头 |

**模型映射**：左侧为平台对外别名（必须在模型目录中存在），右侧为上游真实模型 ID 或 Azure Deployment 名。一个别名可以映射到多个渠道，同一渠道也可以映射多个别名。

**Key 池**：渠道支持多个 Master Key，请求按轮询选择；上游 Key 使用 AES-256-GCM 加密存储，列表仅显示末四位。

---

## 路由、熔断与 Fallback

### 解析顺序

```text
请求 model
  → 是否为智能别名？按 smart_routes 分组选目标
  → 目标模型别名 + 模型 fallback_chain
  → 每个别名收集启用渠道（优先级升序，同优先级按权重随机）
  → 排除已熔断 / 未配置 Key / 超过并发上限的渠道
  → 最多尝试 3 跳；每次失败换下一候选
```

同优先级渠道默认按权重随机排序；可在系统设置将 `routing.order_strategy` 切换为 `latency`，此时同优先级内按渠道最近平均延迟优先（跨优先级仍按 Priority 先后）。

### 断路器

| 参数 | 默认值 |
|---|---|
| 连续失败阈值 | 3 |
| 滑动窗口 | 20 |
| 窗口错误率阈值 | 25%（至少 8 个样本） |
| 冷却时间 | 30 秒 |
| 半开 | 冷却后允许 1 个试探请求 |

- 计为渠道失败的：超时、网络错误、HTTP 429/5xx、上游鉴权失败。
- 不计入渠道失败：客户端 4xx、参数错误、上下文超长。
- **首字节前**失败会自动重试并切换渠道；已经向客户端吐出内容后不会再切换，而是推送标准 SSE 错误事件。
- 主动健康探测每 30 秒执行，成功后会把熔断渠道恢复为 CLOSED。

---

## 配额、限流与计费

### 配额层级

```text
部门（可多层，父部门汇总子部门消耗）
  └── 用户（个人月度配额）
        └── API Key（Key 月度限额）
```

- 预约：请求前按 Prompt 估算 + 256 输出 Token 预留额度，任一作用域不足即 429 `quota_exceeded`。
- 结算：请求完成后用精确 usage 计算实际成本，原子释放预扣并计入用户、所有祖先部门、Key。
- 软限：85% 触发一次告警（飞书 / 企业微信 / 通用 Webhook）。
- 硬限：100% 阻断后续请求。
- `PROD` 标签 Key 的自身限额允许按 `quota.overdraft_prod_ratio`（默认 20%）透支；用户与部门硬限仍然生效。
- 用户/部门配额为 `0` 表示不限；Key 月度限额为 `0` 表示不限。
- Key 还支持独立的**总额度**（`total_limit_usd`），与月度限额同时生效。

### 限流

- 每 Key QPS：内存令牌桶，桶容量=QPS，按秒平滑补充。
- 每 Key TPM：60 秒滑动窗口，按 1 秒桶聚合。
- 默认值在系统设置中配置（默认 20 QPS / 500,000 TPM）；Key 可覆盖。
- 超限返回 `429 rate_limit_exceeded` + `Retry-After`。

### 计费

```text
cost = (prompt_tokens / 1000 × input_price
      + completion_tokens / 1000 × output_price)
      × markup_ratio
```

- 价格单位：USD / 1K tokens，在模型目录配置。
- 优先使用上游 `usage`；缺失时使用本地估算（英文约 4 chars/token，中文约 1.1 token/char），日志 `estimated=1`。
- 财务报表按部门 / 模型 / 用户 / 渠道 / 日期聚合，导出 CSV（含 BOM，Excel 可直接打开）。

### 429 错误区分

| code | 含义 |
|---|---|
| `rate_limit_exceeded` | Key 的 QPS / TPM 超限 |
| `quota_exceeded` | 用户 / 部门 / Key 月度额度耗尽 |
| `upstream_rate_limit` | 上游 429，且所有渠道均失败 |

---

## 安全设计

- **API Key**：`sk-corp-` + 32 位高熵字符；数据库保存 `SHA-256(salt + key)` 与 HMAC 查找哈希、掩码；明文仅在创建成功时展示一次。
- **上游 Key / SSO Client Secret**：AES-256-GCM（随机 IV + AuthTag）加密存储。
- **会话**：HMAC-SHA256 JWT，HttpOnly + SameSite=Lax Cookie，默认 12 小时；SSO 状态 10 分钟过期。
- **CSRF**：所有管理/门户写操作校验 Origin；SSO 使用随机 state + PKCE（OIDC/OAuth2）+ nonce 校验。
- **RBAC**：`SUPER_ADMIN` / `ORG_ADMIN` / `APP_USER` / `AUDITOR`；部门管理员只能操作本组织子树，审计员只读。
- **Prompt 隐私**：请求日志仅保存 RequestID、用户、Key、模型、渠道、耗时、Tokens、成本、状态码与错误；**不保存 Prompt / 生成内容**。
- **响应头**：CSP、`X-Frame-Options: DENY`、`nosniff`、无引用来源；SSE 设置 `X-Accel-Buffering: no`。
- **Metrics**：默认仅本机可访问；设置 `METRICS_USER` / `METRICS_PASSWORD` 后启用 Basic Auth。

> 生产必做：修改默认管理员密码、设置强 `MASTER_SECRET`、启用 HTTPS、关闭或限制密码登录、配置告警 Webhook、限制 `/metrics`、定期备份 `gateway.db` 与 `master.key`。

---

## 企业 SSO

「系统设置 → 企业 SSO 单点登录」支持：

- **OIDC**：填写 Issuer / Client ID / Secret / Scope。系统自动发现 `.well-known/openid-configuration`，从 JWKS 验签 id_token，校验 issuer / aud / exp / nonce。
- **飞书**：填写开放平台 App ID / App Secret，回调地址在页面显示，需要在飞书后台配置。
- **钉钉**：填写 Client ID / Client Secret，使用 OAuth2 用户授权码换取用户信息。
- **通用 OAuth2**：填写 authorize / token / userinfo 端点。

首次 SSO 登录可自动创建用户，默认角色与默认组织在系统设置中配置；也支持先由管理员创建用户、再通过同邮箱自动绑定。员工冻结会立即吊销其全部 API Key。

> LDAP 未实现；如需 LDAP 可对接外部 IdP 的 OIDC 代理。

---

## 管理后台与自助门户

### 管理后台 `/admin`

- **运营概览**：实时 QPS、24h 趋势、成功率、P95 延迟、TTFT、渠道健康、模型消费排行、最近错误与请求。
- **渠道管理**：Provider、Base URL、优先级 / 权重、Key 池、模型映射、一键连通性测试、启停、熔断重置。
- **模型与路由**：模型别名、能力、上下文、价格、可见性、降级链、智能路由分组。
- **用户与组织**：组织树、月度配额、用户状态、CSV 批量导入；冻结用户同时吊销其 Key。
- **API Key**：全平台检索、限额 / 速率 / 模型白名单、签发与强制吊销。
- **调用日志**：按 RequestID / 模型 / 状态 / 日期筛选，抽屉查看完整元数据。
- **财务报表**：部门 / 模型 / 用户 / 渠道 / 日期维度，CSV 导出。
- **审计日志**：管理员操作与登录安全事件。
- **系统设置**：计费、限流、断路器、保留期、告警、SSO、智能路由、运行状态。

### 开发者门户 `/portal`

- 个人工作台、额度进度、快速接入代码（cURL / Python / Node.js / Cursor / LangChain）
- 自助创建 Key、一次性明文展示、启停 / 删除、限额 / 模型 / IP 白名单
- 模型广场（价格、上下文、能力、可用性）
- 在线 Playground：浏览器内 SSE 流式调试，实时显示 Tokens 与估算费用
- 个人用量、模型分布与请求明细

---

## 运维与监控

| 端点 | 说明 |
|---|---|
| `GET /healthz` | 存活探针 |
| `GET /readyz` | 就绪探针（检查数据库） |
| `GET /metrics` | Prometheus 指标（请求数、错误、延迟直方图、TTFT、Token、成本、渠道错误、进程内存） |

```promql
sum(rate(llm_gateway_requests_total[1m]))
histogram_quantile(0.95, rate(llm_gateway_latency_ms_bucket[5m]))
sum(rate(llm_gateway_tokens_total[5m]))
```

- 请求日志默认保留 90 天（`logs.retention_days`），后台每 6 小时清理。
- 告警事件写入数据库，并推送到配置的 Webhook：配额 85% / 100%、渠道熔断 / 恢复。
- **备份**：停止服务后复制 `data/gateway.db`、`gateway.db-wal`（若存在）与 `data/master.key`；或使用 `sqlite3 data/gateway.db ".backup 'backup.db'"`。

---

## 性能压测

内置压测脚本（需要先创建高 QPS 的测试 Key）：

```bash
node scripts/loadtest.js \
  --url http://127.0.0.1:8080 \
  --key sk-corp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --model gpt-4o \
  --concurrency 100 \
  --duration 10

# 流式模式（统计 TTFT）
node scripts/loadtest.js --key sk-corp-... --model gpt-4o-mini \
  --stream --concurrency 40 --duration 8
```

**本机实测**（Windows 10、Node v24.15、单进程、Mock 上游固定 8ms 首包、回环网络）：

| 场景 | 并发 | 吞吐 | p50 | p95 | p99 | TTFT p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|
| 非流式 | 40 | **823 RPS** | 23.8ms | 72.7ms | 534ms | — |
| 非流式 | 100 | **919 RPS** | 40.2ms | 622.6ms | 719.8ms | — |
| 非流式 | 200 | 809 RPS | 85.9ms | 799.8ms | 917.7ms | — |
| 流式 | 40 | 111.5 RPS | 312ms | 739ms | 771ms | **16.9ms / 44.8ms** |

> 上述数据用于验证单节点链路的吞吐与网关附加延迟，不等同于 K8s 多节点 + 真实上游的 SLA 验收。受益于 Key 缓存与路由快照，稳态下每请求只有内存级路由开销；日志异步批量落盘。1000 QPS 以上的压测建议使用多进程/多节点与独立 Redis/Postgres（见边界说明）。

---

## 测试

```bash
npm test
```

测试覆盖：

1. 健康检查与 Bearer 鉴权
2. 渠道加密存储、管理概览
3. `/v1/models` 过滤与元数据
4. 非流式聊天、计费、脱敏日志
5. 智能路由（`auto`、流式别名回写）
6. SSE Usage 合成
7. Anthropic 非流式 / 流式 / 旧版 completions / 工具转换
8. Azure Deployment 映射与 DeepSeek reasoning_content 透传
9. Embeddings 与旧版 completions
10. 渠道级 Fallback、跨模型 Fallback Chain
11. 熔断打开、阻断、重置
12. 4xx 不重试、不计入熔断
13. 用户 / Key 硬配额
14. QPS 限流与 `Retry-After`
15. IP CIDR、模型白名单、上下文超限
16. RBAC 与自助门户、Playground
17. SSO Secret 加密
18. 流中上游断开的标准错误事件与部分计费
19. 批量用户导入、重复跳过与初始凭据
20. Prometheus、账单汇总、CSV 导出

---

## 配置参考

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8080` | 监听端口 |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | 对外地址，用于 SSO 回调与示例 |
| `DATA_DIR` | `./data` | 数据库、主密钥、演示 Key 目录 |
| `MASTER_SECRET` | 自动生成 | 主密钥；设置后请妥善保管且不可随意更换 |
| `BOOTSTRAP_ADMIN_EMAIL` | `admin@corp.local` | 首任管理员邮箱（仅首次初始化） |
| `BOOTSTRAP_ADMIN_PASSWORD` | `Admin@12345` | 首任管理员密码（仅首次初始化） |
| `BOOTSTRAP_ADMIN_NAME` | `平台管理员` | 首任管理员名称 |
| `MAX_CONCURRENT_REQUESTS` | `5000` | 服务级并发上限，超出返回 503 |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For` |
| `CORS_ORIGINS` | 空 | 允许浏览器跨域调用 `/v1` 的来源，逗号分隔 |
| `METRICS_USER` / `METRICS_PASSWORD` | 空 | `/metrics` Basic Auth；未设置时仅本机可访问 |
| `LOG_LEVEL` | `info` | `debug/info/warn/error/silent` |
| `DEMO_MODE` | `false` | 登录页展示演示账号提示 |

**运行时设置**（管理后台可改，立即生效）：平台名称、币种与汇率、加价系数、默认 QPS/TPM、Body 上限、最大尝试数、渠道排序策略、软限比例、透支比例、断路器参数、健康探测间隔、SSE 心跳、日志保留期、告警 Webhook、SSO、智能路由分组。

---

## 项目结构

```text
LLMGateway/
├── src/
│   ├── index.js                 # 进程入口 / 优雅关闭
│   ├── server.js                # HTTP 边缘层、路由注册、静态资源、CORS/CSP
│   ├── config.js                # 环境变量与主密钥
│   ├── db/                      # SQLite schema 与初始化
│   ├── util/                    # crypto、HTTP、错误、分词估算、日志、指标
│   ├── services/                # 渠道、路由、配额、限流、熔断、Key 鉴权、健康、SSO、审计
│   ├── providers/               # OpenAI/Azure、Anthropic 适配器
│   ├── gateway/                 # 代理引擎与 SSE 流式管道
│   ├── admin/                   # 管理后台 REST API
│   ├── portal/                  # 开发者门户 REST API
│   ├── auth/                    # 登录 / SSO 路由
│   └── web/                     # 原生 SPA（管理后台 + 门户）
├── scripts/
│   ├── demo.js                  # 一键演示（Mock + 网关 + 数据）
│   ├── demo-data.js             # 演示组织/用户/渠道/历史日志
│   ├── mock-upstream.js         # OpenAI/Anthropic/Azure Mock 上游
│   └── loadtest.js              # 内置压测
├── test/
│   ├── helpers.js
│   └── gateway.test.js          # 23 项端到端测试
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## 与 PRD 的覆盖关系与已知边界

### 已覆盖

- **核心网关**：OpenAI 协议全兼容、SSE、Anthropic/Azure/DeepSeek/百炼/私有部署适配、健康探测、断路器、优先级/权重、Fallback Chain、模型别名与智能路由。
- **安全认证**：内部 Key 签发与高性能鉴权、SSO（OIDC/飞书/钉钉/通用 OAuth2）、Master Key 加密、IP 白名单、QPS/TPM 限流。
- **计量配额**：预扣-结算、上游 usage + 本地兜底、多级配额、软/硬限、PROD 透支、部门费用分摊与 CSV 导出。
- **管理监控**：渠道/模型/用户/组织/Key 管理、实时大盘、调用日志、审计、告警、Prometheus。
- **自助门户**：Key 自助、模型广场、流式 Playground、用量与账单。
- **超出 PRD 的增强**：运行时智能路由配置、渠道并发上限、Key 级模型/IP 白名单、CSV 注入防护、SSO Secret 加密、设置界面。

### 明确的工程取舍（与 PRD 的差异）

1. **未接入 Redis / PostgreSQL**：PRD 要求 Redis 两级令牌桶与分布式配额，本项目按“单节点可离线运行”的目标，使用进程内令牌桶/滑动窗口 + SQLite WAL。接口已按服务边界拆分，但**当前不支持多实例共享限流/配额**。多节点部署前必须替换为 Redis（限流、配额预扣）与 Postgres（账本），否则会出现跨节点配额超发。
2. **Token 兜底估算不是精确 Tiktoken BPE**：上游 `usage` 为唯一权威口径；缺失时使用确定性字符估算，日志标记 `estimated=1`。对于严格财务对账场景，建议要求上游返回 usage，或在适配器中接入 `tiktoken`/厂商 tokenizer。
3. **日志批量写入**：约 120ms 缓冲窗口，进程崩溃可能丢失最后窗口内的日志/计量；正常运行与优雅关闭不丢。PRD 中 `RPO=0` 的金融级要求需引入同步账本（当前未实现）。
4. **SSO 状态存内存**：多实例部署时 SSO state 不共享；需粘性会话或迁移到 Redis。
5. **DashScope 仅支持 OpenAI 兼容模式**，未实现原生 DashScope 异步任务协议；Anthropic 多模态支持文本 + 图片，音频转换未实现。
6. **未实现**：语义缓存（F-EXT-01）、内联内容合规过滤（F-EXT-02）、LDAP、公网注册/支付、第三方应用市场——均属于 PRD 明确延后范围或 P1/P2。
7. **Metering 口径**：按上游返回 usage 结算，不包含缓存折扣、Batch API 等特殊计费；模型价格需管理员按采购合同维护。
8. **性能数据**为单机 Mock 压测，不代表多地域真实上游 SLA；生产验收需按 PRD 的 Locust/JMeter 场景在目标环境复测。

### 后续演进建议

- 抽象 `LimiterStore` / `QuotaStore` / `LogSink`，接入 Redis + Postgres，支持水平扩展；
- 引入 Tiktoken / Anthropic tokenizer 精确兜底；
- 增加账本表与同步写入模式，实现强一致计费；
- 原生 DashScope / Bedrock 适配器；
- 语义缓存与合规过滤插件（v2，按 PRD 延后）；
- 多租户审计导出与账单审批流。

---

## License

内部使用示例项目。请根据公司合规要求补充 License 与安全评审。
