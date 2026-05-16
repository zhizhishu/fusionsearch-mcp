# sousuo 迁移到 Hugging Face LibreSearch 接口计划书

## 背景

`sousuo` 当前是一个 Node.js MCP 搜索服务，默认把搜索请求发往旧接口：

```text
https://search.002836.xyz/search
```

本次要基于 `libresearch` 项目的发现，把旧接口迁移为 Hugging Face 上的新 LibreSearch Space：

```text
https://echocq-libresearch.hf.space/search
```

相关发现：

- `libresearch` 已在 Hugging Face 创建 Public Docker Space。
- LibreSearch/SearXNG 理论上支持 `format=json` 搜索 API。
- 当前 HF Space 曾显示 `Paused`，因此迁移前需要先重启并复测 JSON API。
- Libre Search 支持生成随机 UUID，可作为 MCP 的独立能力或保留为空查询兜底逻辑。

## 目标

1. 将 `sousuo` 默认搜索端点从旧 `search.002836.xyz` 改为 Hugging Face LibreSearch。
2. 保留现有 MCP 工具名，减少 Cherry Studio 等客户端重新配置成本。
3. 更新所有用户可见文案，避免工具仍显示旧接口。
4. 保持现有 `SEARCH_ENDPOINT` 环境变量覆盖能力，方便临时回滚或切换。
5. 补充 Hugging Face Space 暂停、冷启动、JSON API 未启用时的错误提示。
6. 记录并适配 Libre Search 的随机 UUID 能力。

## 非目标

- 暂不重构 MCP transport 架构。
- 暂不删除 `search.sh` / Search-2api 相关工具，除非后续确认不再需要。
- 暂不引入数据库、缓存、队列或鉴权系统。
- 暂不改变现有部署脚本的目录约定。

## 影响范围

### 代码

- `src/app.js`
  - 修改 `DEFAULT_CONFIG.searchEndpoint`。
  - 更新工具标题、描述和日志里的旧接口名称。
  - 更新 `libresearch_search_dual` 中的来源标签，避免继续写 `search.002836`。
  - 检查 `search://config/endpoint` 输出是否准确描述 Hugging Face 端点。
  - 可选新增 `libresearch_uuid` tool，显式返回随机 UUID。

- `src/searchClient.js`
  - 保留通用 `executeSearch`。
  - 检查 `resolveQuery` 的空查询兜底：当前会生成 `random uuid <uuid>`，可继续保留；如果新增 UUID tool，则把 UUID 生成语义拆得更清楚。
  - 增加对 Hugging Face `Paused` / `Preparing Space` HTML 响应的识别，给出更明确错误。

- `src/server.js`
  - 保留环境变量注入逻辑。
  - 不需要改动，除非要新增配置项。

### 文档

- `README.md`
  - 将项目描述从旧 `search.002836.xyz` 改为 Hugging Face LibreSearch。
  - 更新 `SEARCH_ENDPOINT` 默认值。
  - 更新 SSE 调试示例和工具说明。
  - 增加 Hugging Face Space 冷启动/暂停说明。

- `TASK_LOG.md`
  - 按阶段记录计划、执行、验证和风险。

## 迁移步骤

### 第 1 步：复测 Hugging Face JSON API

先确认新端点是否能直接用于 MCP：

```bash
curl 'https://echocq-libresearch.hf.space/search?q=test&format=json&pageno=1'
```

预期：

- `Content-Type` 是 JSON 或响应体可解析为 JSON。
- 响应包含 `results`、`answers`、`suggestions` 等字段。

如果返回 Hugging Face 的 `Preparing Space` 或 `Paused` 页面：

- 先重启 Space。
- 等待运行状态恢复后再测。

如果返回 SearXNG 错误并提示格式不可用：

- 回到 `libresearch`，补 `settings.yml`，启用 `search.formats: [html, json]`。
- 更新 Hugging Face Space 后再测。

### 第 2 步：切换默认端点

把：

```js
searchEndpoint: 'https://search.002836.xyz/search'
```

改为：

```js
searchEndpoint: 'https://echocq-libresearch.hf.space/search'
```

保留：

```js
searchEndpoint: process.env.SEARCH_ENDPOINT
```

这样上线后仍可通过环境变量覆盖，符合 KISS 和 YAGNI。

### 第 3 步：清理旧接口文案

替换这些位置：

- README 项目说明。
- `libresearch_search` title/description。
- `libresearch_search_dual` 描述和输出来源标签。
- `search://config/endpoint` resource 描述。
- 主页/调试页上的 favicon 或提示文本。

目标是让用户看到的内容都指向 Hugging Face LibreSearch，而不是旧 `search.002836.xyz`。

### 第 4 步：增强错误提示

当前 `executeSearch` 默认直接 `response.json()`。如果 Hugging Face 返回 HTML，会变成不直观的 JSON 解析错误。

计划增加：

- 检查 `content-type`。
- 如果不是 JSON，先读取文本前 300-800 字。
- 命中 `Preparing Space` / `This Space has been paused` / Hugging Face HTML 时，返回明确提示：

```text
Hugging Face LibreSearch Space 当前未运行或正在冷启动，请重启/等待后重试。
```

这样比笼统 “搜索 API 请求失败” 更可操作。

### 第 5 步：处理随机 UUID 能力

当前已有：

```js
return query || `random uuid ${randomUUID()}`;
```

计划保留空查询兜底，并可新增一个明确 MCP 工具：

```text
libresearch_uuid
```

输出：

```json
{
  "uuid": "<random uuid>"
}
```

这个工具独立、低风险，不影响搜索链路。

### 第 6 步：验证

本地验证：

```bash
npm install
npm run dev
```

接口验证：

```bash
curl http://localhost:1666/health
curl -N "http://localhost:1666/api/search/stream?q=test"
```

MCP 验证：

- 确认 tools 列表仍包含现有工具。
- 调用 `libresearch_search`。
- 调用 `libresearch_search_toplinks`。
- 调用 `libresearch_search_answers`。
- 如果新增 UUID，调用 `libresearch_uuid`。

回归重点：

- 旧工具名不变。
- `SEARCH_ENDPOINT` 环境变量仍能覆盖。
- Hugging Face 暂停或冷启动时错误提示清楚。
- JSON API 正常时输出结构不变。

## 风险与回滚

### 风险 1：Hugging Face Space 被暂停

表现：

```text
Preparing Space
This Space has been paused
```

处理：

- 重启 Space。
- 或临时把 `SEARCH_ENDPOINT` 指回可用实例。

### 风险 2：JSON API 未启用

表现：

```text
format json is not supported
```

处理：

- 在 `libresearch` Space 中配置 SearXNG `search.formats: [html, json]`。

### 风险 3：公共 Space 响应慢

处理：

- 保留超时逻辑。
- 后续可加轻量健康检查或重试，但本次先不引入复杂缓存。

### 回滚方式

无需改代码即可回滚：

```bash
export SEARCH_ENDPOINT="https://search.002836.xyz/search"
npm start
```

如果代码已改，可用环境变量覆盖默认端点，避免紧急回滚成本。

## 待确认

1. 是否允许我重启 Hugging Face Space 做 JSON API 复测。
2. 是否新增 `libresearch_uuid` 独立 MCP tool。
3. `search.sh` / Search-2api 双源工具是否继续保留旧代理，还是也要改成 Hugging Face 单源。
