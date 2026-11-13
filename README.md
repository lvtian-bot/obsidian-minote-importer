# Minote Importer

将[小米笔记](https://i.mi.com/note/h5#/)单向导入 Obsidian，保存为 Markdown 文件。首次导入会读取全部笔记，后续默认只更新有变化的笔记。

## 功能
- 按文件夹存放笔记，同时保留笔记的创建时间和修改时间
- 自动下载笔记中的图片，并将引用方式替换成 Markdown 格式
- 替换 `<background>` 标签为 `<span>` 标签，以支持文字高亮
- 去除多余的 `<text>`、`<new-format/>` 标签
- 兼容旧版本无标题笔记（根据首行内容和笔记 ID 自动生成标题）
- 支持全量导入，覆盖更新全部笔记
- 支持非中国区的小米云服务

## 安装

1. 在[本项目的 Releases](https://github.com/lvtian-bot/obsidian-minote-importer/releases)下载发行压缩包。
2. 将压缩包内的 `minote-importer` 文件夹放入笔记库的 `.obsidian/plugins/` 目录。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用「Minote Importer」。

如需从源码构建，在仓库目录执行 `npm ci` 和 `npm run build`，将生成的 `main.js` 与 `manifest.json`、`LICENSE` 一起放入 `.obsidian/plugins/minote-importer/`。

## 设置

1. 在「Minote Importer」的插件设置中点击「打开小米云网页」，在独立 Chrome 或 Edge 窗口里登录。若小米要求设备保护码，请在小米网页完成验证。
2. 完成验证后，等 Obsidian 显示「小米云已登录」。如果网页已能打开笔记正文，插件仍显示等待，请保持网页打开，点「确认已完成验证」。导入加密笔记期间请保持网页打开。
3. 选择笔记保存位置，默认使用笔记库内的 `minote-importer` 文件夹。
4. 登录过期后，重新打开小米云网页并确认登录。点击「退出」可清除此笔记库的插件登录状态和专用浏览器登录数据。

插件使用独立的浏览器配置目录，首次使用需要登录。高级设置可指定浏览器路径。

## 使用

- **增量导入**：点击左侧栏的云下载图标，或在命令面板中执行「导入小米笔记」。
- **全量导入**：右键点击左侧栏的云下载图标，或在命令面板中执行「全量导入小米笔记」。

导入会覆盖对应的 Markdown 文件，请将需要手动编辑的内容保存在导入目录之外。

插件设置中的「导入状态」会显示保存位置、当前进度和上一次结果。已写入正文但图片待补齐的笔记会单独提示，下一次导入会重试。

加密笔记由完成验证的小米云网页解密。如果网页暂时无法解密，插件会提示待导入数量并保留已有文件，完成验证后可以重试。升级后，增量导入会重新检查旧版本写入的密文文件。

## 已知问题

- 登录会话可能过期，可在插件设置中手动刷新。
- 遇到网络连接问题时可重试。增量导入会跳过已导入且未变化的笔记。
- 小米云端删除的笔记会保留在本地，如需清理，可手动删除对应文件。

## 来源与许可

本项目由 lvtian-bot 独立维护，最初基于 Emac Shen 的 [obsidian-minote-plugin](https://github.com/emac/obsidian-minote-plugin)。外部浏览器登录方案来自 [Halo0sama 的修复提交](https://github.com/Halo0sama/obsidian-minote-plugin/commit/4001a4f4f2f823312ed7c4336caa62510056f654)。原作者版权声明及 MIT 许可见 [LICENSE](LICENSE)。

## 感谢
- [Weread Plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin)
- [minote-Obsidian](https://github.com/yulittlemoon/minote-Obsidian)
- [Obsidian Plugin Developer Docs](https://marcus.se.net/obsidian-plugin-docs/)
