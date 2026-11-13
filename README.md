# 同济 AI 积分浮窗 · DSH

用于 DeepSeek Harness 网页端和官方桌面端的功能试验版。右下角显示同济大学 AI 平台的积分与实际用量；使用中性几何图标，不使用 DSH 娘、人物图片或音效。浮窗位于 DSH 页面内，不是全桌面置顶窗口。

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

默认读取本机凭据；使用过早期 Qoder 版的用户可复用同一份文件：

```text
%USERPROFILE%\.config\tongji-ai-usage\credentials.json
```

已保存有效令牌时无需重新绑定。过期或未配置时，浮窗显示导入命令，在本机交互式终端执行：

```powershell
node scripts/auth.mjs set-token
```

登录 [同济 AI 平台](https://agi.tongji.edu.cn/models/hub)，在网页开发者工具控制台执行：

```js
copy(sessionStorage.getItem('access_token'))
```

只把令牌粘贴到本机导入终端的隐藏输入中，按回车保存，再点击浮窗刷新。不要把令牌发进聊天或作为命令行参数。网站登录 `access_token` 与模型 API Key 不同。

`node scripts/auth.mjs status` 只显示是否已配置；`clear` 删除共享凭据，**也会影响 Qoder 插件**。环境变量 `TONGJI_AI_ACCESS_TOKEN`、`TONGJI_AI_COOKIE` 优先于文件；DSH 进程需继承该变量。Cookie 是兼容后备，不保证平台接受。

后端只向 `https://agi.tongji.edu.cn` 发起 GET 请求，禁止重定向。令牌不发给浮窗，不写入项目目录、浏览器存储或日志。Windows 导入时限制凭据文件 ACL；其他系统使用 0600 权限。

## 操作与口径

- 卡片显示套餐本周期剩余、进度、下次重置和今日积分消耗。无法读取套餐余额时，主标题明确改为“账户总积分”。
- 拖动标题栏移动，接近四边自动吸附；方向键也可移动，Shift 加速。收起为积分胶囊，点击展开。设置中可复位位置。
- 明细可选今日、昨日、近 7 天，显示账户积分、周期已用/总额、实际 Token、调用次数和分模型用量。
- 默认每 60 秒刷新，可手动刷新；隐藏页面暂停轮询。宿主共享缓存与并发请求，避免多个窗口重复查询。监控不调用模型，不消耗模型 Token。
- 低积分阈值默认 100；每日积分预算默认关闭。设置填 0 可关闭对应提醒。提醒在卡片或胶囊内显示，不发送系统通知。
- 网络失败时保留最后成功值并标“更新失败”；登录失效时清除旧值、提示重新导入；部分统计缺失显示未知，不补成零。

所有统计是**同济平台账户范围**，包含 Qoder、DSH 和其他客户端的使用。这里不按 DSH 单轮会话估算扣费。今日/昨日/近 7 天不等同于套餐重置周期。

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
```

`--demo` 使用明确标注的模拟数据，不代表真实账户。不含任何凭据的安装包可用 `npm pack` 生成。

接入核对基于本机 DSH `0.1.7-rc.2`、官方桌面 `0.2.2-rc.1`。自动测试覆盖接口口径、异常、凭据变化、缓存竞态、HTTP 边界与双端注入。独立预览和运行时 smoke 不能替代安装后的真实 DSH 桌面窗口验收；当前环境尚未在桌面会话完成安装。

## 文件与来源

`lib/api.js` 查询与归一化，`lib/service.js` 脱敏缓存，`lib/index.js` 宿主接入，`lib/widget.js` Shadow DOM 浮窗；`scripts/` 提供本机登录、预览、安装和卸载工具。

同济接口及凭据文件约定延续本项目的早期 Qoder 版本。DSH 双端注入参考 [DeepSeek Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，核对 commit `5247dd6813d6e4430728f39ccc63d43cda046022`（v0.4.2）。署名与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
