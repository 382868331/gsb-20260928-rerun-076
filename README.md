# 接口设计与调试平台（第一版）

Go 后端 + React 前端的本地接口设计 / 模拟 / 调试平台。第一版聚焦：

- **请求定义**：方法、路径（含 `{param}` 路径参数）、接口启用开关。
- **场景保存**：场景定义以 JSON 落盘，保存后重新打开可继续编辑。
- **有状态的本地模拟接口**：规则命中后可 `set / increment / unset` 状态变量，
  响应体用 `{{ 表达式 }}` 引用本次请求和之前请求产生的状态；不是写死的返回值列表。
- **真实调试**：页面通过后端真正发起 HTTP 请求，展示状态码、响应体、耗时；
  延迟、HTTP 错误、超时挂起、直接断连、重复调用计数都按规则定义发生。
- **场景隔离**：每个场景独立的状态、计数器、历史；“重置”只清空当前场景。
- **启用前规则校验**：保存/勾选启用时检查矛盾（无条件规则遮蔽、重复条件导致不可达、
  接口重复、表达式错误、失败配置非法等），错误会阻止启用。

后续版本计划：接口变更的兼容性检查、自动文档生成。

## 目录结构

```
backend/
  cmd/server/         HTTP 服务入口（API + mock 路由 + 可选静态托管）
  internal/model/     数据模型
  internal/expr/      小型表达式/模板引擎
  internal/validate/  规则矛盾与合法性校验
  internal/engine/    模拟执行引擎（匹配/条件/延迟/失败/状态/历史）
  internal/store/     JSON 持久化（定义 + 运行状态）
  internal/api/       REST API
frontend/            React + Vite + TypeScript + zustand
```

## 运行

后端（默认 :8080，数据写到 ./data）：

```bash
cd backend
go run ./cmd/server -addr :8080 -data ./data
```

前端开发模式（已配置 /api 与 /m 代理到 8080）：

```bash
cd frontend
npm install
npm run dev
```

一体化部署（构建后由 Go 托管页面）：

```bash
cd frontend && npm run build
cd ../backend && go run ./cmd/server -static ../frontend/dist
```

## API

- `GET/POST /api/scenarios`，`GET/PUT/DELETE /api/scenarios/{id}`
- `POST /api/scenarios/{id}/validate`（可带未保存的定义做启用前校验）
- `GET /api/scenarios/{id}/state`，`POST /api/scenarios/{id}/reset`
- `ANY /m/{scenarioId}{endpointPath}` —— 模拟流量入口

## 规则表达式速览

- 字段：`body.x`、`query.x`、`headers.x`、`path.x`、`state.x`、`calls`（该接口被调用次数）
- 运算：`+ - * / %`、`== != > >= < <=`、`&& || !`
- 函数：`now()`、`uuid()`、`if(cond,a,b)`、`length(x)`、`concat(...)`、`json(x)`
- 响应示例：`{"id":"{{state.lastId}}","seq":{{calls}}}`

## 测试

```bash
cd backend && go test ./...
cd frontend && npx tsc -b --noEmit && npx vite build
```

后端测试覆盖：表达式求值、模板渲染、跨请求状态流转、失败分支、重复调用计数、
场景隔离与重置、规则矛盾检测、HTTP 全生命周期（含落盘重载）。
