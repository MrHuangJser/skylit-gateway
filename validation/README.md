# 验证分层与复现顺序

必须区分：镜像/进程在线、本地入口授权、上游会话有效、真实接口数据、原版网页完整呈现、实时协议。后一项不能由前一项替代。

主机环境与镜像启动命令见[项目说明](../README.md)。下列脚本从仓库根目录运行。

## 1. 基础模式

启动不设置 `UPSTREAM_SESSION_FILE` 的容器到 48173，然后执行：

```text
node skylit-gateway/validation/probe.mjs
```

[基础脚本](probe.mjs)使用独立无头 Chrome 上下文，不读取日常浏览器配置。记录错误访问码、同源要求、HttpOnly 会话、设备隔离、写操作拒绝、公开 HTML 和本地退出；原站域名直连被浏览器路由阻止。公开 HTML 200 不等于原站应用可用。

## 2. 专用上游会话

必要时运行[专用登录脚本](upstream-login.mjs)，由用户在独立窗口正常登录一次，然后正常关闭窗口。脚本只记录 active 布尔状态，不导出凭证、不开放 CDP/HTTP 监听端口。

[独立 HTTP 会话对照](session-probe.mjs)会独占同一专用浏览器配置，在三个独立 Cookie 容器中只请求账户访问元数据，记录身份是否一致，不记录身份本身或响应正文。

```text
node skylit-gateway/validation/session-probe.mjs
```

不要同时运行使用同一专用配置的其它浏览器脚本。

## 3. Rust 会话链路

运行[短期会话辅助模块](session-exporter.mjs)：

```text
node skylit-gateway/validation/session-exporter.mjs
```

它使用用户已正常登录的专用配置，按照 SDK 正常缓存/刷新流程取 token，并将短期 Bearer 原子更新到中转端私密运行时快照；不导出 Cookie、不输出 token。默认安全截止时间是 1200 秒。正常退出会将快照置为无效；进程异常退出后 Rust 仍会按快照有效期 fail closed。状态记录可能比进程实际生命周期滞后，不能把历史 `active` 状态当作当前会话证明。

专用配置包含敏感长期会话；私密状态目录不得提交、公开、打包或复制到公司端。仅将短期快照子目录只读挂载给 Rust，不挂载整个浏览器配置。

辅助模块首次 ready 后，记录当时 token 的 advertised expiry，供后续跨期检查：

```text
node skylit-gateway/validation/session-window.mjs
```

脚本只输出时间元数据，不输出 JWT。expiry 是来自 token 的调度信息，不是本地签名验证结果。

启动会话模式容器到 48175，执行：

```text
node skylit-gateway/validation/session-gateway-probe.mjs
```

[公司端会话测试](session-gateway-probe.mjs)实际操作本地登录表单，在浏览器页面内部 fetch 受保护接口；第二设备用独立上下文验证本地授权和退出互不影响。这个测试不读取上游凭证。

## 4. 有界历史数据与原版页面

同一模式的容器启动到 48177，执行：

```text
node skylit-gateway/validation/chart-probe.mjs
```

[图表数据测试](chart-probe.mjs)只请求 SPY 单条搜索结果、历史五分钟窗和一个缺 symbol 对照，记录状态/点数/结构，不保存价格数组或原始数据。

页面可用性独立记录。即使错误页有可见文字，也不能判定原版 Atlas 成功。HTTP 历史数据成功也不等于实时图表、SSE 或 WebSocket 成功。

[页面授权诊断](page-auth-diagnostic.mjs)仅比较匿名与当前合法 Bearer 的固定 Atlas 页面请求，记录状态及当前 Bearer 是否出现在正文，不保存正文或重定向查询参数。不能将“未找到这一段 token”推广成完整敏感数据审计通过。

## 5. 失效链路

先停止辅助模块，确认快照已过期，再执行：

```text
node skylit-gateway/validation/fail-closed-probe.mjs
```

[失效测试](fail-closed-probe.mjs)默认 48177，可用 `GATEWAY_BASE` 设置其它本机回环端口。确认已获代理授权的设备在上游会话失效时收到 503；未获代理授权的设备仍然是 401。健康接口不能假报上游已登录。

## 证据与限制

结果均保存为脱敏 JSON，汇总见[验证报告](../VALIDATION.md)。正常打开上游站点可能触发网站自身后台读取；“没有执行交易或正式计费 API”不等于网站完全没有遥测或后台请求。本轮没有测试上游撤销、MFA 再认证、订阅变化、限流恢复或多用户并发。
