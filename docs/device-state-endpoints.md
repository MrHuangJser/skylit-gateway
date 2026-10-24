# 设备隔离状态接口与账户组件清单（来自 api-recon 公开证据）

本文件是实现依据，证据来自 `api-recon/assets/*.js` 公开前端与 `docs/internal-platform.md`。所有方法/载荷来自已保存 bundle，不是服务端契约证明；代理模拟必须返回前端校验所要求的形状，否则前端报错。

## A. 需按设备本地持久化、不再发往上游的「用户 UI 状态」接口

前缀 `TV_API_BASE = "/tv"`（见 `43r3dhwwy0b3w.js`：`"TV_API_BASE",0,"/tv"`）。这些都走 `authFetch`（会被代理加上游 Bearer），我们改为在代理侧本地处理。

### 1. 图表布局 /tv/layouts （`0bv3k57qjo2t2.js`,`2d5-m4a2xo2w0.js`）
- `GET /tv/layouts`，支持 `If-None-Match`；200 返回 `{layouts: Layout[], updatedAt: number}`，响应含 `ETag` 头；304→not-modified；404→disabled。
- `PUT /tv/layouts/{id}`，body `{name, values, writerId?, writerSeq?, baseVersion?, force?}`，Content-Type json；200 返回 `{id, version, name, values, updatedAt, ...}`（onSuccess 读取 `t.id,t.version,t.updatedAt`）；409 冲突返回 `{currentVersion, updatedAt}`。
- `DELETE /tv/layouts/{id}`，404 容忍。
- Layout 项形状：`{id, name, values, updatedAt, version?}`。有 `DEFAULT_LAYOUT_ROW_ID`、`LOCAL_DEFAULT_LAYOUT_ID` 本地概念。
- 代理本地实现：按设备存 `{layouts:[], updatedAt:0}`；GET 返回该列表并给 ETag；PUT 生成/更新项（version 递增、updatedAt=now）返回完整项；DELETE 删除。空状态返回 `{layouts:[],updatedAt:0}`（不要 404 以免被当 disabled）。

### 2. 画线 /tv/drawings （`3h_7x2ku6wyx5.js`）
- `GET /tv/drawings`（bulk）→ `{drawings: {symbol: Drawing[]}, updatedAt}`；404→`{drawings:{},updatedAt:0}`。
- `GET /tv/drawings/{symbol}` → `{symbol, drawings: Drawing[], updatedAt}`；404→`{symbol, drawings:[], updatedAt:null}`。
- `PUT /tv/drawings/{symbol}`，body `{drawings: Drawing[]}`；200 必须返回 `{symbol:string, updatedAt:number|null, drawings:Drawing[]}` 且每个 drawing 有 `id:string, tool:string`，否则前端抛 "malformed response"。
- Drawing 形状：`{id, tool, symbol, ...}`。
- 代理本地：按设备+symbol 存数组；回显校验所需结构。

### 3. 画线预设 /tv/presets （`3h_7x2ku6wyx5.js`）
- `GET /tv/presets`（支持第三参 etag/signal）→ `{presets:[], activeByTool:{}, updatedAt}`；404→默认空。
- `PUT /tv/presets`，body `{presets, activeByTool}`；200 返回同形状。

### 4. 关注列表排序 /tv/watchlist-order （`0ro708uie8xun.js`）
- `GET /tv/watchlist-order` → `{sectionOrder:[], symbolOrder:{}, updatedAt}`；404→默认。
- `PUT /tv/watchlist-order`，body = 整个 order 对象；200 返回更新后对象。

### 5. 关注列表 /api/watchlists （`3mg37r9ohqo1-.js`,`193w0qpb8nhpw.js`）
- `GET /api/watchlists` → `{user_id, watchlists:[{id,name,symbols,created_at,updated_at,is_default}], favorites:[], updated_at}`。
- `POST /api/watchlists`（创建），body watchlist；onSuccess 读 `s.watchlist`（需返回 `{watchlist:{id,name,symbols,...}}`）；前端还会轮询 getWatchlists 找同名新项，故本地需立即可见。
- `PUT /api/watchlists/{id}`（更新），body data。
- `DELETE /api/watchlists/{id}`。

### 6. 收藏 /api/favorites （`3mg37r9ohqo1-.js`,`193w0qpb8nhpw.js`）
- `GET /api/favorites` → `{favorites:[]}`。
- `POST /api/favorites/{symbol}`（添加）；onSuccess 读 `e.favorites`（需返回 `{favorites:[]}`）。
- `DELETE /api/favorites/{symbol}`（移除）；同样返回 `{favorites:[]}`。

### 7. 通知规则偏好 /siren/preferences （`25191trc0rmtm.js`）
- `GET /siren/preferences` → json 偏好对象。
- `PUT /siren/preferences`，body 偏好；返回 json。
- 说明：siren 其它（rules/channels/mute）属提醒业务，不在本次隔离，保持上游/现状。

### 8. Talon 偏好 /agent-gateway/platform/api/v1/talon/preferences （`2lkl065xlc166.js`,module185092）
- 路径经 `getPlatformBase()` 拼 `/api/v1/talon/preferences`，完整 = `/agent-gateway/platform/api/v1/talon/preferences`。
- `GET` → `{prefs_json:{...}}`（前端取 `t.prefs_json??{}`）。
- `PUT`，body 偏好。

### 本地画线迁移注意
`0kgchv8mkaj2z.js` 有 localStorage `skylit:drawings` 与 `getDrawingsBulk` 合并逻辑；本地代理实现不影响它，但 bulk GET 必须返回 `{drawings:{...}}`。

## B. 需在代理侧阻断的「账户/设置」页面与接口

### 账户设置页面路由（Next 路由，GET HTML）
- `/user-profile`（及 `?tab=billing` 等）— Clerk 托管账户资料/账单。
- `/developer`, `/developer/api`, `/developer/connect`, `/developer/keys`, `/developer/usage` — 开发者 key/用量。
- `/affiliate`, `/affiliate/welcome` — 联盟。
- `/invite` — 邀请。
- Clerk 账户管理（`/user` 或 Clerk 弹层 manage-account）。
证据：`19q5tz_3fy07h.js`,`3r4zcnu-a4kr7.js`,`3nvvkj53wqwhu.js` 的 href。

### 账户/个人资料类接口（阻断或置空；多数当前已 401，可直接拒绝）
- `/api/developer/keys`,`/api/developer/nonpro`,`/api/developer/usage`
- `/api/njord/me/billing/overview`,`/api/njord/me/payment-settings`,`/api/njord/me/api-credits`,`/api/njord/me/invite*`,`/api/njord/me/partner-application`,`/api/njord/me/commerce-eligibility`,`/api/njord/me/affiliate`(POST)
- `/api/nexus/users/me`（账户资料，当前 401）
- Clerk `/v1/me`、manage-account 相关（由 adapter 的 Clerk 替身拦，`openUserProfile` 已 unsupported）
注：这些属「阻断」，不本地模拟；返回 403/空，让前端优雅降级。交易类（trades/trading/orders）继续全局 403（已有）。

## C. 左下角用户/账户组件（需在公司端完全移除、不允许访问）

- 组件在 layout chunk `3421rqya-7ape.js`（module 588537，shell）。
- 触发按钮：`<button data-testid="account-menu-trigger" ...>`，外层 `<div class="relative flex items-center ...">`。
- 该 div 作为 `footerAccount` 传入 `SidebarFooter`（`232hr7qtrmnij.js`）第二行 `<div class="sidebar-footer-row" ...>{a}</div>`（a=footerAccount）。
- 用户名/头像来源：`useCurrentUser`/Clerk `imageUrl`/`firstName`（侧栏左下角显示的用户名和头像）。
- 账户弹层菜单项：Manage Account、Aegis、Performance、Trade Tools、Portal、Test Notification、Sign Out（`account-menu-trigger` 展开）。
- 用户名设置弹层：`35vt5tn-kp07u.js` `data-testid="username-prompt"`（选用户名）—一并隐藏。

### 隐藏方式（代理注入 CSS，最稳，不改业务 JS 行为）
```css
.sidebar-footer-row:has([data-testid="account-menu-trigger"]) { display:none !important; }
[data-testid="account-menu-trigger"],
[data-testid="username-prompt"] { display:none !important; }
```
Chrome 156 支持 `:has()`。CSS 由代理在 HTML `<head>` 注入（现有 frontend rewrite 已注入 runtime script，可同处注入 `<style>`）。另外前端 Adapter 的 Clerk 替身已把 `openUserProfile/openSignIn` 等设为 unsupported，Manage Account 不会打开上游资料页。

## D. 设备标识
取消访问码后，代理为每个无 cookie 的浏览器自动签发随机设备 cookie（HttpOnly）。该 cookie 既是会话标识，也是设备隔离键（layouts/drawings/... 按此键分桶存储）。保留 Host/Origin 同源校验与固定上游，防止其它网页借浏览器调用代理。
