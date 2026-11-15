# 安装与卸载

插件包名：`dsh-tongji-usage-widget`。源码目录即插件根目录，不需要另找子目录。安装前先把整个目录放在长期保留的位置。

本说明适用于本仓库的 DSH 插件和浏览器登录助手；原 Qoder 插件是独立项目，未包含在本仓库中。

0.3.0 起也可从 [GitHub Release](https://github.com/KimBrine/dsh-tongji-usage-widget/releases/latest) 下载完整 ZIP，解压后的 `dsh-tongji-usage-widget` 文件夹就是插件根目录。首次安装仍按下面的本地 `link:` 方式操作。Git 克隆安装可在浮窗发现新版后点击“下载并安装更新”；解压安装提供“手动下载”。更新完成后重启 DSH，浏览器助手代码更新后在扩展管理页重新加载，无需重新配对。

## 官方 DSH 桌面客户端

桌面客户端读取 `desktop` profile。当前本机 DSH `0.1.7-rc.2` 的官方 CLI 明确拒绝管理该 profile，应通过桌面会话内置的 `plugin_manager` 安装。

打开 DSH 桌面客户端，在一个会话中发送下面这段话：

> 请使用当前桌面端内置的 plugin_manager 安装同济 AI 积分浮窗。先确认当前是 desktop profile，并执行 list_bundles，检查 dsh-tongji-usage-widget 是否已安装。若未安装，执行 install_bundle，target 为 `link:D:\plugins\dsh-tongji-usage-widget`，enabled 为 true。若已从这个目录安装，请保留来源；如果被禁用则用 set_bundle 启用。若来自其他来源，先报告来源与版本，不自动迁移。请告诉我工具返回的安装结果、实际版本和是否需要重启。

对应的工具参数是：

```json
{"action":"list_bundles","limit":100}
```

```json
{"action":"install_bundle","target":"link:D:\\plugins\\dsh-tongji-usage-widget","enabled":true}
```

如果源码目录不同，请改为实际的**绝对路径**。列表有下一页时继续检查，避免重复安装。已安装但禁用时使用：

```json
{"action":"set_bundle","target":"dsh-tongji-usage-widget","enabled":true}
```

安装后若右下角没有出现卡片，完全退出 DSH（包括系统托盘），再重新打开。桌面端的前端注入表在启动时收集，工具返回已应用也不一定代表当前窗口已经重新挂载。

运行下面的脚本也会生成适用于当前源码目录的指令：

```powershell
pwsh -File .\scripts\install.ps1 -Profile desktop
```

该模式只打印指令，不修改 desktop profile，也不启动客户端。安装后需在真实桌面窗口检查浮窗；本机验收记录见 [VALIDATION.md](VALIDATION.md)。如果客户端没有可用的 `plugin_manager`，需要先解决宿主能力，不能用 `--profile web` 代替桌面安装。

## DSH Web

在源码根目录打开 PowerShell。先预览，再通过官方 CLI 安装本地链接：

```powershell
pwsh -File .\scripts\install.ps1 -Profile web -WhatIf
pwsh -File .\scripts\install.ps1 -Profile web
```

脚本会自动检测 Node.js，以及 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`；未设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。本机 DSH 未加入 PATH 时，这个方式仍可使用。也可以显式指定入口：

```powershell
$cliPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js'
pwsh -File .\scripts\install.ps1 -Profile web -DshCliPath $cliPath
```

脚本实际调用的是官方命令的等价形式：

```powershell
dsh plugin --profile web add 'link:D:\plugins\dsh-tongji-usage-widget'
```

Node.js 参数以数组传递，带空格和括号的目录作为一个完整参数处理。脚本仅管理这个包：同目录链接已安装并启用时直接结束；检测到其他来源时停止，保留当前安装。若链接已存在但被禁用，请在对应 Web 会话中用 `plugin_manager set_bundle` 启用。

安装完成后重启 DSH Web，再刷新浏览器。后端代码变化需要重启宿主；前端代码变化后刷新页面。`link:` 安装后不要移动或重命名源码目录。

## 导入登录令牌

当前插件与浏览器助手版本均为 0.2.4，推荐使用浏览器助手自动更新。同一个扩展目录 `browser-extension` 可用于 Edge 和 Chrome：Edge 打开 `edge://extensions`，Chrome 打开 `chrome://extensions`，启用开发者模式并加载已解压的扩展程序，再输入浮窗中“连接浏览器助手”生成的连接码。具体步骤见 [README 自动更新登录](README.md#自动更新登录020)。助手不读取浏览器 Cookie 数据库、密码管理器或其它网站，只通过学校正常页面重新登录。

首次改用 Edge 时，先在 Edge 完成同济 AI 平台的学校登录；两个浏览器的学校登录状态互不共享。当前仅支持一个助手连接，最后一次配对的浏览器负责续期；切换浏览器会使原浏览器的旧连接失效，原浏览器再次使用时需重新配对。

0.2.3 启用并配对后，每12小时尝试更新登录，浏览器助手启动时也会请求更新。如果 DSH 尚未打开，启动通知会在重连后补发；MV3 后台进程唤醒不算浏览器重启。约30秒的连接检查不会重复续期，最近5分钟成功更新后也会避免反复打开登录页。学校要求重新验证时，仍需在学校页面完成。

升级到 0.2.3 或 0.2.4 后，已经安装 Chrome 助手的用户需要在 `chrome://extensions` 点击“重新加载”，保留原加载目录即可保留配对。已安装的 Edge 助手在 `edge://extensions` 同样重新加载。无需先移除扩展。

下面是备用的手动导入方式。

安装脚本不读取或传递 `access_token`。本插件默认读取 `%USERPROFILE%\.config\tongji-ai-usage\credentials.json` 中的本机凭据；已配置且未过期时可以直接刷新。需要更新时，在源码目录的本机交互式终端执行：

```powershell
node scripts/auth.mjs set-token
```

按照提示复制同济 AI 平台登录后的 `access_token`，只粘贴到该终端的隐藏输入中。完成后回到浮窗手动刷新。令牌过期后重新登录平台并更新。不要把令牌放进命令行参数或聊天。具体凭据存储、指标口径与异常状态见根目录 README。

## 卸载

桌面端先通过内置 `plugin_manager` 列表核对包名和来源，再执行：

```json
{"action":"remove_bundle","target":"dsh-tongji-usage-widget"}
```

也可运行 `pwsh -File .\scripts\uninstall.ps1 -Profile desktop` 查看指令。

Web 本地链接安装使用：

```powershell
pwsh -File .\scripts\uninstall.ps1 -Profile web -WhatIf
pwsh -File .\scripts\uninstall.ps1 -Profile web
```

卸载脚本只移除从当前目录安装的 Web 链接；已不存在时直接结束，遇到其他来源时停止。卸载后重启宿主、刷新页面。脚本不删除源码、保存的令牌或用户设置。若确实需要清除本机登录凭据，可执行 `node scripts/auth.mjs clear`；如果其他本机工具也读取同一凭据文件，它们也会失去这份凭据。

两个脚本均支持 `-Help`。它们不直接编辑宿主的 profile 清单，也不删除配置目录。

浏览器登录助手需要在对应浏览器中单独移除：Edge 使用 `edge://extensions`，Chrome 使用 `chrome://extensions`。卸载 DSH bundle 不会卸载浏览器扩展。若只想暂停自动登录，可以先在浮窗设置中停用自动更新。

## 接入依据

悬浮窗的 Web/desktop 双注入方式参考 [DeepSeek Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，核对版本为 `0.4.2`、commit `5247dd6813d6e4430728f39ccc63d43cda046022`。桌面端安装方式同时核对了本机官方 CLI 与 `plugin_manager` 实现。插件使用自己的积分卡片，不包含参考项目的人物图片、角色或音效。
