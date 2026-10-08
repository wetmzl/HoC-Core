# 基本构建

使用 Node.js 22，从本仓库根目录执行：

```bash
npm ci
npm test
npm run build
npm run preview
```

Web/PWA 静态产物位于 `dist/`，可部署到静态托管服务。涉及交互时在本机运行 `npm run test:e2e`。构建不包含托管平台配置或站点统计标识。

## Android

安装 JDK 21、Android SDK，并设置本机 SDK 路径。构建脚本优先使用 `JAVA_HOME`，也可探测 Homebrew OpenJDK 21 或 Android Studio JBR。

```bash
npm run build:android:web  # 仅构建 Android Web 资源
npm run android:sync      # 同步 Capacitor 工程
npm run android:build     # 默认生成 Release APK
npm run android:build:debug # 仅显式调试、冒烟测试使用
npm run android:open      # 用 Android Studio 打开工程
```

Release APK 位于 `android/app/build/outputs/apk/release/app-release-unsigned.apk`，须用外部保管的密钥签名后安装；不将签名凭据提交到仓库。显式 Debug APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Android 版本名与主菜单共用 `package.json` 的 `version`；数字 `versionCode` 独立用于 Android 更新排序。Release 关闭应用调试及 WebView 远程调试，生产 Web 构建不提供 URL 调试面板。

同步生成的 `android/app/src/main/assets/public/` 不能直接编辑。Android Web 构建不生成 PWA Service Worker。APK 编译不等于真机运行验收，存储恢复、前后台切换和触觉反馈须在设备上验证。

修改内嵌包后运行 `npm run packages:sync`，构建时通过 `packages:check` 校验完整性。已有非空用户内容仓库不会随应用升级自动覆盖为新内嵌包，包更新与存档变化须遵循现有安装和迁移流程。
