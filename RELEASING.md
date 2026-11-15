# 发布正式版本

用户可从仓库的 Releases 下载完整 ZIP；每个 ZIP 解压后都有独立的
`dsh-tongji-usage-widget` 文件夹，包含 DSH 插件与 `browser-extension` 浏览器助手。

发布前同步修改 `package.json` 和 `browser-extension/manifest.json` 的版本号，
补充版本说明，运行 `npm test`。版本必须是正式的 `X.Y.Z`。

```powershell
node scripts/build-release.mjs --tag v0.3.0
```

打包需要官方 Node.js（含 npm）与 Python 3。脚本不执行 npm 生命周期脚本，
会验证包名、版本一致性、发布文件清单与 ZIP 完整性。产物位于
`artifacts/release-v0.3.0`，包括：

- `dsh-tongji-usage-widget-0.3.0.zip`：供用户解压安装的完整插件。
- `dsh-tongji-usage-widget-0.3.0.tgz`：供更新器读取的 npm 格式包。
- `update.json`：版本、TGZ 文件名、大小和 SHA-256。
- `SHA256SUMS`：全部上述资产的校验值。

只有 `lib`、`scripts`、`browser-extension`、`tests` 与明确列出的项目文件可以进入发布包。
本机凭据、研究记录和 `artifacts` 不属于发布内容。打包后仍需按正常发布流程检查源代码中
是否误写入了个人数据。SHA-256 用于验证下载与发布资产一致，不代替对发布账号的信任。

提交并推送已验证的源码后，再创建对应版本标签：

```powershell
git tag v0.3.0
git push origin v0.3.0
```

GitHub Actions 会检出标签、再次测试并生成四个发布资产，然后创建 Release。
也可以在 Actions 的 `Publish plugin release` 中手动运行并填写已存在的版本标签。
工作流使用仓库自带的 `GITHUB_TOKEN` 发布，无需新增个人访问令牌。
已发布资产不覆盖；修复发布内容应增加版本并发布新标签。

发布成功后应核对 Release 页面、资产下载和校验值，再验证实际安装。
后端更新后需要重启 DSH；浏览器助手代码更新后，需要在扩展管理页重新加载助手。
