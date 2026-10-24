# 原版前端首页黑屏与 auth Module seam：只读研究

## 结论先行

**保存的公开前端 JS 中没有发现可直接接入 Rust 身份/短 JWT 的正式、可维护、可配置的应用 auth adapter seam。** 找到了可作为源码重构起点的应用 Module `173089 / StableAuthProvider`，但它不是授权抽象：只给 Clerk auth 对象做稳定化。仅改它的 `getToken`，甚至替换它全部返回值，都无法替代其他 Module 直接使用的 Clerk `SignedIn/SignedOut`、`useUser/useSession` 与用户资源方法。不能据此承诺“小改一个 Module 就能恢复原版首页”。

**黑屏存在至少两处确定的静态空渲染条件：**

1. 应用 Providers 内的 Terms gate：auth `isLoaded` 为 false 时 `return null`，包住主 children。
2. 应用 shell 使用 Clerk 自己的 `SignedOut` 与 `SignedIn`；Clerk 尚未确定 `userId`（undefined）时二者均返回 null，连 “Access Required” 都不会显示。

另有首页 Start gate/全屏 curtain，但分别有 4 秒/4.5 秒释放，不应将它们误诊为唯一的永久黑屏原因。以上与调用方已现场观察的 `root 200 / title Skylit / DOM 可见 0 / Clerk /v1/client origin_invalid 400` 相符；**本次没有运行网页，不能判定现场实际首先命中了哪一层，亦不能声明修复已验证。**

正式 Clerk proxy 需要站点方 secret/生产 domain 配置，不能把任意第三方实例经本地转发称作受支持 proxy。本研究不提出改变该实例设置、不提出伪造 membership/claims、不采用 dev bypass。

## 方法与范围

仅扫描 `api-recon/assets` 已有 JS 的文本，使用有界索引/片段读取；没有执行第三方 JS、构建、运行网页、网络下载、读取 `.local`/`account-info`、修改 Rust 或资产。唯一写入为本文。没有源映射或原始 TS 接口证据，故 module id 指**这份保存的 Turbopack 构建**，不是跨版本稳定标识。以下 offset 是 Python 解码后的字符串字符位置（0-based，非字节），用于定位压缩长行；短片段保留原意、部分略去无关代码。

## 证据：文件 / Module / 短片段

### 1. StableAuthProvider 只是 Clerk auth memo

来源：[3saht1vl84b4q.js](../../api-recon/assets/3saht1vl84b4q.js)，factory header offset 69921，Modules **173089、338703**；StableAuthProvider 名称 offset 70631。

```js
var n=e.i(840578);
e.s(["useAuth",()=>n.usePromisifiedAuth],338703);
let a=(0,r.createContext)(null);
// module 173089
StableAuthProvider({children:e}) {
  let u=(0,n.usePromisifiedAuth)();
  // d: semantic key; ignores volatile claim keys
  let {getToken:h,signOut:c,has:p}=u;
  let m=(0,r.useMemo)(()=>u,[d,h,c,p]);
  return jsx(a.Provider,{value:m,children:e});
}
useStableAuth() {
  let e=useContext(a);
  return null!==e ? e : n.usePromisifiedAuth();
}
```

被排除的易变 claim keys 为 `__raw, iat, exp, nbf, jti, fva`；其余语义字段参与 memo key。**这不是在删改实际 claims**，返回值仍是原 Clerk auth 对象。Provider props 只有 children；没有 `adapter`、`value`、`getToken` 注入参数；context 没导出。`338703` 导出的 `useAuth` 仍直接指向 Clerk。

同文件 **840578**，offset 68486 附近：`usePromisifiedAuth` 浏览器分支最终调用 Clerk `965389.useAuth`。SSR 的 authPromise/context 不等于在浏览器接入任意 JWT 的应用正式 adapter。

### 2. Providers 与应用 readiness/Terms gate

来源：[44g3ussuqv3-v.js](../../api-recon/assets/44g3ussuqv3-v.js)，Module **267604**，`Providers` offset 91766 附近；内部函数 **tR** offset **83428**。

```js
Providers({children:e}) {
  return jsx(StableAuthProvider,{children:
    jsx(QueryClientProvider,{children:
      jsx(EffectiveRolesProvider,{children: /* ... */
        jsx(tR,{children: /* ... e ... */})
      })
    })
  });
}
function tR({children:e}) {
  let {isLoaded:t,isSignedIn:i}=useStableAuth();
  // query: ["legal","terms-status",userId], enabled: !!isSignedIn
  // ...
  if(null!==useViewAs()) return Fragment(e);
  if(!t||o) return null; // o = terms query isLoading
  let m=l&&(!(u instanceof TermsApiError)||(u.status??500)>=500);
  if(!i||a?.accepted||m) return Fragment(e);
  // 否则显示真实 Terms 接受对话框，而非应用主 children
}
```

Terms 请求 Module **519520**（同文件）使用 `await getToken()` 加 `Authorization: Bearer`，向**当前 origin** `/api/nexus/legal/terms-status` 请求。它不是仅取一个 token 即放行：已登录还会检查 Terms，不能伪造 accepted。5xx/非 TermsApiError 的 fail-open 是现有代码行为，并非建议触发/利用它。

`ClerkLoaded` 在这个文件开头只是 SDK re-export，未找到作为该 Providers 的实际包裹。不要把名字命中当成实际黑屏 gate。

### 3. Layout 直接依赖 Clerk SignedIn/SignedOut

来源：[3421rqya-7ape.js](../../api-recon/assets/3421rqya-7ape.js)，Module **588537**；内部 shell 函数 `sr` offset **313070**，结尾 gate offset **327453**；最终 default layout export offset **356920**。

```js
var w=e.i(853355), N=e.i(827085), T=e.i(173089);
// sr: useStableAuth + useUser + useAdminRole 等
let eq="true"===env.NEXT_PUBLIC_DEV_BYPASS_AUTH;
return eq ? th : jsxs(Fragment,{children:[
  jsx(w.SignedOut,{children:jsx(J,{pathname:c??"/",theme:p})}),
  jsx(w.SignedIn,{children:th})
]});
```

`J` 是 “Access Required / Please sign in with your authorized account” 页。Module **853355** 位于 [1g_v7ow8b__pg.js](../../api-recon/assets/1g_v7ow8b__pg.js)，直接别名 Clerk **265829** 的 SignedIn/SignedOut；不是应用自己的可注入 gate。

Clerk 实现来源：[3saht1vl84b4q.js](../../api-recon/assets/3saht1vl84b4q.js)，Module **265829**，offset **9282**：

```js
SignedIn: ({children:e,...}) => { let {userId:r}=K(...); return r?e:null; }
SignedOut:({children:e,...}) => { let {userId:r}=K(...); return null===r?e:null; }
```

未加载时 `userId === undefined` 与已加载未登录的 `null` 不同。因此**无论 StableAuthProvider 被怎样替换，只要 shell 仍走 Clerk 原 gate，黑屏仍可能存在**。开启 `DEV_BYPASS_AUTH` 不属于合法 adapter，也会改变访问逻辑，拒绝作为方案。

### 4. 用户与授权角色另走 Clerk，不经过 StableAuthProvider

来源：[2um2c9egw6eua.js](../../api-recon/assets/2um2c9egw6eua.js)，Module **557901**，offset **12872** 附近，`useEffectiveRolesState` / 内部 `g` 与 Provider `v`。

```js
var s=e.i(827085);
function g(session) {
  let {user:n,isLoaded:i}=s.useUser();
  let v=n?.publicMetadata;
  // role/roles <- publicMetadata
  // orgRoles <- n.organizationMemberships.map(m=>m.role)
  // actor/expireAt <- session; view-as 另有写保护
  return {roles, orgRoles, isLoaded:i, user:n, /* ... */};
}
function v({children:e}) {
  let {session:m}=s.useSession(), h=g(m);
  return jsx(EffectiveRolesContext.Provider,{value:h,children:e});
}
```

Module **237127** 同文件只是 `useEffectiveRoles` 的 context/fallback 包装。**EffectiveRolesContext 可供角色消费，但不是完整 auth adapter，且生产 Provider 实现固定创建状态，不接受外部身份。**

Clerk `useUser` 来源：[0rvuravpijnzz.js](../../api-recon/assets/0rvuravpijnzz.js)，Module **827085**，函数 `e4` offset **32213**：undefined 用户返回 `{isLoaded:false,isSignedIn:undefined,user:undefined}`；null 才表示已加载且未登录。

来源：[0f-z2xs8k048x.js](../../api-recon/assets/0f-z2xs8k048x.js)，factory **532972、468638**，`useAccessCapabilities` offset **17677**：读取 `useEffectiveRoles` 的 user/roles/orgRoles，与 `useStableAuth.isSignedIn` 合并，再加载真实 entitlements。**身份、角色与后端授权是多个输入，不能从“JWT 存在”推导 plan/membership/admin。**

来源：[44g3ussuqv3-v.js](../../api-recon/assets/44g3ussuqv3-v.js)，Module **311959**，RoleSyncProvider offset 5020 附近：直接 `useUser()`，定时/聚焦调用 `user.reload()`。此外 Module 267604 的 analytics 使用 `user.createdAt/publicMetadata` 等，checkout-resume Module **109730** 也直接 useUser。Rust 的普通 JSON user 不自然具有 Clerk Resource 的方法与语义。

### 5. Start readiness gates 是有超时的次级 gate

来源：[3u0c9ej2e_4ca.js](../../api-recon/assets/3u0c9ej2e_4ca.js)，Module **896638**，StartGate offset **141756**；shell default layout 会挂 StartHoldCurtain。

```js
StartGate: // useEffectiveRoles.isLoaded + useCanOpenNav.ready + pref.ready
if(!f) return; if(!h||!y) return;
// hold 到 show 的 4e3 ms timeout
// 非 show 返回 data-testid="start-gate-hold" 的空占位
StartHoldCurtain:
// 首页、尚未 done、尚未超时、尚未确定未登录时
// fixed inset-0 z-[65] bg-background
// 4500 ms timeout 解除 curtain
```

这解释启动期间整屏背景，但仅靠这层不足以解释持续黑屏；上方 Terms gate 不渲染 children 时，这些 timeout 甚至可能尚未挂载。

### 6. 找到真实 token transport seam，但不是 auth adapter

来源：[44g3ussuqv3-v.js](../../api-recon/assets/44g3ussuqv3-v.js)，Module **704218**，offset **13659**：

```js
useChartApiAuth() {
  let {getToken:e,userId:a}=useStableAuth();
  setAuthTokenProvider(e);
  useLayoutEffect(()=>setAuthIdentity(a),[a]);
}
```

对应 [43r3dhwwy0b3w.js](../../api-recon/assets/43r3dhwwy0b3w.js)：Module **387526** 导出 `setAuthTokenProvider(e){Z=e}`（offset **28825**）；Module **65918** 导出 `setAuthIdentity/getAuthIdentity/subscribeAuthIdentity`（offset **4517**），主要用于数据请求/缓存隔离。

这是可维护性相对较好的**图表 token transport 内部 seam**，可以供应合法短 JWT，但无法解决整体 readiness、user、roles、Clerk shell gates。调用方需尊重用户切换清缓存、撤销、到期刷新与 null/undefined 的区别；单独调用这个 setter 不能被描述为登录原版应用。

## 接到 Rust 的最小改动面：区分“现在可用”与“需要重构”

### 现在已存在的正式全局 adapter

**未找到。** 没有第二个生产 adapter，也没有可配置的应用 auth interface。没有证据支持无需修改 bundle 即把 Rust identity 注入 Clerk 正式生产 Provider。Clerk SDK 内有自己的初始化/Clerk 对象选项，但那要求兼容其资源、状态机与方法，不是“任意短 JWT + user JSON”正式接口；不作为可维护方案。

### 若有原源码及授权，理论上最小的应用 Module 改造簇

这不是已验证补丁，而是由证据推导的工作范围下限：

1. **173089**：建立真正的应用 auth Interface，显式接收 adapter，而不是永远调用 Clerk。至少覆盖 loading/anonymous/authenticated/error 状态、真实 userId/sessionId、`getToken(options?)`、刷新/撤销、signOut、真实授权检查。不得把有字符串 token 等同为 ready/authenticated；`has` 不能统一返回 true。
2. **267604 + 588537**：Provider composition 选择 Rust adapter；shell 替换直接 Clerk SignedIn/SignedOut 为应用 gate；保留 Terms 查询/接受与所有真实 entitlement gate。只改 tR 的 `return null` 是视觉诊断/错误提示改进，不是授权接入。
3. **557901**：从真实身份与权威角色来源建立 effective roles；不自造 org memberships；保留 actor/view-as 的降权与写保护；若 Rust 不提供可信 membership/metadata，则维持未确认/拒绝状态，而非填默认高级会员。
4. **311959、109730、267604 内直接 Clerk user 消费、588537 的 useUser**：迁移实际需要的数据/刷新语义。禁用或重做 Clerk 资源专属 `reload/update` 功能，不伪装 JSON 为完整 UserResource。账户/组织/登录 UI 的其他直接 Clerk 消费须另作只读清单；当前不具备“只影响这几个 id”穷尽保证。
5. **704218/387526/65918**：现有图表 token seam 可继续复用；**532972/406093** 的 entitlements 与合法后端响应保持权威。扩展到其他页面会有更多直接 Clerk hooks/交互，范围不再是首页最小簇。

直接 patch 压缩 Turbopack 的风险：闭包私有 context、重复 chunk/factory 注册、module id 随构建变化、缓存与 chunk hash/Flight 引用、SSR 与客户端身份不一致。不能将一次性的 module factory 替换称为维护稳定 seam；即使能解除可见空白，也不能宣称登录、会员权限或后端调用已正常。

## 身份/短 JWT 的合法性与安全约束

- Rust 返回的必须是真实、已授权取得且目标后端接受的短 JWT。Rust 自签的“真实用户名字”JWT，并不会自动成为原 Skylit 后端认可的 token；issuer/audience/签名/过期/session/tenant 均需合法匹配。本次未验证 Rust 的身份来源、接口或后端接受情况。
- 单一 JWT 一般不含完整可信用户资源、组织 memberships、已接受条款、全部 entitlements。只有权威响应能驱动相应状态，未知保持未知/拒绝；不能解码后补造 claims。
- 公司浏览器可收到用户允许的短 JWT；长期 cookie/password 留在其允许环境，不发浏览器、不进入研究文件/日志/埋点。短 JWT 也应内存持有、短 TTL、最小权限、刷新经受控通道，不写 localStorage，不拼接到不必要 URL。
- 现有通知流 Module 267604 有 `notificationStreamURL(token)` / EventSource 路径；迁移时必须专项确认 URL 日志、代理与遥测泄漏，不能因为仅是短 JWT 就忽略。
- 原版前端含 analytics/外部链接/其他网络目的地。允许浏览器持有短 JWT 不等于允许把它发送至任意目的地；adapter 应限制 token 请求目的地、模板/audience，并在账户切换/到期时清理缓存与连接。

## 建议决策

**短期：不要继续把“绕过 Clerk origin_invalid + 注入 getToken”当成原版首页恢复的确定路线。** 在不改第三方实例设置的前提下，保存资产未提供正式全局 auth adapter。若仅要复用合法数据能力，可独立复用受控的 token transport/自有 UI；若坚持原版完整首页，需要明确接受应用源码级 auth Module 重构或高维护 bundle patch，先审计实际页面依赖，再以合法身份与真实后端授权做验证。本文没有实施，也没有宣称能够以一个小 patch 完成。
