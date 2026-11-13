# 验证记录 · 2026-11-13

交付版本：0.1.0。Node.js 24.20.0；本机 DSH WebServer 0.1.7-rc.2、Cordis 4.0.4。

- `npm test`：33 项通过，0 失败。使用模拟数据验证接口口径、部分错误、缺失字段、凭据变化、缓存竞态、HTTP 边界及前端卸载。
- `node scripts/smoke-dsh.mjs`：通过。使用本机已安装的真实 Cordis / WebServer，在独立临时 Context 与随机回环端口加载插件，验证双端注入、HTTP 路由、拒绝未授权请求与卸载清理。该 smoke 不写用户 profile，不请求校园接口。
- `node scripts/usage.mjs today`：成功使用原共享凭据请求同济真实接口；未输出令牌，未调用模型。实时账户数据未写入源码或安装包。
- 独立浏览器预览：正常显示余额与明细；模拟数据预算提醒触发；真实账户低余额提醒；收起胶囊；鼠标拖动到左侧吸附；设置保存与恢复。预览截图与安装包分开放在 artifacts 目录。
- 安装脚本：PowerShell 语法、Help、desktop 指令生成、web `-WhatIf` 通过。未实际修改任何 DSH profile。

尚未完成：通过官方 DSH 桌面会话内置 `plugin_manager` 安装，并在真实桌面窗口检查最终挂载。当前官方 CLI 拒绝管理 desktop profile；安装指令见 INSTALL.md。

自动测试、独立预览和运行时集成验证仅证明各自覆盖的行为，不代表真实 DSH 桌面窗口已经验收。
