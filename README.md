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

1. 在「Minote Importer」的插件设置中点击「登录」，在弹出的窗口中扫码。
2. 选择笔记保存位置，默认使用笔记库内的 `minote-importer` 文件夹。
3. 登录过期后可在设置中刷新登录会话。需要退出时，点击「注销」，在弹出窗口的头像菜单中选择「退出」。

插件设置和登录会话独立保存，首次使用需要登录。

## 使用

- **增量导入**：点击左侧栏的云下载图标，或在命令面板中执行「导入小米笔记」。
- **全量导入**：右键点击左侧栏的云下载图标，或在命令面板中执行「全量导入小米笔记」。

导入会覆盖对应的 Markdown 文件，请将需要手动编辑的内容保存在导入目录之外。

## 已知问题

- 扫码后跳到系统浏览器时，插件可能无法识别登录成功。
- 登录会话可能过期，可在插件设置中手动刷新。
- 遇到网络连接问题时可重试。增量导入会跳过已导入且未变化的笔记。
- 小米云端删除的笔记会保留在本地，如需清理，可手动删除对应文件。

## 来源与许可

本项目由 lvtian-bot 独立维护，最初基于 Emac Shen 的 [obsidian-minote-plugin](https://github.com/emac/obsidian-minote-plugin)。原作者版权声明及 MIT 许可见 [LICENSE](LICENSE)。

## 感谢
- [Weread Plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin)
- [minote-Obsidian](https://github.com/yulittlemoon/minote-Obsidian)
- [Obsidian Plugin Developer Docs](https://marcus.se.net/obsidian-plugin-docs/)
