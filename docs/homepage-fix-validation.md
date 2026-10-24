# 原版首页黑屏修复：最终验收

## 实际结果

已用 `wslc` 将 `skylit-gateway:homepage-fixed` 切换到用户原地址 `http://127.0.0.1:48175`，运行容器为 `skylit-gateway-live`。镜像 ID 为 `sha256:11a2b7241276d88636efcd2c24726d83dcda40ee19970b3c47b919a815e20fb0`。

同一地址的干净 Chrome 在禁止直连外网的条件下显示了**原版侧栏、导航、热图工具栏与真实 SPXW 热图**，不是自制替代页。原版页面可见、没有 Gateway 诊断占位，热图数据响应为 200、319 条 strike/矩阵行、有限 CurrentSpot，空数据提示消失。

- [最终机器汇总](../validation/results/black-screen/homepage-summary.json)。
- [带数据的同端口验收](../validation/results/black-screen/after-cutover.json)。
- [原始无参数地址验收](../validation/results/black-screen/bare-home-after-cutover.json)。
- [实际页面截图](../validation/results/black-screen/after-cutover.png)：仅本机留存，含账户水印/市场数据，请勿公开分享。

测试中公司浏览器没有 Clerk 长期 Cookie 或 CloudFront 签名 Cookie，没有观察到 localStorage JWT；正常短 JWT 在用户明确同意后仅经受控 bootstrap 到内存。Clerk origin_invalid 已不再阻断页面。通知 SSE 有正常 `text/event-stream` 200 的连接观测，但不推广为全部实时协议验收。

## 根因与实际改动

1. 原版 Clerk 初始化直接请求上游 FAPI，本地 Origin 返回 400 `origin_invalid`。只给 HTML 加 Bearer 的隔离实验仍黑屏，已撤回。
2. 没有站点实例 secret/域管理权限，故未伪造 Clerk 官方 proxy，也没通过改 Origin 冒充获支持的接入。
3. 在固定版本的两个公开 chunk 上，AST 只替换 16 个认证导出绑定，保留业务、Terms 和角色/权益 gate；以同一页面 React 接入真实网关授权 Adapter。
4. Rust 先用正常上游 token 向固定 `/api/access` 验证身份/应用权益，再把正常 SDK 的只读用户/会话投影与该身份绑定；未知状态不伪造成会员/组织权限。
5. 修复上游 Bearer 与本地访问码混淆；正常业务请求仍需自己的有效代理 Cookie，来客 Bearer 不作为本地身份，实际转发使用受信任快照。
6. 完成合法边缘授权；三个 CloudFront Cookie 只留 Rust 内存，绑定 owner/时效与精确 data 路径，发 data 前正常复核当前上游身份。
7. 兼容原站正常的空 SSE ticket POST，不再误判为 415；没有开放任意 POST/交易/支付。
8. 修正本地 Provider 在 hydration 首帧插入不同诊断节点导致的 React #418；未知身份仍未知，业务 gate 未被绕过。

## 时钟临界期故障与修复

切换后第一次验收出现 503，已保留[故障证据](../validation/results/black-screen/cutover-clock-boundary.json)，没有隐藏该失败。宿主前后读秒相同、现有容器读秒快 14 秒的对照确认了 VM 时钟差。

Rust 的严格期限检查保留，未修改系统时钟。辅助模块优先用正常 SDK 缓存；剩余有效期不足 45 秒时，最多再调用一次正常 `getToken({skipCache:true})`，不足则 fail closed，不延长旧 token 的 exp/iat、不自签、不无限重试。

[实际稳定性测试](../validation/results/black-screen/session-stability.json)跨越约 82 秒、5 个实际 advertised expiry，9 次受保护访问全部 200。此证据仅限本次窗口，不是永久保活保证；生产仍应同步 VM/主机时钟。

## 验证范围

- Rust 构建内 **38/38** 测试通过。
- 自有前端 Adapter、AST 补丁与正常续期策略 **43/43** Node 测试通过；VM 只执行自有代码，vendor JS 只解析。
- 公开 live chunk 与补丁原始 hash 一致；运行时继续核对 hash，未知版本明确失败。
- 原版首页先复现红测，再在实际地址变绿；[证据核验脚本](../validation/verify-homepage-evidence.mjs)不接受诊断占位、错误页或仅接口 200 作为成功。
- 失败的 HTML 授权实验、旧浏览器授权实验与候选容器均停止；保留用户的 48175 服务和专用正常会话辅助进程，未操作其它已有工作负载。

## 用户访问及未完成部分

建议先打开 <http://127.0.0.1:48175/?symbol=SPXW>。重启已清除旧代理会话，提示时输入原代理访问码；不需要登录 Skylit。无参数首页只表示未选择 ticker 时可能显示正常的空数据提示，不再是整页黑屏。

仍未完整验收其它页面、Atlas WebSocket、所有实时订阅和业务写操作。账户/组织修改、交易、支付、开发者 key 管理、部分遥测没有开放；相关请求可能仍为 401/403，不伪装成成功。辅助模块仍在 Windows 主机运行，本轮有 4 小时上限，不是单镜像常驻生产交付。

本轮完成的是**用户报告的原版首页黑屏修复与同地址真实显示验收**，不是全部 Skylit 功能交付。
