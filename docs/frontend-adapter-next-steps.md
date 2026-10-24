# 黑屏修复：历史实施交接

> **后续实施已完成：首页与真实热图已在原 48175 地址验收。**当前进程为 `skylit-gateway-live`，不是下面历史记录中的旧 manual 服务。请以[当前项目说明](../README.md)和[首页验收结果](../validation/results/black-screen/homepage-summary.json)为准；下面内容仅保留阶段性的研究/计划，不应重复创建实验或把历史未完成描述当作当前状态。

## 当时的状态与约束

- 用户已选择允许公司浏览器接收**正常签发的短期 JWT**；密码和长期 Cookie 仍只留中转端。
- 48175 的 `skylit-gateway-manual` 仍为旧验证版，原版首页仍黑屏，**不要声称用户刷新已可用**。
- 当前辅助进程为 4 小时的 session-exporter，独占专用浏览器配置，不要同时启动其它使用同一 profile 的脚本。
- 官方 Clerk FAPI proxy 需要站点实例 secret/生产配置；不伪造它，不通过改 Origin 冒充官方支持。
- HTML Bearer 实验（48181）未修复黑屏，已停容器、恢复四个原授权路径。
- 新的 Rust browser bootstrap 默认关闭；它验证真实上游 `/api/access` 后才返回真实 id/正常短 token，**不是完整 Clerk User/Session 模型**。

## 已完成的前端导出调查

[AST 导出调查](../validation/auth-module-survey.mjs)与[结果](../validation/results/black-screen/auth-export-survey.json)只解析公开资产，不执行第三方 JS。

需要注意 Turbopack 的导出数组不是统一的二元对：既有 `[name, getter, ...]`，也有 `[name, 0, directValue, ...]`，必须按真实编码遍历。首次调查误按二元对扫描的输出已修正，不能把 literal 0 当作 getter。

保存的公开 chunk 与现场页面同名，但任何补丁部署前仍应验证 hash/结构，不只信文件名或旧 module id。

### 两个主要 chunk 的候选导出 seam

[3saht1vl84b4q.js](<api-recon/assets/3saht1vl84b4q.js>)：

- Module 965389：useAuth（direct `K`）、useSignIn、useSignUp。
- Module 265829：SignedIn、SignedOut、ClerkLoaded、ClerkLoading。
- Module 733917：UserButton。
- Module 192448：ClerkProvider、SignInButton、SignOutButton。
- Module 338703 的 useAuth getter 仍走 usePromisifiedAuth → 965389，理论上可复用已改的下层导出；**尚未实测**。

[0rvuravpijnzz.js](<api-recon/assets/0rvuravpijnzz.js>)：

- Module 827085：useClerk、useUser、useSession、useOrganization、useOrganizationList。

[1g_v7ow8b__pg.js](<api-recon/assets/1g_v7ow8b__pg.js>)的 SignedIn/SignedOut 是 SDK gate 的别名。候选思路是改已识别的 SDK 边缘导出引用，而非修改每一处应用消费者或删除 Terms/readiness gate。这样依然是自定义 Gateway auth Adapter，不是原版 Clerk 官方 proxy；还未证明只改这些导出就足够。

公开源码显示 React 模块 271645 的 `.default` 被 usePromisifiedAuth 用于 createContext。若 Adapter 需要 useSyncExternalStore，必须使用页面同一 React 实例并运行验证；不能打包第二份 React 或凭空假设 window.React 存在。

## 下一阶段建议实施顺序

1. 完成当前 browser bootstrap 的端到端回归。浏览器带短上游 Bearer + 有效代理 Cookie 时，旧 gateway.authorized 会把它误判成错误入口访问码而 401。已写实际浏览器红测与 unit 红测，修正仅在 `ENABLE_BROWSER_AUTH_ADAPTER=true` 时允许继续验证**自己的 Cookie**；来客 Bearer 仍不作为本地身份，并被 proxy 过滤/替换为中转端快照。
2. 扩充明确来源的真实 user/session profile：从中转端正常 Clerk SDK 精确选择字段，独立私密快照；Rust 必须核对其 user id 与真实 `/api/access` 一致。不要填假姓名、角色、组织 membership 或冒充完整 Clerk UserResource。
3. 用户信息、publicMetadata、组织成员关系、session actor/status 必须来自正常 SDK，未知不当作 false 或高级会员。真实 Terms 与 entitlements 请求必须继续走合法后端；不要利用原版错误分支的 fail-open。
4. 建立本地前端 Adapter 的 loading/authenticated/error 状态与 token single-flight 更新。短 token 仅内存持有，不存 localStorage、不放 URL、不写日志。未验证身份/资料不完整时显示明确诊断，不得把这种诊断判为“原版站点已修复”。
5. 先对原始 public JS 做 AST 定点导出绑定替换，保留其余实现；对输入和输出均做语法校验、路径+hash 清单、版本未知 fail closed。不要对全部 JS 盲目字符串替换。
6. 可由 HTML 最早注入的本地 runtime 提供 Adapter，并在已确认的导出上绑定同一 React；移除/停用不再使用的原版 Clerk CDN 初始化。需要有界 HTML/JS 转换，Content-Encoding/ETag/SRI/缓存及 RSC/SSR 状态都必须验证，不能无条件相信可行。
7. 用原版首页可见性反馈循环测试，诊断页/占位文字不能让它变绿。成功后验证真实账号权益、条款、至少一条数据请求与导航，再更新用户正在访问的 48175。

## 当前测试入口

- [原版黑屏回归](../validation/black-screen-repro.mjs)：默认 48175；可用 BLACKSCREEN_BASE / BLACKSCREEN_VARIANT 在隔离端口测试，不覆盖原模式证据。
- [短期浏览器授权回归](../validation/browser-bootstrap-probe.mjs)：默认 48183；只输出状态/布尔值，token 留浏览器函数内，不回传日志。
- 源码默认 feature 关闭，当前本地服务不自动启用新 token 输出。仅隔离容器在开启开关时使用它。

## 最新已完成的后端准备（2026-10-23T18:40:48Z 实测）

- 新增受控 POST `/_gateway/auth/bootstrap`，默认关闭，开启后先验证本地代理身份/同源/JSON，再以真实短 JWT 向固定上游 `/api/access` 验证账号。
- 真实浏览器得到 200、真实 id 与正常未过期短 JWT；token 不回传日志，不存 localStorage，不下发长期 Cookie。
- 初次浏览器回归发现同一请求带上游 Bearer+本地 Cookie 被错误当成入口访问码而401；已先看到新增 unit 红测（22 passed/1 failed），再在 opt-in 分支修正。现在来客 Bearer 不提供本地身份，仍须有效本地 Cookie，且上游请求仍以中转端快照覆盖它。
- 隔离镜像 `skylit-gateway:browser-auth-probe-fixed` 构建成功，**23 个 Rust 测试通过**；隔离端口 48185 的[真实浏览器回归](../validation/results/black-screen/browser-bootstrap.json)显示 bootstrap 200、携带短 JWT 的业务请求200，`originalWebsiteVerified=false`。
- 已停止失败的 48183 实验，48185 保留供后续 Adapter 集成；用户的 48175 服务未被替换，原版首页最新回归仍为正文0/origin_invalid400。
- 还没有实现真实完整 user/session profile 快照、前端 runtime、定点导出替换、HTML/JS 转换；这些是下一步，不要误以为已存在这些文件。

本文件是实施交接，不是“原版网页已恢复”的证明。最终以真实页面回归与数据请求为准。
