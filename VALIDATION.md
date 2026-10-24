# WSLC 本机可行性验证报告

## 结论

**中转端合法会话 → Rust → 无 Skylit 登录状态的公司端浏览器 → 受保护接口/小范围历史数据，这条链路已实测跑通。原版 Skylit 网页完整代理仍未跑通。**

这份报告完成的是本机最小原型的可行性验证，不是生产交付或整站功能验收。结果时间均使用对应 JSON 中的 UTC 时间戳，避免把历史观测当作当前实时状态。

## 1. 环境与构建证据

- Windows；WSLC 3.0.3.0、WSL kernel 6.18.54.1-1；Chrome 156.0.8078.47。
- 用户要求改用 `wslc` 后，所有镜像构建/启动均使用该 CLI，不依赖 Docker CLI/Desktop。
- [构建描述](Dockerfile)：Rust 1.91.1 Bookworm 构建，Debian Bookworm slim + CA 证书运行，UID/GID 10001 非 root。
- [依赖锁](Cargo.lock)已保存；最终构建执行 `cargo test --locked && cargo build --release --locked`，**17 passed、0 failed，release 编译成功**。
- 最终镜像标签：`skylit-gateway:probe-v2`，约 90 MB。
- 最终镜像 ID：`sha256:967dcf55723f5cd8634dd093ad1970d145935228e74daeb46c512667e9e41862`。
- 数据链路测试使用 `chart-probe` 镜像 `sha256:2548f37b10384ba216d0d31d9c50171005f8b32dacac078eac51dfa47898f5c0`；后续仅修正启动日志对阶段的描述，最终镜像重新运行了全部 17 个测试，并通过真实浏览器的过期快照验收。
- [构建上下文白名单](.dockerignore)只允许 manifest、锁文件、Rust 源码与构建描述；未包含个人配置、短期凭证、浏览器配置或验证驱动依赖。
- 基础镜像没有按 digest 固定，apt 包也没有冻结快照；锁定依赖不代表跨时间整镜像逐字节可复现。

构建示例：

```text
wslc build --progress plain -t skylit-gateway:probe-v2 ./skylit-gateway
```

### 已排查的环境差异

- 初始 `rust:stable-bookworm` 标签不存在，已改为实际可用的固定版本。
- Git Bash 会自动改写传给 Windows CLI 的 Linux 路径；涉及容器路径的命令使用 `MSYS_NO_PATHCONV=1` 后只读挂载成功。不是权限绕过或切换容器引擎。
- WSLC 不支持 `type=local` 目录 exporter；改用受支持的 tar exporter，检查并提取唯一的生成锁文件，再纳入源码构建。
- 当前目录不是 Git 仓库，不能提供 Git diff 检查结论；采用读取修改内容、构建、单元测试与浏览器实测验证。

## 2. 基础代理与本地授权：9 项通过

[脱敏结果](validation/results/transport-only.json)，测试时间 `2026-10-23T17:26:39.512Z`。

1. 健康接口不假报上游已登录。
2. 干净浏览器只能看到本地访问入口，不自动获得上游 Cookie。
3. 错误访问码拒绝。
4. 跨站登录拒绝。
5. 通过真实页面表单输入本地访问码，获得 HttpOnly、SameSite=Strict 的代理会话。
6. 第二个干净上下文不继承第一个设备的访问权限。
7. 当前原型拒绝上游写操作。
8. Rust 可取得原站公开 HTML。
9. 本地退出只撤销当前代理会话，不退出 Skylit。

公开 HTML 的上游鉴权状态仍为 signed-out。禁止公司端直连上游后，Clerk 等资源被阻止，页面可见文本为 0。[该次截图](validation/results/transport-only.png)是空白深色页面，**不是完整应用成功截图**。

## 3. 专用合法会话的独立 HTTP 对照

[脱敏结果](validation/results/session-probe.json)，时间 `2026-10-23T17:26:39.372Z`。

用户在独立专用浏览器中正常登录；正常关闭后，以同一专用配置启动无头浏览器，仍可恢复登录。不读取日常浏览器凭证库或原有账号配置文件。

仅对账户访问元数据 `/api/access` 做三组独立 Cookie 容器对照：

| 上游请求上下文 | HTTP | 身份是否与专用正常登录用户一致 |
| --- | --- | --- |
| 无授权 | 401 | 否 |
| 合法会话 Bearer，不带浏览器 Cookie | 200 | 是 |
| 同 Bearer 加对应专用浏览器 Cookie | 200 | 是 |

报告只保存身份是否一致的布尔值，不包含身份、JWT、Cookie 或响应正文。这证明该接口在本次环境支持这一授权方式，不推广成全部上游接口的通用保证。

## 4. 会话已接入 Rust：5 项通过

[公司端浏览器结果](validation/results/session-gateway.json)，时间 `2026-10-23T17:32:18.740Z`。

中转端的专用无头浏览器按正常 Clerk SDK 流程取得短期 token，经私密运行时快照、只读目录挂载传给 Rust。长期浏览器会话不挂给 Rust，也不发给公司端。

1. 即使中转端会话有效，未获代理授权的公司设备仍是 401。
2. 公司端只通过本地网关表单登录，浏览器中只有本地域名的代理会话 Cookie。
3. capabilities 明确 `fullWebsiteReady=false`，不把有限能力说成整站完成。
4. 公司端页面内部 `fetch('/api/access')` 经 Rust 返回 200、账号 application 权益有效；公司端没有上游 Cookie/JWT。
5. 第二设备需独立通过本地授权，使用同一个合法上游账号；第二设备退出不影响第一设备继续读取。

### 续期证据的范围

[起始有效期元数据](validation/results/session-window.json)记录了首个 token 的 advertised expiry。上述公司端请求发生于该到期点之后，仍获得 200；Rust 对过期快照会拒绝，因此本轮确有后续有效快照被读取。

该结果支持“正常 SDK 更新 → 快照替换 → Rust 使用新凭证”的链路在本轮有效，**不证明永久保活、上游人工撤销恢复、MFA 自动恢复或所有未来令牌期限**。本地没有验证 JWT 签名；固定上游负责认证，文件只是受信任的运行时配置。

## 5. 真实图表历史数据链路：通过

[脱敏图表结果](validation/results/chart-probe.json)，时间 `2026-10-23T17:35:51.201Z`。

公司端使用全新无头浏览器上下文，只持有本地代理会话，禁止直连上游 HTTP 与 WebSocket，Service Worker 禁用以减少隐藏路径。

| 请求 | 实测结果 |
| --- | --- |
| `/tv/search?query=SPY&limit=1` | 200 JSON，1 个结果 |
| SPY 固定五分钟历史窗 | 200 JSON，`s=ok`，5 条原始点 |
| 相同历史请求去掉 symbol | 400，非 JSON 原始错误类型保留 |

历史检查验证 t/o/h/l/c 长度匹配、OHLC 为有限数、时间戳在目标窗内；不保存价格数组或原始数据。没有调用正式计费数据 API、交易、签协议、创建 API key 或账号写操作。正常浏览器访问仍可能触发网站自身后台读取与遥测。

**这是有界历史读取成功，不是原版图表交互、实时行情、SSE 或 WebSocket 成功。**

## 6. 原版页面：未通过，已有明确证据

同一公司端测试访问原版 Atlas 页面时，代理返回 502；[截图](validation/results/atlas-proxy.png)实际内容是 `External or invalid upstream redirect blocked`。这是当前安全重定向策略下的错误页，不能因为存在可见文字就判定渲染成功。脚本已修正这一判定错误并重新运行，结果明确 `originalAtlasRendered=false`。

[额外页面授权诊断](validation/results/page-auth-diagnostic.json)在独立 HTTP 请求中观察到：匿名 Atlas 页面为 404/signed-out，同一正常会话 Bearer 请求为 200。不同请求路径和头会产生不同响应；这不能反推浏览器代理那次具体上游跳转的目标或原因。

合法 Bearer 页面正文中未找到本次 bearer 字符串，但只检查了这个字符串，**不是所有敏感状态完整审计通过**。

当前只对四个精确接口路径附加上游凭证，不给所有 HTML/JS 自动附加凭证。尚未完成页面/RSC 授权、Clerk 初始化、资源域名映射、Cookie 与 CSP/Service Worker 适配，故不能使用“加一个 Bearer 就整站完成”的说法。

## 7. 辅助模块停止/快照过期：4 项通过

[过期安全验收结果](validation/results/fail-closed.json)，最终镜像测试时间 `2026-10-23T17:56:35.511Z`。

执行前检查本机已无专用会话辅助进程，也无其专用 Chrome 进程；快照已自然过期，未通过伪造正常 token 强行造成功例。

- 已获代理授权的设备读取 `/api/access` → **503**。
- 同设备读取 `/tv/history` → **503**。
- 响应只有通用 `Upstream session unavailable`，不泄漏路径/凭证，不降级匿名。
- 未获代理授权的新设备仍是 **401**。
- 健康接口仍不声称上游已登录。

最后清除了已过期的短期凭证，保留专用浏览器配置供用户后续自行使用；它仍属敏感本机状态，不可公开。已停止本轮创建的所有网关测试容器、释放测试端口，未操作其它已有工作负载。构建镜像和脱敏结果保留。

## 8. 能力边界与后续工作

### 本轮已经证明

- WSLC 能在当前 Windows 设备构建、启动 Rust 最小代理镜像。
- 公司设备无需 Skylit 登录，可用网关自己的授权访问部分受保护上游接口与小范围历史数据。
- 上游短期凭证留在中转端；两个公司端本地会话可以独立授权/退出。
- 正常更新链路与过期 fail-closed 行为都有实际观测。

### 尚未证明或交付

- 原版网站整体可用、实时图表、SSE ticket/edge Cookie、WebSocket。
- 多用户共享合规性、上游并发限额、完整数据隔离；本轮只有本人多设备、云端数据共享的范围。
- 单镜像一键部署全部登录辅助；目前需要 Windows 主机 Node/Chrome 专用会话辅助模块。
- 生产 HTTPS、限流、密钥轮换、审计、长期稳定性与上游更新兼容性。

下一阶段如果继续保留原版网页，应先完成有限页面的授权与资源适配并制定回归测试，再扩展实时协议。不能把本轮可行性验证称为最终网站代理已交付。
