
原版 [Cline](https://github.com/cline/cline)  star ⭐️

中文译版 [cline-chinese](https://github.com/HybridTalentComputing/cline-chinese) star ⭐️

# 修改说明

此项目添加 devtunnel 服务，旨在方便前端开发时，让产品、UI、测试验收时，发现问题可以直接通过 chrome  extension LLM 交互直接修改源码。

# chrome  extension

[dev tunnel](https://github.com/WtecHtec/DevTunnel/tree/main/chrome-extension)

# vite plugin source

[vite plugin source](https://github.com/WtecHtec/DevTunnel/tree/main/vite-plugin)

在使用 vite 执行开发时，需要配置 vite plugin， vite plugin source 是为了注文件 sourcemap 的内容。（文件路径 、 源码所在行）

# 使用方法

打开 vscode 安装当前 修改的 Cline, 开启 DevTunnel 服务，会执行一个http 服务。

在页面访问的时候携带这个 服务链接，如下：

```
http://localhost:5173?devtunnel=http://localhost:5273

```

打开 chrome  dev tools 开发模式（F2）, 打开 Dev Tunnel , 选择要修改的元素，并且说明修改的需求，点击发送即可。   

[Dev tunnel 演示～](https://www.bilibili.com/video/BV1ndkKBtEiT/?share_source=copy_web&vd_source=b38d30b9afa4cdb7d6538c4c2978a4c8)

此项目为学习使用～