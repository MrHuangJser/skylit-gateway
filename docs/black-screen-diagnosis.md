# 本地原版首页黑屏：实测诊断与修复状态

## 最新状态

**已完成首页黑屏修复并切换到原 48175 地址。**[同地址验收汇总](../validation/results/black-screen/homepage-summary.json)与[当前项目说明](../README.md)为最新状态。原版导航和真实热图均已显示，未把诊断占位当成功；整站所有模块尚未验收。

以下保留故障阶段的复现、被否定的实验和当时的实施计划，不能把历史“未修复”描述当成当前运行状态。

用户截图中的地址是 `http://127.0.0.1:48175/`。本轮使用干净 Chrome，无日常浏览器 Cookie，通过代理自己的本地授权后访问同一首页。

## 可失败的反馈循环

```text
node skylit-gateway/validation/black-screen-repro.mjs
```

[页面测试](../validation/black-screen-repro.mjs)真正访问原版首页，等待可见正文，采集有界的浏览器错误/失败资源并截图，不把所有响应正文、Cookie、JWT 或完整查询 URL 写入日志。

两次原始模式均失败：HTTP 200，标题 `Skylit - Options Flow Analytics`，可见正文 0，`originalPageVisible=false`。Clerk JS 本身已经加载，随后 `https://clerk.skylit.ai/v1/client` 返回 400。

[脱敏失败记录](../validation/results/black-screen/repro.json) · [截图](../validation/results/black-screen/repro.png)。

测试中的可见性条件是最低黑屏回归信号，不是整站功能验收；即使将来变绿，仍须检查真实用户、权限、数据、导航与实时协议。

## 排名假设与结果

1. **原版登录 SDK 拒绝本地 Origin。已证实。**400 响应为 `origin_invalid`，原始请求 Origin 是 `http://127.0.0.1:48175`。
2. **HTML 缺少上游授权导致无 SSR 身份。单独修正不足。**隔离镜像只对精确 `/`、`/atlas` GET/HEAD 附加同一合法 Bearer；构建与 17 个测试通过，但浏览器仍是正文 0、Clerk origin_invalid。
3. **本地 JS/CSS 转发或 CSP 造成黑屏。未获主要证据。**页面列出 112 个本地 script，记录到的失败为 Clerk 400；未观察到对应本地 chunk 404/CSP 错误。不能据此保证所有其它资源和未来页面均正常。

## Origin 单变量对照

[对照脚本](../validation/clerk-origin-probe.mjs)不携带任何用户凭证，只改变匿名固定 URL 的 Origin：

| Origin | HTTP | 错误 |
| --- | --- | --- |
| 本地代理 origin | 400 | `origin_invalid` |
| `https://app.skylit.ai` | 200 | 无 |

[对照结果](../validation/results/black-screen/origin-controls.json)。这仅证明 origin 检查差异；匿名 200 不表示已登录，也不提供用户身份。

## 已执行并撤回的 HTML 授权实验

隔离镜像 `skylit-gateway:ssr-probe`，端口 48181；用户正在访问的 48175 服务未被替换。

```text
BLACKSCREEN_BASE=http://127.0.0.1:48181 BLACKSCREEN_VARIANT=ssr-bearer node skylit-gateway/validation/black-screen-repro.mjs
```

[实验结果](../validation/results/black-screen/ssr-bearer.json)仍为正文 0/400 origin_invalid。实验容器已停止，源码的凭证路径白名单已恢复原有四个受保护接口；没有保留无效的全站自动附凭证变更。测试保留了更完整的 GET/HEAD、HTML 路径边界与写操作拒绝覆盖。

## 不能直接采用的“修复”

[Clerk 官方代理研究](clerk-proxy-research.md)指出：[官方 FAPI proxy](https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi)需要站点实例 Secret Key，生产还需实例 domain.proxy_url 配置。用户拥有合法订阅账号，不等于拥有站点 Clerk 实例管理权限。

因此不把只注入 proxyUrl、修改浏览器 Origin、伪造 Clerk client 或跳过登录/会员/Terms gate 当作已支持方案。用户已允许正常短期 JWT 到公司浏览器，但这不自动解决原版 Clerk client 初始化。

## 后续适配方向（尚未验证）

[前端授权 seam 研究](frontend-auth-seam.md)没有找到现成的全局可插拔 auth adapter。原版 Terms/readiness、SignedIn/SignedOut、useUser/useSession 和 role provider 都依赖 Clerk，不能仅替换 getToken。

若继续保留原版页面，可评估显式的本地前端授权 Adapter，限制在已识别/版本固定的公开 bundle：

1. 通过本地网关会话、同源 POST，向 Rust 请求正常短期 JWT。Rust 先让固定上游 `/api/access` 验证 token 与账号 application 权益，不自签上游 JWT。
2. 用户、会话、publicMetadata、组织成员关系必须来自中转端正常 SDK 的真实数据；未知保持未知，不补造角色/会员状态。保留原版 Terms、entitlements 和服务端授权检查。
3. 在已确认的导出 seam 接入 Adapter，而不是开启 DEV_BYPASS 或把 has 统一设为 true。认证模块并不因存在一个 token 就可以无条件 ready。
4. bundle 必须做来源 hash/结构校验；上游版本变化则明确失败。旧抓包模块 id 不是稳定公共接口。
5. 短 JWT 仅内存持有，经受控通道更新，不存 localStorage，不写日志或任意 URL；长期 Cookie/密码仍只在中转端。
6. 继续用原版页面回归循环验收；加载中/错误提示或自制页面不能让“原版页面已修复”判定变绿。

此方向是高维护前端集成，不是已经完成的 Clerk 官方代理方案。当前仍不承诺首页或整站功能已恢复。
