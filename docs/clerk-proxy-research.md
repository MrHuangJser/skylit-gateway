# Clerk FAPI proxy：配置入口、授权边界与 Skylit 适用性

研究日期：2026-10-24（Asia/Shanghai）。用途：供 Lead 决策、实现和实测；本研究不实现代理、不启动服务、不发出线上认证或私有请求。只查 Clerk 官方文档、官方 SDK 和已保存的公开浏览器包；未读取 `.local`、account-info 或凭证内容。

## 1. 结论先行

**不能把 `proxyUrl`、`window.__clerk_proxy_url` 或 `data-clerk-proxy-url` 当作第三方 Clerk 生产实例的 origin 授权开关。** 它们配置浏览器去哪里请求，不替代实例端配置。官方 FAPI proxy 流程要求：

1. 代理与应用在同一 domain；完整转发请求 body 和 headers。
2. 代理向 Clerk 附加 `Clerk-Proxy-Url`、**该实例的 `Clerk-Secret-Key`**、真实终端用户 IP 的 `X-Forwarded-For`。
3. **生产实例必须在 Clerk Dashboard 或 Backend API 设置实例 domain 的 `proxy_url`。** 开发实例免去的是该 domain 设置，不是官方文档中的 secret/header 要求。

以上均来自 [官方 FAPI proxy 指南](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi) 的 Requirements / Enable proxying。

因此，在没有 Skylit 站点/Clerk 实例管理者授权、没有实例 secret、且不改变第三方生产实例设置的前提下，**没有找到官方支持的“仅修改本地代理页面即可让原站 ClerkJS 在本地 origin 完整运行”的方案**。自有终端用户账号不等于拥有 Clerk 应用实例。应明确向站点拥有者申请支持，不能将 SDK 的路由能力表述为获准接入任意域。

这不证明所有自定义中转架构在技术上绝不可能；它只限定：**不能依靠本次研究到的官方 Clerk proxy 配置宣称此部署受到支持**。普通短期 JWT 传递是另一条应用集成问题，不能自动解除 Clerk FAPI 的 origin/client 认证要求。

## 2. 准确的浏览器配置入口

### 2.1 npm / 直接实例化：构造函数第二个参数

[官方 SDK `packages/clerk-js/src/core/clerk.ts`](https://github.com/clerk/javascript/blob/main/packages/clerk-js/src/core/clerk.ts) 的精确符号：

- `public constructor(key: string, options?: DomainOrProxyUrl)`。
- 构造时执行 `this.#domain = options?.domain`、`this.#proxyUrl = options?.proxyUrl`。
- 随后 `createFapiClient({... proxyUrl: this.proxyUrl })`，即创建 FAPI client 时已读取 proxy 配置。

因此直接实例化的入口是构造函数选项 `proxyUrl`，**不是假定在 `Clerk.load({ proxyUrl: ... })` 中补一个字段就能重新配置现有实例**。[Clerk 类文档](https://clerk.com/docs/js-frontend/reference/objects/clerk) 把 `proxyUrl` 列为实例属性，而 `load()` 的 `ClerkOptions` 是另一组选项。SDK 构造路径比文档的简短属性描述更明确。

值可以为 `/__clerk` 一类相对路径或完整 URL；[类文档](https://clerk.com/docs/js-frontend/reference/objects/clerk) 明确给出这两种形式。[官方 `packages/shared/src/proxy.ts`](https://github.com/clerk/javascript/blob/main/packages/shared/src/proxy.ts) 的 `proxyUrlToAbsoluteURL()` 使用 `new URL(url, window.location.origin)` 解析相对路径，`isValidProxyUrl()` 接受 HTTP(S) 或以 `/` 开头的值。**语法检查通过不代表 Clerk 服务端授权通过，也不代表生产 HTTP loopback 获得支持。**

### 2.2 CDN script 自动启动：data 属性优先，global 次之

与本地浏览器包版本对应的 [官方 `@clerk/clerk-js@5.128.0`：`packages/clerk-js/src/index.browser.ts`](https://github.com/clerk/javascript/blob/%40clerk%2Fclerk-js%405.128.0/packages/clerk-js/src/index.browser.ts) 给出完整且很短的证据链：

> `document.querySelector('script[data-clerk-proxy-url]')?.getAttribute('data-clerk-proxy-url') || window.__clerk_proxy_url || ''`
>
> `if (!window.Clerk) { window.Clerk = new Clerk(publishableKey, { proxyUrl, ... }); }`

含义：

- 属性必须在 `script` 元素上；不是在任意 HTML 元素上设置，也不是 URL query 参数。
- 选择器返回第一个匹配 script；非空 `data-clerk-proxy-url` 优先于 `window.__clerk_proxy_url`。
- 两者必须在该启动代码执行前准备好；它们是构造参数来源，不是监听式运行时配置。
- 已有 `window.Clerk` 时不会重建实例；事后改 global/属性不能据此声称会改变已创建 FAPI client 的目标。
- 同样的入口在 [当前 main 的 `index.browser.ts`](https://github.com/clerk/javascript/blob/main/packages/clerk-js/src/index.browser.ts) 仍存在。

本地公开包 [clerk.browser.js](../../api-recon/assets/clerk.browser.js#L19) 第 19 行的 chunk 文件名包含 `_5.128.0.js`，因此这里优先引用相同版本官方 tag 的启动源码，而非把当前 main 的全部行为倒推给历史包。本地包高度压缩，行号粒度差；没有对本地包做格式化/修改。

### 2.3 React / 框架封装

[官方 FAPI proxy 指南](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi) 的 Configure your proxy setup 明确支持 `<ClerkProvider>` 的 `proxyUrl` 属性，或框架环境变量（例如 `NEXT_PUBLIC_CLERK_PROXY_URL`）。服务端 SDK 的 `proxyUrl` / `CLERK_PROXY_URL` 与浏览器路由配置需要匹配；不是浏览器自动读取任意 `.env`。

[官方 `packages/shared/src/loadClerkJsScript.ts`](https://github.com/clerk/javascript/blob/main/packages/shared/src/loadClerkJsScript.ts) 提供精确桥接证据：

- `buildClerkJSScriptAttributes(options)` 将 `options.proxyUrl` 写成 `data-clerk-proxy-url`。
- `clerkJSScriptUrl()` / `buildScriptHost()` 也使用 proxy 配置构造 ClerkJS bundle URL；相对 proxy 会生成代理路径下的 `/npm/@clerk/clerk-js@.../dist/clerk.browser.js`。

所以 proxy 配置可能同时影响 FAPI 请求和 SDK 资源加载，不能只考虑 `/v1/client` 一个请求。此处加载器证据来自 main；不承诺所有历史框架版本拥有完全相同的 URL 拼接实现。

## 3. 真正需要实例管理权限的部分

[官方指南](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi) 原文：

> “For a production instance, you need to set a proxy URL for your Clerk instance's domain. This can be done through the Clerk Dashboard or through the Backend API.”
>
> “The domain proxy_url setting is only applicable to production instances. Development instances support Frontend API proxying without this setting...”

Dashboard 路径为 Domains → Frontend API → Set proxy configuration；URL 必须有效并可解析。启用前需要先把代理按要求配置好，避免停机。管理者应评估对现有生产域的影响，不能由最终用户在第三方实例上自行改变。

**secret 的作用与用户 JWT 不同。** Requirements 明确指定 `Clerk-Secret-Key: Your Clerk Secret Key`。正常终端用户短期 JWT、Publishable Key、账号密码、登录 Cookie 均不能被当作这个实例管理 secret 使用。secret 应仅由获授权服务端持有，不进入公司浏览器；本研究没有读取、获取或验证任何 secret。

Satellite 也不是免授权替代：同一指南要求先在 Dashboard 添加 satellite，配置 primary 的 `allowedRedirectOrigins`，再设置 satellite 的 proxy URL，并附同样三个 headers。代理 satellite 时使用 `proxyUrl / CLERK_PROXY_URL` 替代 `domain / CLERK_DOMAIN`，不应两者同时设置。[来源同上，Proxying for satellite domains](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi)。

## 4. FAPI proxy 请求要求与限制

依据 [官方 Requirements](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi)：

| 项目 | 官方要求 / 不能误读之处 |
| --- | --- |
| 目标及路径 | 应用 `https://app.dev/__clerk/*` → 实例 FAPI `https://frontend-api.clerk.dev/*`；保留后续路径、body 和 headers。示例域仅为官方占位符，实际目标应属于对应实例。 |
| `Clerk-Proxy-Url` | 完整的 proxy base URL，而非只给 pathname，也不是把本地 origin 换成原站 origin 的授权捷径。 |
| `Clerk-Secret-Key` | 实例 secret；由获授权中转服务端设置。 |
| `X-Forwarded-For` | 第一个（最左）值必须是真实最终用户 IP，Clerk 将它用于安全与限流。若前置 CDN，要从受信 CDN 自己设置的真实 IP header 获取，不能盲信客户端可注入的左侧 XFF；不能把 CDN IP 当用户 IP。 |
| 同域 | 官方明确 “Your proxy server must be on the same domain as your application.” 路径应唯一、不与应用已有路由冲突。 |
| DNS/CNAME | 若已使用部署所需 CNAME 子域，代理 FAPI 必须选不同子域。官方推荐 CNAME，proxy 标为 advanced usage，支持团队不保证能解决所有此类问题。 |

[官方 FAPI client 源码 `packages/clerk-js/src/core/fapiClient.ts`](https://github.com/clerk/javascript/blob/main/packages/clerk-js/src/core/fapiClient.ts) 的补充协议证据（main）：

- `buildUrl()` 在 `options.proxyUrl` 下拼接 proxy path + 默认 `v1` + resource path。因此 base 设为 `/__clerk` 时，client resource 对应 `/__clerk/v1/client`，不应重复添加 `/v1`。
- `buildQueryString()` 添加 `__clerk_api_version`、`_clerk_js_version` 等；不要无意丢弃这些参数。
- 为兼容 Safari，非 GET/POST 的原始方法使用 `_method` query，实际 fetch 用 GET 或 POST；不可随意按 pathname 重新推断请求语义。
- 默认 `credentials: requestInit.credentials || 'include'`；非 GET、非 FormData 默认 `application/x-www-form-urlencoded`。`proxyUrl` 分支只改变 URL，不能据此推出“只靠短期 bearer JWT 就能替代 browser client 身份”。

**不要混淆另一份“应用本身在反向代理后”的指南。** [Deploy a Clerk app behind a proxy](https://clerk.com/docs/guides/development/deployment/behind-a-proxy) 开头明确说浏览器仍直接请求 Clerk FAPI，和 FAPI proxy 不同。该指南要求 `X-Forwarded-Host` / `X-Forwarded-Proto`（生产 https）；它们不能替代上表 FAPI proxy 的三个 headers。

## 5. 对已有 origin_invalid 与短期 JWT 条件的解释

输入事实（用户已实测，本研究未重测）：直接 GET `https://clerk.skylit.ai/v1/client`，`Origin=http://127.0.0.1:48175` 返回 400 `origin_invalid`，`Origin=https://app.skylit.ai` 返回 200。

可得出的有限结论：

- 这与本地 origin 不被该实例当前策略接受一致；说明“公司浏览器直连原 FAPI”已有明确障碍。
- 官方 proxy 使用实例 secret + domain proxy 设置，不是靠一个前端字段关闭这项检查。仅改浏览器目标到 localhost 不提供上述授权。
- **不能由 200 推导该请求建立了有效登录态，更不能由该差异单独证明 HTML 黑屏只有这一个原因。** 没有分析私有响应、应用自身 JWT 校验、其他启动资源或 CSP。
- [Clerk 类文档 `setActive()` / navigate 说明](https://clerk.com/docs/js-frontend/reference/objects/clerk) 明确：“Clerk relies on the `__client` cookie to authenticate requests to Clerk's Frontend API”。这与应用向业务 API 携带短期 session JWT 是不同职责。允许公司浏览器持短期 JWT，不等于原版 ClerkJS 的 client/session 初始化与续期已解决。

## 6. 给 Lead 的决策边界与未决事项

1. 若希望走 **官方 FAPI proxy**：先确认 Skylit 实例拥有者授权、管理权限、secret 管理及生产 domain.proxy_url 配置；满足前不要把它作为可立即落地的修复。
2. 若坚持“不改第三方实例配置、长期 Cookie 仅中转保留”：本研究没有发现受官方支持的原版 ClerkJS 任意 localhost origin 全功能接入。Lead 应另行评估业务集成边界或与站点协商，不把伪造 origin、伪造客户端资源、跳过认证/MFA/权限校验称为官方方案。
3. 本研究未查询 Skylit 实例类型或后台配置。生产要求采用条件表达；公开 FAPI 自定义域及输入现象不能替代实例管理证据。即使是开发实例，官方只豁免 domain.proxy_url，仍列出实例 secret 的代理要求。
4. 未证明 Clerk 生产 domain.proxy_url 接受 HTTP loopback、动态端口、并发多个个人代理域，或无需可达性验证。浏览器 SDK 接受 URL 的语法不等于这些部署形态获官方许可。
5. 官方开源 JS 展示客户端拼 URL 和 Cookie 使用，**不公开完整 Clerk 服务端 origin 校验实现**；不臆测 origin_invalid 的所有条件或内部 header 优先级。
6. 当前文档/main 可能随版本变化；已将最关键的 script 入口额外固定至本地公开包显示的 5.128.0 tag。raw GitHub fetch 和一个猜测 Backend API 文档路径未能取回，未用它们支撑任何事实；没有为补齐内容请求任何真实认证端点。

所有后续实现、线上联调、JWT 刷新及浏览器实测由 Lead 负责；本文只提供官方证据与授权限制。
