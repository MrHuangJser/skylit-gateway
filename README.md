# Skylit Gateway — 公司设备免访问码版

[![CI](https://github.com/MrHuangJser/skylit-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/MrHuangJser/skylit-gateway/actions/workflows/ci.yml)
[![Docker publish](https://github.com/MrHuangJser/skylit-gateway/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/MrHuangJser/skylit-gateway/actions/workflows/docker-publish.yml)

> **公司设备无需访问码；布局/画线等按设备隔离并只存在代理本地；左下角账户区已隐藏，账户/设置页面与接口被拒绝。**
>
> 接口依据见[设备状态接口清单](docs/device-state-endpoints.md)。浏览器回归脚本在 [`validation/`](validation/)；其运行结果（截图、JSON）可能含账户水印与市场数据，**只保留在本机 `validation/results/`，不提交到仓库**。

## 部署到 VPS（当前运行方式）

`deploy/` 里是生产编排：Rust 网关 + 一个**会话 sidecar**。sidecar 用你提供到 `.env` 的邮箱密码，在持久化的无头 Chromium 里完成 Skylit 登录；登录状态存在卷里，重启后不必再登录。网关只读取 sidecar 导出的**短期令牌快照**，公司设备永远拿不到密码、Cookie 或令牌。

端口 23881 对外提供服务，HTTPS 由主机自身终止。

```bash
# 1) 代码
git clone https://github.com/MrHuangJser/skylit-gateway.git ~/skylit-gateway-deploy/repo
cd ~/skylit-gateway-deploy/repo

# 2) 密钥与地址（不要提交）
cp deploy/.env.example ~/skylit-gateway-deploy/.env   # 填入 PUBLIC_ORIGIN / GATEWAY_ACCESS_TOKEN / SKYLIT_ACCOUNT / SKYLIT_PASSWORD
chmod 600 ~/skylit-gateway-deploy/.env

# 3) 状态目录：容器以 uid 10001 运行，目录必须归它所有
mkdir -p ~/skylit-gateway-deploy/data/{session,browser-state,device-state}
sudo chown -R 10001:10001 ~/skylit-gateway-deploy/data
# 并在 .env 里用绝对路径指向它们（相对路径会按 compose 文件所在目录解析）
#   SESSION_DIR=/home/<user>/skylit-gateway-deploy/data/session
#   BROWSER_STATE_DIR=/home/<user>/skylit-gateway-deploy/data/browser-state
#   DEVICE_STATE_DIR=/home/<user>/skylit-gateway-deploy/data/device-state

# 4) 构建并启动
cd deploy
docker compose -p skylit --env-file ~/skylit-gateway-deploy/.env build
docker compose -p skylit --env-file ~/skylit-gateway-deploy/.env up -d
```

`.env` 必须包含（示例见 [`deploy/.env.example`](deploy/.env.example)）：

| 变量 | 说明 |
|---|---|
| `PUBLIC_ORIGIN` | 用户浏览器实际打开的地址，如 `https://skylit.example.com`；Host/Origin 校验以此为准 |
| `GATEWAY_ACCESS_TOKEN` | 43 位以上随机串（`openssl rand -hex 32`） |
| `SKYLIT_ACCOUNT` / `SKYLIT_PASSWORD` | sidecar 自动登录用 |
| `SESSION_DIR` / `BROWSER_STATE_DIR` / `DEVICE_STATE_DIR` | 三个状态目录的**绝对路径** |

**运行状态自查**：

```bash
docker ps --filter name=skylit                                  # 两个容器都应 Up
docker logs --tail 20 skylit-session-sidecar-1                  # 应出现 "Gateway session snapshot ready"
curl -s -H "Host: $DOMAIN" http://127.0.0.1:23881/ -o /dev/null -w '%{http_code}\n'   # 200
```

若把 `PUBLIC_ORIGIN` 换成别的域名，重新 `up -d` 即可；Host 不匹配时网关会返回 421（防 DNS 重绑定），这是预期行为。

> **安全**：23881 一旦对外开放，任何能访问该地址的人都会以你的 Skylit 账号身份使用它。请只在受控网络或域名之后暴露端口。sidecar 的密码只存在 VPS 的 `.env`（权限 600），不会进入镜像或仓库。

## Docker 镜像（可选）

每次推送到 `main`/`master` 或打 `v*.*.*` 标签，GitHub Actions 会构建并发布多架构镜像（`linux/amd64`、`linux/arm64`）到 GHCR。

本机使用 **wslc**（不需要 Docker Desktop）拉取并运行：

```powershell
wslc pull ghcr.io/mrhuangjser/skylit-gateway:latest
# 若把包改为私有：先 wslc login ghcr.io（用户名 + 具有 read:packages 权限的 GitHub Token）

$root = (Get-Location).Path
wslc run -d --name skylit-gateway-live -p 127.0.0.1:48175:8080 `
  --env-file ./.local/gateway.env `
  -e PUBLIC_ORIGIN=http://127.0.0.1:48175 `
  -e UPSTREAM_SESSION_FILE=/run/skylit-session/snapshot.json `
  -e ENABLE_BROWSER_AUTH_ADAPTER=true -e ENABLE_FRONTEND_AUTH_REWRITE=true `
  -e ENABLE_OPEN_DEVICE_ACCESS=true -e DEVICE_STATE_DIR=/var/lib/skylit-device-state `
  --mount "type=bind,source=$root/.local/session,target=/run/skylit-session,readonly" `
  --mount "type=bind,source=$root/.local/device-state,target=/var/lib/skylit-device-state" `
  ghcr.io/mrhuangjser/skylit-gateway:latest
```

GitHub Actions 的 Linux 运行器上没有 wslc，所以 CI/发布流水线里用的是 Docker Buildx；本机构建、运行一律用 wslc。

| 触发 | 标签 |
|---|---|
| 推送到默认分支 | `latest`、分支名、`sha-<短哈希>` |
| 推送标签 `v1.2.3` | `1.2.3`、`1.2`、`1`、`sha-<短哈希>` |

镜像附带 SBOM 与构建来源证明（provenance attestation）。镜像内**不包含**任何账号、令牌、Cookie 或浏览器配置；运行时通过环境变量和挂载提供（见下文）。

> 当前 GHCR 包继承了公开仓库的可见性，**是公开的**，任何人都能匿名拉取镜像（镜像里不含账号、令牌或个人数据）。如不希望公开，到 GitHub → Packages → `skylit-gateway` → Package settings 改为 Private，之后本机先 `wslc login ghcr.io` 再拉取。

## CI

[`ci.yml`](.github/workflows/ci.yml) 在每次推送和 PR 时运行：

- **Rust**：`cargo build`、`cargo clippy -D warnings`、`cargo test`（工具链与 Dockerfile 一致，1.91.1）。
- **前端 Adapter（Node）**：`npm test`，覆盖认证适配脚本、AST 补丁与会话续期策略。原版 Skylit 前端代码属于第三方，**不提交**，所以 CI 里会跳过“按原始文件逐字节重放补丁”这一项；本地设置 `SKYLIT_ASSET_ARCHIVE=<原始 chunk 目录>` 即可完整运行。
- **Docker**：只构建不发布，确保 Dockerfile（含镜像内 `cargo test`）能通过。

## 本机访问

- 首页：<http://127.0.0.1:48175/>（直接打开，不再需要访问码）
- 直接选择 SPXW 热图：<http://127.0.0.1:48175/?symbol=SPXW>

首次访问时代理自动给该浏览器签发 HttpOnly 设备 Cookie（有效 365 天），它就是“设备身份”。**清除浏览器 Cookie 或换浏览器 = 新设备，原来的布局/画线不会跟过去。**

> **安全提醒：取消访问码后，任何能连上这个端口的人都会以你的 Skylit 账号身份使用它。**当前只绑定 `127.0.0.1`。要给公司其它电脑访问，需要把端口改为发布到局域网地址，并把 `PUBLIC_ORIGIN` 改成公司电脑实际使用的地址（代理会校验 Host/Origin，地址不一致会返回 421/403）。请只在你能控制的网络里这样做。

## 本轮新增（三项需求）

1. **免访问码**（`ENABLE_OPEN_DEVICE_ACCESS=true`）：无设备 Cookie 的浏览器自动获得设备身份，`/_gateway/login` 直接跳回首页。保留了防护：请求的 Host 必须等于 `PUBLIC_ORIGIN`（防 DNS 重绑定），写请求必须同源 Origin，上游仍固定为 `app.skylit.ai`。
2. **按设备隔离的用户状态**（`DEVICE_STATE_DIR`）：以下接口由代理本地处理、按设备分别保存，**不再发往 Skylit 服务器**：
   `/tv/layouts`（含保存/冲突/删除）、`/tv/drawings`、`/tv/presets`、`/tv/watchlist-order`、`/api/watchlists`、`/api/favorites`、`/siren/preferences`、Talon 偏好。每台设备一个 JSON 文件（原子写入、单设备上限 4 MiB），容器重启后仍在。返回结构严格匹配原版前端的校验，否则前端会报错。
3. **移除账户区并禁止访问**：在原版页面注入样式，隐藏左下角用户名/头像所在行、账户按钮与改用户名弹层；`/user-profile`、`/developer`、`/affiliate`、`/invite`、`/sign-in`、`/user` 及开发者 key、账单、支付、邀请、`/api/nexus/users/me` 等接口统一返回 403，不发上游。

## 首次切换注意

- 本版本**以前在 Skylit 服务器上保存的布局/画线/自选不会自动出现**：现在每台设备从空白开始，各存各的。这是按设备隔离的直接结果。
- 设备数据目录：`.local/device-state/`（每个设备一个 `<64位hex>.json`）。备份/迁移只需复制这个目录。

## 会话辅助进程

Windows 专用浏览器辅助进程有 4 小时运行上限，到期后页面会出现 503/无数据，需要重新运行（见下文“会话辅助模块与 WSLC 运行”）。常驻化/容器化该辅助模块尚未交付。

## 当前架构

```text
公司端干净浏览器
  └─ 本地代理访问码 / HttpOnly 网关会话
      └─ 原版界面 + 固定版本的前端授权 Adapter
          └─ Rust 固定 https://app.skylit.ai 转发
              ├─ 正常短 JWT、真实身份与权益验证
              └─ 合法边缘授权：签名 Cookie 仅留 Rust 内存

中转端专用 Chrome（用户正常登录）
  └─ Node/Playwright 读取正常 Clerk SDK 的 token 和选定资料
      └─ 私密运行时目录，只读挂载给 Rust
```

用户明确允许公司浏览器持有正常短期 JWT；它只在 Adapter 内存里，不写 localStorage、不写日志。长期 Clerk Cookie、密码及 CloudFront 签名 Cookie 不发给公司浏览器。正常 SDK 用户/会话资料被精确投影，并与上游 `/api/access` 真实身份绑定，不捏造会员、角色或组织。

这不是 Clerk 官方 FAPI proxy：站点实例 secret/域配置不属于最终用户账号。原版 JSX/业务代码和数据响应保留；只在两个已识别 public chunk 的 16 个认证导出绑定接入本地 Adapter。上游原始 hash 不符就明确失败，不盲改任意版本。[补丁清单](frontend/manifest.json) · [模块研究](docs/frontend-auth-seam.md) · [官方代理限制研究](docs/clerk-proxy-research.md)。

## 构建

在仓库根目录（本机用 wslc，不需要 Docker Desktop）：

```text
wslc build --progress plain -t skylit-gateway:local .
```

[Dockerfile](Dockerfile)只是 WSLC 可读的构建描述，不要求 Docker Desktop。使用 Rust 1.91.1 Bookworm、Debian slim + CA，非 root 运行；[Cargo.lock](Cargo.lock)固定依赖，构建执行全部 Rust 测试与 `cargo build --release --locked`。

[上下文白名单](.dockerignore)只纳入构建描述、锁、源码和公开前端补丁，不包含本地账号状态、快照、验证结果或浏览器驱动目录。镜像/apt 基础没有完全按 digest 冻结，不能声称跨时间逐字节可复现。

重新生成公开补丁或升级上游版本前，必须审查新 Module seam 并重新执行测试；不能只改 hash 让未知代码通过：

```text
node validation/generate-auth-patches.mjs
node validation/live-frontend-version.mjs
cd validation; npm ci; npm test
```

## 会话辅助模块与 WSLC 运行

需要 Windows Node、已安装 Chrome，以及验证目录的 Playwright 驱动依赖。首次需通过[专用登录脚本](validation/upstream-login.mjs)由用户正常登录一次并关闭窗口；不读取日常浏览器凭证库。不要同时启动多个脚本占用同一专用配置。

在 PowerShell 的仓库根目录启动辅助进程：

```powershell
$env:SESSION_HELPER_SECONDS='14400'
$env:EXPORT_BROWSER_AUTH_PROFILE='true'
$env:SESSION_MIN_REMAINING_SECONDS='45'
node validation/session-exporter.mjs
```

私密状态目录必须仅本人及 SYSTEM 等受信任身份可访问，不能仅依赖 gitignore 或 Windows 上的 `mode: 0600`。本轮已设置目录 ACL。不挂载整个浏览器配置给 Rust，只挂载短期快照子目录。

在另一个 PowerShell 中运行（已有同名服务时先确认，不要直接删除别人的容器）：

```powershell
$root = (Get-Location).Path
wslc run -d --name skylit-gateway-live -p 127.0.0.1:48175:8080 --env-file ./.local/gateway.env -e PUBLIC_ORIGIN=http://127.0.0.1:48175 -e UPSTREAM_SESSION_FILE=/run/skylit-session/snapshot.json -e ENABLE_BROWSER_AUTH_ADAPTER=true -e ENABLE_FRONTEND_AUTH_REWRITE=true -e ENABLE_OPEN_DEVICE_ACCESS=true -e DEVICE_STATE_DIR=/var/lib/skylit-device-state --mount "type=bind,source=$root/.local/session,target=/run/skylit-session,readonly" --mount "type=bind,source=$root/.local/device-state,target=/var/lib/skylit-device-state" skylit-gateway:local
```

Git Bash/OPS Bash 执行含 Linux 路径的 Windows CLI 命令时加 `MSYS_NO_PATHCONV=1`，PowerShell 不需要。

两项适配开关默认关闭：仅 `ENABLE_BROWSER_AUTH_ADAPTER=true` 才开放受本地认证/同源 POST 保护的正常短 JWT bootstrap；仅 `ENABLE_FRONTEND_AUTH_REWRITE=true` 才适配页面与正常数据授权。正文/资料读取有界、令牌/资料失效 fail closed，不把进程在线当作上游有效。

正常边缘授权只调用固定上游 `/api/edge/cookies`，三个签名 Cookie 仅在内存，按 owner/时效绑定精确 data 路径；每次数据发送前正常复核当前上游身份，不给其它路径/账号复用。SSE ticket 仅允许正常同源有限 POST（兼容原站空 body），并非开放任意写操作。

## 时钟与续期

本机实测 WSLC 时钟比宿主快约 14 秒。**没有放宽 Rust 的 JWT 期限校验，也没有改系统时钟。**辅助模块优先使用正常 SDK 缓存；有效期余量不足时最多额外执行一次正常 `getToken({skipCache:true})`，不给过期 token 延期、不自签、不无限重试。`SESSION_MIN_REMAINING_SECONDS` 当前为 45，运行中会按安全余量更新。

[调度回归测试](validation/session-refresh-policy.test.mjs)验证这一策略；[实际跨更新窗口测试](validation/session-stability-probe.mjs)只记录状态，不记录身份或凭证。生产仍应正确同步主机/VM 时钟；该余量不是对任意时钟漂移的保证。

## 验证及尚未完成

[原版页面回归](validation/black-screen-repro.mjs)在干净 Chrome 中禁止直连外部 HTTP/WS，检查原版导航、产品文字、没有诊断占位、真实热图矩阵、没有长期 Cookie 或 localStorage JWT。截图和 JSON 只留本机，可能含账户水印/市场数据，不要公开分享。

- 已验证：首页、SPXW 热图、正常边缘授权与 ticket、部分通知 SSE 连接。
- **未完整验收**：其它页面、Atlas WebSocket、全部实时协议和所有业务写操作。
- 账户/组织资料修改未在本地 Adapter 实现；未知权限不当作 true。交易、支付、创建规则等通用 POST 仍拒绝，未自动创建 key、调用正式计费 API、签协议或提交交易。
- 当前未转发 Developer key 管理及部分遥测，相关请求可见 401/403；不把这些失败伪造成成功。
- 生产 HTTPS、限流、持续进程管理、密钥轮换、单镜像/Compose 托管浏览器辅助模块、完整上游升级回归仍需后续工作。同账号云端数据默认共享，不代表多用户/多账号隔离。
