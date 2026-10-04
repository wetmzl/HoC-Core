import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const androidRoot = resolve(repositoryRoot, "android");
const gradle = resolve(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");

function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const candidates = process.platform === "darwin"
    ? [
        "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
        "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
      ]
    : process.platform === "win32"
      ? ["C:\\Program Files\\Android\\Android Studio\\jbr"]
      : ["/opt/android-studio/jbr"];
  return candidates.find((candidate) => existsSync(candidate));
}

if (process.argv[2] !== "build") throw new Error("用法：node scripts/android.mjs build");
if (!existsSync(gradle)) throw new Error("Android 工程不存在，请先运行 npm run android:sync。");
const detectedJavaHome = javaHome();
if (!detectedJavaHome) throw new Error("找不到 JDK；请设置 JAVA_HOME 或使用 Android Studio 自带 JBR。");

const result = spawnSync(gradle, ["assembleDebug"], {
  cwd: androidRoot,
  env: { ...process.env, JAVA_HOME: detectedJavaHome },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
