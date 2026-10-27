# 发布与目录同步

项目更改完成后，默认执行以下流程，直到 npm 发布和目录更新 PR 均可核验。

1. 完成实现；修改辅助脚本源后运行 `node tools/build-helper.mjs`。
2. 运行 `node tools/check-all.mjs` 和 `git diff --check`。界面改动需在 DSH 中验证并更新截图。
3. 选择尚未发布的适当版本，检查 npm 实际打包内容，提交并推送插件仓库，再核对 GitHub 远端提交。
4. 运行 `npm publish --access public`。核验 npm registry 的版本、`latest` 标签和实际发布包；只推送 GitHub 不代表已发布 npm。
5. 更新 `awesome-dsh-plugin/awesome-dsh-plugin` 的目录条目：
   - Fork：`99galaxy/awesome-dsh-plugin`。
   - 复用分支：`update-99galaxy-dsh-plugin-market`。
   - 仅修改 `data/plugins/99galaxy__dsh-plugin-market.yml`；README 由上游生成。
   - 使用稀疏或部分检出，合并最新上游 `main` 并保留分支历史，不强制推送。
   - 使用上游 `scripts/lib/entries.mjs` 校验 YAML，确认与上游的差异仅含该条目。
   - 推送前查询已有开放 PR；存在则更新，否则从同一分支向上游 `main` 新建 PR。
6. 核验 PR 地址、状态、head/base 分支及变更文件。报告插件提交、npm 版本和目录 PR；上游合并或目录生成尚未完成时明确说明。

此流程作为后续项目更改的默认交付要求。仅在缺少登录授权、需要一次性验证码或遇到实际外部阻塞时请求用户操作；不索取或输出密码、令牌。目录是否已更新，以在线生成条目的核查结果为准。
