# dsh-plugin-market

**在 DeepSeek Harness 的设置面板里逛插件市场，一键安装。**

> A plugin-market settings page for DeepSeek Harness: browse the community catalog,
> see what you already have on its own tab, and install with one click.

数据来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 维护的
官方目录 `plugins.json` —— 约 **3,500+ 个插件、23 个双语分类**，带 Star 数、下载量、收录日期，
以及每个条目的官方安装命令。

---

## 它做什么

设置面板里新增一节 **「DSH 插件市场」**，**页面内**有两个标签：

| 标签 | 内容 |
| --- | --- |
| **全部插件** | 完整目录。可按分类筛选、按 Star/下载量/名称/收录时间排序、搜索插件名或简介 |
| **已安装** | 只列出**你已经装过**的插件，标签上直接显示数量 |

- **一键安装**：点「安装」即执行该条目的官方安装命令，装到当前 profile
- **安装状态**：已安装的条目带绿色徽章；若目录名与你实际装的包名不同，会标出真实包名
- **中英切换**：简介可切中文/英文
- **本地缓存**：目录存到本地，**1 小时内直接复用**；要最新的点「强制重新获取」
- **四级降级**：官方域名 → 镜像 → CDN → npm，任一条通即可

## 安装

作为一个 **DSH bundle** 安装。它会在设置里注册一个页面，**重启 DSH 后自动加载**。

```bash
cd ~/.dsh/profiles/web          # 换成你的 profile 目录
pnpm add file:/path/to/repo/pkg/dsh-plugin-market
```

然后把它加进 `package.json` 的层列表（声明了 `dsh.bundle` 的依赖才会生效）：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-plugin-market"]
    }
  }
}
```

重启 DSH。

**或者用仓库自带的脚本**（会先备份 profile 清单，失败可一键回滚）：

```bash
node tools/install-bundle.mjs            # 干跑，只报告会做什么
node tools/install-bundle.mjs --apply    # 实际安装
node tools/rollback-bundle.mjs           # 需要时回滚
```

## 使用

1. 打开设置 → **DSH 插件市场**
2. 浏览或搜索；点卡片右侧「安装」
3. 安装完成后**重启 DSH**，插件才会加载

「已安装」标签里可以确认某个插件是否已经在你的 profile 里。

## 架构

```
┌─ 浏览器半边 ────────────────────────────────────────────────┐
│  window.__ModuleLoader__.load({ id, factory(require) })     │
│  require('react')；槽位服务由 ctx 注入                       │
│  settings.section → 一个「DSH 插件市场」页面                 │
│      页面内两个标签：全部插件 / 已安装                       │
│  筛选、排序、分页全部在宿主侧完成                            │
└───────────────┬─────────────────────────────────────────────┘
                │ fetch()  ← 不是 host.call，也不是 ctx.remote
┌───────────────▼─────────────────────────────────────────────┐
│  宿主半边  index.js                                          │
│  ctx.inject(['webServer']) →                                │
│    GET  /dsh-plugin-market/list                             │
│    POST /dsh-plugin-market/install                          │
│  子进程输出经**文件描述符**捕获（非管道、非 shell）           │
└───────────────┬─────────────────────────────────────────────┘
                │ spawn(node, [market-core.mjs, …])
┌───────────────▼─────────────────────────────────────────────┐
│  market-core.mjs（真实文件，可单独运行）                      │
│    catalog   抓取/缓存目录（官方 → 镜像 → CDN → npm）         │
│    installed 读 profile 依赖 + node_modules                  │
│    install   用 profile 记录的 pnpm 主版本执行安装            │
└─────────────────────────────────────────────────────────────┘
```

### 为什么用 HTTP 而不是 `ctx.remote`

浏览器半边要调用宿主能力，但 `ctx.remote.<ns>` 的方法来自 DSH 的 **Typert 代码生成** ——
本地手写的插件无法注册自己的命名空间（`ctx.remote.$mount()` 只接受生成的贡献）。
而 webserver 的命名路由注册是公开服务：

```js
ctx.inject(['webServer'], (host) => {
  host.webServer.register({ kind: 'exact', path: '…', handler: (req, res) => {} })
})
```

于是宿主暴露两条路由，浏览器半边用 `fetch` 调用。

### HTTP 接口

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| `GET` | `/dsh-plugin-market/list` | `bypass, sourceUrl, category, q, sort, only, limit, offset` | `{ ok, payload: { items, categories, count, total, matched, installedTotal, offset, sort, only, category, q, catalogFromCache, fetchedAt, catalogUpdated, source, note } }` |
| `POST` | `/dsh-plugin-market/install` | `{ install, name? }` | `{ ok, spec, seconds, log }` |

`bypass=1` 是**唯一**的强制重新抓取旗标；只有「强制重新获取」按钮发它，其余调用都只做新鲜度检查。
两个标签也是**页面内的**：插件只注册一个 `settings.section`，第二个标签由页面自己渲染。

## 目录结构

```
pkg/dsh-plugin-market/        ← 可安装的插件本体
  package.json                声明 dsh.bundle.patch 与 dsh.client.platform
  cordis.patch.yml            把自己插进 profile 的层栈
  index.js                    宿主半边：两条 HTTP 路由
  market-core.mjs             生成的辅助脚本（见下）
  client/client.js            浏览器半边：单个设置页 + 页内两个标签

tools/
  market-core.mjs             辅助脚本的**源**（带注释与占位符）
  helper-build.mjs            从源生成成品的唯一实现
  build-helper.mjs            生成 → pkg/dsh-plugin-market/market-core.mjs
  strip-comments.mjs          词法级去注释（token 流比对证明行为不变）
  capture.mjs                 无管道、无 shell 地捕获子进程输出
  check-all.mjs               一条命令跑完全部守卫
  test-market-core.mjs        辅助脚本端到端（真实 HTTP、TTL、inventory）
  test-install.mjs            安装命令形态 + pnpm 拒绝的回归
  test-bundle.mjs             宿主路由（模拟上下文）+ 客户端源码不变量
  test-bundle-tabs.mjs        两个标签的渲染与行为
  check-sync.mjs              提交的成品必须等于源生成的结果
  check-helper-version.mjs    本机 profile 记录的 pnpm 主版本是否被正确采用
  install-bundle.mjs          装进 profile（带备份）
  rollback-bundle.mjs         回滚
  coverage.mjs                目录字段覆盖率
  check-readme.mjs            本文件里没有过期数字
```

`pkg/dsh-plugin-market/market-core.mjs` 是**生成物**，但它被一起提交，这样 clone 下来就能直接装。
`tools/check-sync.mjs` 会在它与源不一致时失败 —— 改了 `tools/market-core.mjs` 就跑
`node tools/build-helper.mjs`。

## 开发

```bash
node tools/check-all.mjs     # 全部守卫；任一步失败即停
```

守卫里有几条**故意跑修复前的代码**，用来证明守卫本身有检测能力，而不是永远绿灯。

## 设计笔记：几个踩过的坑

这些都是**静态检查过不了、只有真跑起来才暴露**的问题，记下来免得重犯。

### 1. 不要覆盖 profile 自己的 pnpm 配置

原实现固定用 `pnpm@9`，并附加 `--config.node-linker=hoisted`、`--config.auto-install-peers=false`、
`--config.store-dir=…`。但 profile 的 `pnpm-workspace.yaml` **已经**声明了这些，
而它的 `node_modules/.modules.yaml` 记录了：

```
packageManager:            pnpm@12.4.1
virtualStoreDirMaxLength:  60
```

命令行再传一遍就成了**互相矛盾**的配置，pnpm 直接拒绝：

```
ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF
```

**修法**：从 `.modules.yaml` 读出记录里的 pnpm **主版本**用它，**不再传任何 `--config.*`** ——
配置由 profile 自己的文件决定。

### 2. 一个未审核的构建脚本会让所有安装失败

`strictDepBuilds` 默认为 `true`，于是只要 profile 里有**任何一个**依赖带未审核的构建脚本，
pnpm 在新增包时就直接非零退出：

```
ERR_PNPM_IGNORED_BUILDS
╰─▶ Ignored build scripts: node-pty@1.1.0
```

**修法**：先正常安装；**只有** pnpm 真的以该错误拒绝时，才用 `--ignore-scripts` 重试。
这样「已被批准的构建」照常执行，而重试**不批准任何东西、不运行任何脚本**。

注意 `pnpm@12` **不认** `--config.strict-dep-builds=false`，也**不认**
`npm_config_strict_dep_builds=false`（均实测无效），所以只能走重试。
**不要**用 `dangerouslyAllowAllBuilds` —— pnpm 官方文档明确警告它会运行所有依赖的安装脚本。

### 3. 捕获子进程输出：不能用管道，也不能用 shell

| 做法 | 问题 |
| --- | --- |
| `execFileSync` / `spawnSync` 默认 stdio | 用**具名管道**，受限沙箱下 `EPERM` |
| `shell: true` + `> file` 重定向 | shell 会**重新解析参数**，而安装 spec 来自远程目录 → 命令注入 |

**做法**：把普通**文件描述符**交给子进程（`stdio: ['ignore', ofd, efd]`）——
无管道、无 shell、也不会因为管道缓冲满而死锁。

### 4. React key 必须唯一 —— 插件名不是唯一的

目录里 `dsh-memory` 出现 **9 次**，单页 100 条里同一个名字最多重复 **4 次**。
卡片原本用插件名当 key，重复 key 让 React 复用错误的节点、保留旧卡片 ——
于是**数据已更新、界面不变**。修法：`key = 名字 + '#' + 行号`。

### 5. 只有最新一次请求能写状态

筛选在宿主侧执行，所以改分类/排序/筛选都必须重新查询。两个请求乱序返回时，
**先发的那次会覆盖后发的结果** —— 列表看起来"没更新"。
修法：每次请求编号，响应回来时若已不是最新就丢弃。

### 6. 2.8 MB 的目录不能走 stdout

目录太大，经 stdout 传输会被截断。改成**脚本写文件、只打印一行小摘要**，宿主读文件。

## 许可

[MIT](LICENSE)
