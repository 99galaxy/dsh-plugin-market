# DSH 插件市场（dsh-plugin-market）

在 **DeepSeek Harness 的设置面板**里新增一节「DSH 插件市场」：浏览
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 维护的插件目录，**页面内**两个标签
（全部插件 / 已安装），支持搜索、分类筛选、排序，并可一键安装到当前 profile。

这是一个 **DSH bundle**（常驻插件）：装进 profile 后**重启自动加载**，
不需要像动态 Cordis 插件那样每次重启重新挂载。

> 完整的安装说明、架构说明与设计笔记见[仓库根目录的 README](../../README.md)。

## 结构

```
package.json          声明 dsh.bundle.patch 与 dsh.client.platform
cordis.patch.yml      把这个插件插进 profile 的层栈
index.js              宿主半边：挂两条 HTTP 路由，代理到 market-core.mjs
market-core.mjs       市场辅助脚本（生成物，勿手改；源在 tools/market-core.mjs）
client/client.js      浏览器半边：模块加载器 bundle，注册 settings.section
```

## 为什么是 HTTP 而不是远程命名空间

浏览器半边要调用宿主能力，但 `ctx.remote.<ns>` 的方法来自 DSH 的 **Typert 代码生成**，
本地手写的插件无法注册自己的命名空间。而 webserver 的命名路由注册是公开服务：

```js
ctx.inject(['webServer'], (host) => {
  host.webServer.register({ kind: 'exact', path: '...', handler: (req, res) => {} })
})
```

所以宿主半边暴露两条路由，浏览器半边用 `fetch` 调用：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/dsh-plugin-market/list` | 目录 + 筛选 + 分页，返回 JSON |
| `POST` | `/dsh-plugin-market/install` | 校验安装命令并执行 pnpm |

## 安装

```bash
# 在 profile 目录里（~/.dsh/profiles/web）
pnpm add file:<本包路径>
```

然后在 `package.json` 的 `dsh.profile.bundles` 里加入 `dsh-plugin-market`，重启 DSH。

安装链路会读取 `node_modules/.modules.yaml` 记录的 pnpm 主版本来执行安装，
**不用 `--config.*` 覆盖 profile 自己的 pnpm 配置** —— 否则 pnpm 会以
`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF` 拒绝操作该 `node_modules`。

## 开发

本包由仓库的构建脚本生成，**不要手工编辑 `market-core.mjs`**：

```bash
node tools/build-helper.mjs   # 由 tools/market-core.mjs 生成（去注释 + 替换占位符）
node tools/check-all.mjs      # 全部守卫（含「成品是否等于源」的检查）
```
