# 同济 AI 积分浮窗 · DSH

用于 DeepSeek Harness 网页端和官方桌面端的功能试验版。右下角显示同济大学 AI 平台的积分与实际用量；使用中性几何图标，不使用 DSH 娘、人物图片或音效。浮窗位于 DSH 页面内，不是全桌面置顶窗口。

当前插件与浏览器助手版本均为 **0.2.3**，支持 Edge 和 Chrome。

本仓库发布 DSH 插件及配套的浏览器登录助手。原 Qoder 插件是独立项目，未包含在本仓库中。

## 开始使用

完整安装与卸载方式见 [INSTALL.md](INSTALL.md)。本项目采用 [MIT 许可证](LICENSE)。

先克隆项目，例如保存到 `D:\plugins\dsh-tongji-usage-widget`：

```powershell
git clone https://github.com/KimBrine/dsh-tongji-usage-widget.git D:\plugins\dsh-tongji-usage-widget
cd D:\plugins\dsh-tongji-usage-widget
```

官方桌面版：在 DSH 会话中让内置 `plugin_manager` 安装本地 bundle，目标为（请替换为你的实际绝对路径）：

```text
link:D:\plugins\dsh-tongji-usage-widget
```

工具参数：

```json
{"action":"install_bundle","target":"link:D:\\plugins\\dsh-tongji-usage-widget","enabled":true}
```

安装后完全退出 DSH 并重新打开，在聊天页面查看右下角。当前官方 CLI 不支持 `--profile desktop`；`--profile web` 只作用于网页版。

网页版在本目录执行：

```powershell
pwsh -File .\scripts\install.ps1 -Profile web
```

## 登录

### 自动更新登录（0.2.0）

启用并连接浏览器助手后，DSH **每12小时尝试更新登录，浏览器助手启动时也会请求更新**。助手在自己创建的标签页中点击网站原有的统一认证入口，获得新令牌后交给本机后端。后端通过平台 `/auth/me` 验证真实性和账号一致性，再原子替换本机凭据；积分查询随后自动恢复。0.2.2 起，同一个助手文件夹可在 Edge 或 Chrome 中加载；0.2.3 改用上述续期时机。

一次性设置：

1. 更新代码后，完全退出并重新打开 DSH。
2. 选择用于续期的浏览器：Edge 打开 `edge://extensions`，Chrome 打开 `chrome://extensions`。启用开发者模式，点“加载已解压的扩展程序”，选择本项目的同一个 **browser-extension** 文件夹。
3. 首次使用 Edge 时，先在 **Edge** 中打开同济 AI 平台并完成学校登录。Edge 与 Chrome 的学校登录状态各自独立，在 Chrome 登录不会让 Edge 自动获得学校登录状态。
4. 在 DSH 积分浮窗的设置中点“连接浏览器助手”，取得 8 位连接码。
5. 打开所选浏览器工具栏中的“同济 AI 登录助手”，输入连接码并连接。首次连接会自动试运行一次登录更新。

之后无需手动复制令牌。学校登录失效或需要验证时，助手保留它创建的登录页；在助手中点“继续学校登录”完成认证即可。所配对的浏览器和 DSH 需保持运行；浮窗会按实际配对显示 Edge 或 Chrome，并在助手离线时提示。也可在浮窗中立即更新或停用。

浏览器先启动、DSH 尚未运行时，助手会保留本次启动通知，连接 DSH 后补发。同一次浏览器会话的启动通知会去重；MV3 后台进程从休眠中唤醒不算浏览器重新启动。后台约每30秒检查连接与待办任务，这不会每30秒重新登录。最近5分钟已成功更新时，会跳过重复的自动续期请求，避免频繁重开浏览器反复打开登录页。

12小时从当前令牌的签发时间计算。自动更新失败时保留旧凭据，间隔30分钟再尝试；需要学校验证时会保留助手登录页，供你继续完成认证。

当前一次只连接一个助手，**最后一次配对的浏览器负责续期**。切换到另一浏览器时，重新生成连接码并在另一浏览器配对；原浏览器的旧连接随即失效，再使用时需要重新配对。

助手使用 `storage` 保存本机配对信息、`alarms` 定时检查任务；网站访问权限仅覆盖 `https://agi.tongji.edu.cn/*` 和本机 `http://127.0.0.1/*`，不申请 Cookie、历史、debugger 或全部标签页读取权限。只有与一次更新任务关联、由助手创建的同济 AI 标签页会读取令牌；普通浏览标签不会读取。扩展仅保存本机连接密钥，不保存网站令牌。连接密钥与网站凭据在后端分别保存为当前用户受限文件，禁止上传。

这是通过平台正常重新登录取得新令牌，不能延长旧 JWT 或保证永久登录。完整自动流程的实机验收结果见 [VALIDATION.md](VALIDATION.md)。浏览器助手说明见 [browser-extension/README.md](browser-extension/README.md)。

### 手动导入（备用）

插件默认将登录凭据保存在当前用户目录：

```text
%USERPROFILE%\.config\tongji-ai-usage\credentials.json
```

已保存有效令牌时无需重新绑定。过期或未配置时，可在浮窗展开备用的手动导入说明，在本机交互式终端执行：

```powershell
node scripts/auth.mjs set-token
```

登录 [同济 AI 平台](https://agi.tongji.edu.cn/models/hub)，在网页开发者工具控制台执行：

```js
copy(sessionStorage.getItem('access_token'))
```

只把令牌粘贴到本机导入终端的隐藏输入中，按回车保存，再点击浮窗刷新。不要把令牌发进聊天或作为命令行参数。网站登录 `access_token` 与模型 API Key 不同。

`node scripts/auth.mjs status` 只显示是否已配置；`clear` 删除上述本机凭据文件。如果其他本机工具也读取同一文件，它们也会失去这份凭据。环境变量 `TONGJI_AI_ACCESS_TOKEN`、`TONGJI_AI_COOKIE` 优先于文件；DSH 进程需继承该变量。Cookie 是兼容后备，不保证平台接受。

后端只向 `https://agi.tongji.edu.cn` 发起 GET 请求，禁止重定向。令牌不发给浮窗，不写入项目目录或日志；插件不额外写入浏览器或扩展存储，平台自身仍使用 sessionStorage 保存登录态。Windows 导入时限制凭据文件 ACL；其他系统使用 0600 权限。

## 操作与口径

- 卡片显示套餐本周期剩余、进度、下次重置和今日积分消耗。无法读取套餐余额时，主标题明确改为“账户总积分”。
- 拖动标题栏移动，接近四边自动吸附；方向键也可移动，Shift 加速。收起为积分胶囊，点击展开。设置中可复位位置。
- 明细可选今日、昨日、近 7 天，显示账户积分、周期已用/总额、实际 Token、调用次数和分模型用量。
- 默认每 60 秒刷新，可手动刷新；隐藏页面暂停轮询。宿主共享缓存与并发请求，避免多个窗口重复查询。监控不调用模型，不消耗模型 Token。
- 低积分阈值默认 100；每日积分预算默认关闭。设置填 0 可关闭对应提醒。提醒在卡片或胶囊内显示，不发送系统通知。
- 网络失败时保留最后成功值并标“更新失败”；登录失效时清除旧值，已连接助手时请求自动更新；部分统计缺失显示未知，不补成零。

所有统计是**同济平台账户范围**，包含该账户下所有客户端的使用。这里不按 DSH 单轮会话估算扣费。今日/昨日/近 7 天不等同于套餐重置周期。

## 插件新版本提醒（0.2.1）

启动 DSH 时自动检查一次，此后每 6 小时检查 GitHub 仓库 `main` 分支 `package.json` 中的版本号。检测到较新的正式版本时，卡片显示“发现新版本”和查看入口；收起后的胶囊也会显示“新”标记。设置中可以查看当前版本、检查时间，或点“检查更新”（连续手动检查间隔至少 60 秒）。

检测失败会明确显示失败原因，后台约 15 分钟后重试；已发现的新版本提醒会保留。版本检查不依赖同济登录，也不向 GitHub 发送同济令牌或积分数据。它只提醒，不自动下载或执行更新。

本地 `link:` 安装的更新方法：在项目目录执行 `git pull --ff-only`，完全退出 DSH 后重新打开；若提示本机修改或分支冲突，先保留改动再处理。使用压缩包安装时，将新版解压到同一插件目录后重启。

**0.2.3 同时更新了浏览器助手。** 已安装 Chrome 助手的用户，需要在 `chrome://extensions` 中点击该助手的“重新加载”；加载来源目录不变时会保留已有配对，无需移除扩展。Edge 中已安装的助手同样在 `edge://extensions` 重新加载。此后仅在助手代码有更新时需要重新加载；若要从 Chrome 改用 Edge，仍需按上面的步骤在 Edge 首次登录并重新配对。

接口中的 `input_tokens` 是未缓存输入，`cached_tokens` 是缓存输入；加上 `output_tokens` 形成文本 Token 总量。优先使用平台 `text_tokens` 汇总，不再额外重复累加。`tokens_per_point` 仅用于接口报告中的估算预算，不能视为任意模型的真实可用 Token。

位置、收起状态、提醒阈值保存在当前浏览器的 localStorage；积分报告只在内存中，重新打开会查询。账户切换或凭据删除会清除后端缓存。

## 本机预览与验证

无需额外 npm 依赖，运行环境 Node.js 20+：

```powershell
npm test
node scripts/usage.mjs today
npm run preview
```

预览地址默认 `http://127.0.0.1:17941/`，使用真实本机凭据；仅绑定回环地址。按 Ctrl+C 停止。

```powershell
node scripts/preview.mjs --demo
node scripts/preview.mjs --port 17942
node scripts/preview.mjs --with-login --port 17942
node scripts/preview.mjs --demo --demo-update --port 17943
```

`--demo` 使用明确标注的模拟数据，不代表真实账户；`--demo-update` 仅与 `--demo` 同用，演示模拟的新版本提醒。`--with-login` 为独立预览启动本机登录桥接服务，不应与同一台电脑上已启用自动登录的 DSH 重复运行。不含任何凭据的安装包可用 `npm pack` 生成。

接入核对基于本机 DSH `0.1.7-rc.2`、官方桌面 `0.2.2-rc.1`。自动测试覆盖接口口径、异常、凭据变化、缓存竞态、HTTP 边界与双端注入。本机 desktop profile 已配置本地 link bundle；0.2.0 自动登录的完整实机验收进度见 [VALIDATION.md](VALIDATION.md)。

## 文件与来源

`lib/api.js` 查询与归一化，`lib/service.js` 脱敏缓存，`lib/index.js` 宿主接入，`lib/widget.js` Shadow DOM 浮窗；`scripts/` 提供本机登录、预览、安装和卸载工具。

DSH 双端注入参考 [DeepSeek Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，核对 commit `5247dd6813d6e4430728f39ccc63d43cda046022`（v0.4.2）。署名与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
