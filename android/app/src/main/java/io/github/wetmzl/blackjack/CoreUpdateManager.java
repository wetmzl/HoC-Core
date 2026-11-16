package io.github.wetmzl.blackjack;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** All network and APK inspection runs on the plugin's worker, never the UI thread. */
final class CoreUpdateManager {
    private static final class ReleaseApiUnavailable extends IOException {
        ReleaseApiUnavailable(String message) { super(message); }
        ReleaseApiUnavailable(IOException cause) { super("无法连接 GitHub 更新接口。", cause); }
    }
    interface Progress { void update(String phase, long completed, long total); }
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    private final Context context;
    private final File directory;
    private final SharedPreferences preferences;
    private final ConnectionFactory connections;
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private volatile HttpURLConnection activeConnection;
    private CoreUpdateRelease candidate;

    CoreUpdateManager(Context context) {
        this(context, url -> (HttpURLConnection) url.openConnection());
    }
    // Injected transport is only used by Android tests; the bridge cannot change the source.
    CoreUpdateManager(Context context, ConnectionFactory connections) {
        this.context = context;
        this.connections = connections;
        directory = new File(context.getCacheDir(), "core-updates");
        preferences = context.getSharedPreferences("core-updates", Context.MODE_PRIVATE);
        // An interrupted process cannot resume a partial file without a new integrity check.
        new File(directory, "download.part").delete();
    }

    boolean supported() { return BuildConfig.STABLE_UPDATES_ENABLED && BuildConfig.UPDATE_APPLICATION_ID.equals(context.getPackageName()); }
    PackageInfo installed() throws PackageManager.NameNotFoundException { return context.getPackageManager().getPackageInfo(context.getPackageName(), 0); }
    static long code(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }

    JSONObject status() throws Exception { return status("stable"); }
    JSONObject status(String channel) throws Exception {
        CoreUpdateRelease.channel(channel);
        PackageInfo current = installed();
        JSONObject result = new JSONObject().put("supported", supported()).put("currentVersion", current.versionName)
            .put("currentVersionCode", code(current)).put("canInstall", canInstall());
        JSONObject ready = ready(channel);
        if (ready != null) result.put("ready", ready);
        return result;
    }
    boolean canInstall() { return Build.VERSION.SDK_INT < 26 || context.getPackageManager().canRequestPackageInstalls(); }
    private void requireSupported() throws IOException { if (!supported()) throw new IOException("此安装包使用独立应用身份，不适用公开版本更新。"); }

    JSONObject check() throws Exception { return check("stable"); }
    JSONObject check(String channel) throws Exception {
        requireSupported(); CoreUpdateRelease.channel(channel);
        candidate = null;
        JSONObject selected = null;
        boolean fromPages = false;
        try {
            selected = CoreUpdateChunks.channel(CoreUpdateDownloader.pagesJson((address, headers) -> open(address, false, "GET", headers),
                CoreUpdateChunks.ORIGIN + "/channels/" + channel + ".json"), channel);
            fromPages = true;
        } catch (CoreUpdateChunks.Unavailable unavailable) { }
        if (!fromPages) {
            try { selected = apiRelease(channel); }
            catch (ReleaseApiUnavailable error) { selected = webRelease(channel); }
        }
        if (selected == null || !CoreUpdateRelease.eligible(selected, channel)) return new JSONObject().put("state", "no-release");
        candidate = fromPages ? CoreUpdateRelease.parsePages(selected, installed().versionName, channel)
            : CoreUpdateRelease.parse(selected, installed().versionName, channel);
        return candidate == null ? new JSONObject().put("state", "current")
            : new JSONObject().put("state", "available").put("release", candidate.json());
    }
    private JSONObject apiRelease(String channel) throws Exception {
        JSONObject selected = null;
        if ("stable".equals(channel)) {
            String body = readRelease(CoreUpdateRelease.LATEST_URL);
            if (body != null) selected = new JSONObject(body);
        } else {
            for (int page = 1; page <= 10; page++) {
                String body = readRelease(CoreUpdateRelease.RELEASES_URL + "?per_page=100&page=" + page);
                JSONArray releases = body == null ? new JSONArray() : new JSONArray(body);
                for (int i = 0; i < releases.length(); i++) {
                    JSONObject release = releases.getJSONObject(i);
                    if (CoreUpdateRelease.eligible(release, channel) && (selected == null || CoreUpdateRelease.compare(release.getString("tag_name"), selected.getString("tag_name")) > 0)) selected = release;
                }
                if (releases.length() < 100) break;
                if (page == 10) throw new IOException("发布列表过长，暂时无法确认最新版，请稍后重试。");
            }
        }
        return selected;
    }
    private String readRelease(String url) throws Exception {
        HttpURLConnection connection;
        try { connection = open(url, true); }
        catch (java.net.SocketTimeoutException | java.net.UnknownHostException | java.net.SocketException | javax.net.ssl.SSLException error) { throw new ReleaseApiUnavailable(error); }
        try {
            int status = connection.getResponseCode();
            if (status == 404) return null;
            if (status == 403 || status == 429) throw new ReleaseApiUnavailable("GitHub 暂时限制了检查频率，请稍后再试。");
            if (status >= 500) throw new ReleaseApiUnavailable("GitHub 更新接口暂不可用。");
            if (status != 200) throw new IOException("无法检查更新（HTTP " + status + "），请稍后重试。");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 4 * 1024 * 1024) throw new IOException("更新信息过大，已停止检查。");
                    output.write(buffer, 0, count);
                }
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (java.net.SocketTimeoutException | java.net.UnknownHostException | java.net.SocketException | javax.net.ssl.SSLException | EOFException error) {
            throw new ReleaseApiUnavailable(error);
        } finally { connection.disconnect(); }
    }

    private String webText(String url, int limit) throws Exception {
        HttpURLConnection connection = open(url, false);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("备用更新检查未完成（HTTP " + connection.getResponseCode() + "）。");
            return readText(connection, limit);
        } finally { activeConnection = null; connection.disconnect(); }
    }
    private String readText(HttpURLConnection connection, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (InputStream input = connection.getInputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > limit) throw new IOException("备用更新信息过大，已停止检查。");
                output.write(buffer, 0, count);
            }
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }
    private JSONObject webRelease(String channel) throws Exception {
        JSONObject selected = null;
        if ("stable".equals(channel)) {
            HttpURLConnection connection = open(CoreUpdateWeb.RELEASES_URL + "/latest", false);
            try {
                int status = connection.getResponseCode();
                String url = connection.getURL().toString();
                if (status == 404 || (status == 200 && CoreUpdateWeb.RELEASES_URL.equals(url))) return null;
                String prefix = CoreUpdateWeb.RELEASES_URL + "/tag/";
                String tag = url.startsWith(prefix) ? url.substring(prefix.length()) : "";
                if (status != 200 || !CoreUpdateRelease.valid(tag) || tag.contains("+") || CoreUpdateRelease.prerelease(tag)) throw new IOException("GitHub 稳定版网页信息无效。");
                selected = CoreUpdateWeb.release(readText(connection, 4 * 1024 * 1024), tag);
                if (!CoreUpdateRelease.eligible(selected, channel)) throw new IOException("GitHub 稳定版网页信息无效。");
            } finally { activeConnection = null; connection.disconnect(); }
        } else {
            for (int page = 1; page <= 10; page++) {
                JSONArray releases = CoreUpdateWeb.index(webText(CoreUpdateWeb.RELEASES_URL + "?page=" + page, 4 * 1024 * 1024), page);
                for (int i = 0; i < releases.length(); i++) {
                    JSONObject release = releases.getJSONObject(i);
                    if (CoreUpdateRelease.eligible(release, channel) && (selected == null || CoreUpdateRelease.compare(release.getString("tag_name"), selected.getString("tag_name")) > 0)) selected = release;
                }
                if (releases.length() == 0) break;
                if (page == 10) throw new IOException("网页发布列表过长，暂时无法确认最新版。");
            }
            if (selected != null) selected = CoreUpdateWeb.release(webText(CoreUpdateWeb.RELEASES_URL + "/tag/" + selected.getString("tag_name"), 4 * 1024 * 1024), selected.getString("tag_name"));
        }
        if (selected == null || !CoreUpdateRelease.newer(selected.getString("tag_name"), installed().versionName, channel)) return selected;
        String tag = selected.getString("tag_name"), version = tag.startsWith("v") ? tag.substring(1) : tag;
        String base = CoreUpdateWeb.RELEASES_URL + "/download/" + tag;
        Map<String, String> sums = CoreUpdateWeb.checksums(webText(base + "/SHA256SUMS", 128 * 1024));
        String name = "HoC-Core-" + version + ".apk", url = base + "/" + name;
        if (!sums.containsKey(name)) throw new IOException("所选版本尚未提供 Android 安装包或校验信息。");
        HttpURLConnection connection = open(url, false, "HEAD");
        long size;
        try {
            size = connection.getContentLengthLong();
            if (connection.getResponseCode() != 200 || size <= 0 || size > CoreUpdateRelease.MAX_APK_BYTES) throw new IOException("无法确认发布安装包的大小或下载地址。");
        } finally { activeConnection = null; connection.disconnect(); }
        JSONObject asset = new JSONObject().put("name", name).put("state", "uploaded").put("size", size)
            .put("digest", "sha256:" + sums.get(name)).put("browser_download_url", url);
        return selected.put("assets", new JSONArray().put(asset));
    }

    String releaseNotes() throws Exception {
        requireSupported();
        HttpURLConnection connection = open("https://github.com/wetmzl/HoC-Core/releases.atom", false);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("无法读取公开发布日志。");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 1024 * 1024) throw new IOException("发布日志过大，已停止读取。");
                    output.write(buffer, 0, count);
                }
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } finally { activeConnection = null; connection.disconnect(); }
    }

    private HttpURLConnection open(String address, boolean api) throws Exception {
        return open(address, api, "GET");
    }
    private HttpURLConnection open(String address, boolean api, String method) throws Exception {
        return open(address, api, method, Collections.emptyMap());
    }
    private HttpURLConnection open(String address, boolean api, String method, Map<String, String> headers) throws Exception {
        URL url = new URL(address);
        boolean pages = url.getHost().equals("hoc-core-updates.pages.dev");
        for (int redirects = 0; redirects <= 5; redirects++) {
            String host = url.getHost();
            boolean allowed = api ? host.equals("api.github.com") : pages ? host.equals("hoc-core-updates.pages.dev")
                : host.equals("github.com") || host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com");
            if (!url.getProtocol().equals("https") || !allowed || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)
                || (pages && (url.getQuery() != null || url.getRef() != null)))
                throw new IOException("更新下载地址不受信任。");
            HttpURLConnection connection = connections.open(url);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(method);
            connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
            connection.setRequestProperty("User-Agent", "HoC-Core-Android-Updater");
            connection.setRequestProperty("Accept-Language", "en-US");
            connection.setRequestProperty("Accept", api ? "application/vnd.github+json" : "*/*");
            for (Map.Entry<String, String> header : headers.entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
            if (!api) activeConnection = connection;
            int response;
            try { response = connection.getResponseCode(); }
            catch (Exception error) { connection.disconnect(); throw error; }
            if (response != 301 && response != 302 && response != 303 && response != 307 && response != 308) return connection;
            if (pages) { connection.disconnect(); throw new IOException("Pages 更新重定向地址不受信任。"); }
            String location = connection.getHeaderField("Location"); connection.disconnect();
            if (location == null) throw new IOException("下载重定向缺少地址。");
            url = new URL(url, location);
        }
        throw new IOException("下载重定向次数过多。");
    }

    void cancel() { cancelled.set(true); HttpURLConnection connection = activeConnection; if (connection != null) connection.disconnect(); }
    private void checkCancelled() throws IOException { if (cancelled.get()) throw new IOException("已取消下载。"); }

    JSONObject download(String tag, Progress progress) throws Exception { return download(tag, "stable", progress); }
    JSONObject download(String tag, String channel, Progress progress) throws Exception {
        CoreUpdateRelease.channel(channel);
        requireSupported();
        CoreUpdateRelease selected = candidate;
        if (selected == null || !selected.tag.equals(tag) || ("stable".equals(channel) && selected.prerelease)) throw new IOException("更新信息已失效，请重新检查。");
        cancelled.set(false);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建更新下载目录。");
        if (directory.getUsableSpace() < selected.bytes * 2 + 16L * 1024 * 1024) throw new IOException("存储空间不足，请清理后重试。");
        File staging = null;
        try {
            staging = CoreUpdateDownloader.download(context, directory, selected,
                (address, headers) -> open(address, false, "GET", headers), this::checkCancelled, progress);
            verifyApk(staging, selected.version);
            checkCancelled();
            File apk = new File(directory, selected.sha256 + ".apk");
            if (CoreUpdateDownloader.valid(apk, selected.bytes, selected.sha256)) staging.delete();
            else if (!staging.renameTo(apk)) throw new IOException("无法保存已验证的安装包。");
            JSONObject receipt = selected.json().put("versionCode", code(archive(apk))).put("file", apk.getName());
            if (!preferences.edit().putString("ready", receipt.toString()).commit()) throw new IOException("无法保存更新状态，已验证文件已保留。");
            return receipt;
        } catch (Exception error) {
            if (cancelled.get()) throw new IOException("已取消下载。");
            throw error;
        } finally { activeConnection = null; if (staging != null) staging.delete(); }
    }

    JSONObject ready() { return ready("stable"); }
    JSONObject ready(String channel) {
        try {
            String raw = preferences.getString("ready", null);
            if (raw == null) return null;
            JSONObject ready = new JSONObject(raw);
            File apk = readyFile(ready);
            if (apk.isFile() && apk.length() == ready.getLong("bytes") && ready.getLong("versionCode") > code(installed())) {
                if ("stable".equals(channel) && (ready.optBoolean("prerelease") || CoreUpdateRelease.prerelease(ready.getString("version")))) return null;
                return ready;
            }
            clearReady();
        } catch (Exception ignored) { clearReady(); }
        return null;
    }
    private File readyFile(JSONObject ready) throws Exception {
        String file = ready.optString("file", "update.apk");
        if (!file.equals("update.apk") && (!ready.getString("sha256").matches("[a-f0-9]{64}") || !file.equals(ready.getString("sha256") + ".apk")))
            throw new IOException("更新文件身份无效。");
        return new File(directory, file);
    }
    private void clearReady() { preferences.edit().remove("ready").apply(); }

    File preparedApk() throws Exception { return preparedApk("stable"); }
    File preparedApk(String channel) throws Exception {
        CoreUpdateRelease.channel(channel);
        requireSupported();
        JSONObject ready = ready(channel);
        if (ready == null) throw new IOException("没有可安装的更新，请重新检查。");
        File apk = readyFile(ready);
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = new FileInputStream(apk)) {
                byte[] buffer = new byte[64 * 1024]; int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            }
            if (!hex(digest.digest()).equals(ready.getString("sha256"))) throw new IOException("下载文件已损坏，请重新下载。");
            verifyApk(apk, ready.getString("version"));
            return apk;
        } catch (Exception error) { clearReady(); throw error; }
    }

    @SuppressWarnings("deprecation")
    private PackageInfo archive(File apk) throws IOException {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (info == null) throw new IOException("下载文件不是有效的 Android 安装包。");
        return info;
    }
    @SuppressWarnings("deprecation")
    void verifyApk(File apk, String version) throws Exception {
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo current = pm.getPackageInfo(context.getPackageName(), flags), next = archive(apk);
        if (!current.packageName.equals(next.packageName)) throw new IOException("安装包的应用身份不匹配，已阻止安装。");
        if (code(next) <= code(current) || !CoreUpdateRelease.newer(next.versionName, current.versionName, "latest") || !version.equals(next.versionName))
            throw new IOException("安装包版本与更新信息不匹配，或不是较新的版本。");
        if (Build.VERSION.SDK_INT >= 24 && next.applicationInfo != null && next.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
            throw new IOException("此更新不支持当前 Android 版本。");
        Signature[] before = Build.VERSION.SDK_INT >= 28 ? current.signingInfo.getApkContentsSigners() : current.signatures;
        Signature[] after = Build.VERSION.SDK_INT >= 28 ? next.signingInfo.getApkContentsSigners() : next.signatures;
        if (before == null || after == null || before.length == 0 || !new HashSet<>(Arrays.asList(before)).equals(new HashSet<>(Arrays.asList(after))))
            throw new IOException("安装包签名不匹配，已阻止安装。");
        if ((current.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0 && (next.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            throw new IOException("应用更新不能使用调试安装包。");
    }
    static String hex(byte[] bytes) { StringBuilder text = new StringBuilder(); for (byte value : bytes) text.append(String.format(Locale.ROOT, "%02x", value & 255)); return text.toString(); }
}
