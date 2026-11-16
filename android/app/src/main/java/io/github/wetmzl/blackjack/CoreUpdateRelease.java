package io.github.wetmzl.blackjack;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.math.BigInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Public release APKs only; no repository credentials or arbitrary download URLs. */
final class CoreUpdateRelease {
    static final String REPOSITORY = "wetmzl/HoC-Core";
    static final String RELEASES_URL = "https://api.github.com/repos/" + REPOSITORY + "/releases";
    static final String LATEST_URL = RELEASES_URL + "/latest";
    static final long MAX_APK_BYTES = 256L * 1024 * 1024;
    private static final Pattern VERSION = Pattern.compile("^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");
    final String version, tag, notes, url, sha256, chunkManifestUrl;
    final long bytes;
    final boolean prerelease;

    CoreUpdateRelease(String version, String tag, String notes, String url, String sha256, long bytes, boolean prerelease) {
        this(version, tag, notes, url, sha256, bytes, prerelease, null);
    }
    CoreUpdateRelease(String version, String tag, String notes, String url, String sha256, long bytes, boolean prerelease, String chunkManifestUrl) {
        this.version = version; this.tag = tag; this.notes = notes;
        this.url = url; this.sha256 = sha256; this.bytes = bytes; this.prerelease = prerelease;
        this.chunkManifestUrl = chunkManifestUrl;
    }
    String name() { return "HoC-Core-" + version + ".apk"; }
    static CoreUpdateRelease parsePages(JSONObject release, String installed, String channel) throws Exception {
        CoreUpdateRelease parsed = parse(release, installed, channel);
        if (parsed == null) return null;
        JSONObject asset = null;
        JSONArray assets = release.getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) if (parsed.name().equals(assets.getJSONObject(i).optString("name"))) asset = assets.getJSONObject(i);
        if (asset == null || !CoreUpdateChunks.manifestUrl(parsed).equals(asset.opt("chunk_manifest_url"))) throw new IOException("Pages 分片清单地址与所选安装包不匹配。");
        return new CoreUpdateRelease(parsed.version, parsed.tag, parsed.notes, parsed.url, parsed.sha256, parsed.bytes, parsed.prerelease, asset.getString("chunk_manifest_url"));
    }

    static String channel(String value) throws IOException {
        if (!"stable".equals(value) && !"latest".equals(value)) throw new IOException("更新通道无效。");
        return value;
    }
    static boolean prerelease(String version) { Matcher match = VERSION.matcher(version); return match.matches() && match.group(4) != null; }
    static boolean valid(String version) { return VERSION.matcher(version).matches(); }
    static int compare(String left, String right) {
        Matcher a = VERSION.matcher(left), b = VERSION.matcher(right);
        if (!a.matches() || !b.matches()) throw new IllegalArgumentException("Invalid version");
        for (int i = 1; i <= 3; i++) {
            int order = new BigInteger(a.group(i)).compareTo(new BigInteger(b.group(i)));
            if (order != 0) return order;
        }
        String ap = a.group(4), bp = b.group(4);
        if (ap == null || bp == null) return ap == null ? (bp == null ? 0 : 1) : -1;
        String[] aa = ap.split("\\."), bb = bp.split("\\.");
        for (int i = 0; i < Math.max(aa.length, bb.length); i++) {
            if (i == aa.length || i == bb.length) return i == aa.length ? -1 : 1;
            if (aa[i].equals(bb[i])) continue;
            boolean an = aa[i].matches("[0-9]+"), bn = bb[i].matches("[0-9]+");
            int order = an && bn ? new BigInteger(aa[i]).compareTo(new BigInteger(bb[i]))
                : an != bn ? (an ? -1 : 1) : aa[i].compareTo(bb[i]);
            if (order != 0) return order;
        }
        return 0;
    }
    static boolean newer(String release, String installed, String channel) {
        return valid(release) && valid(installed) && (!"stable".equals(channel) || !prerelease(release)) && compare(release, installed) > 0;
    }
    static boolean newerStable(String release, String installed) { return newer(release, installed, "stable"); }
    static boolean eligible(JSONObject release, String channel) {
        String tag = release.optString("tag_name");
        return !release.optBoolean("draft") && valid(tag) && !tag.contains("+")
            && (!"stable".equals(channel) || (!release.optBoolean("prerelease") && !prerelease(tag)));
    }
    static CoreUpdateRelease parse(JSONObject release, String installed) throws Exception { return parse(release, installed, "stable"); }
    static CoreUpdateRelease parse(JSONObject release, String installed, String channel) throws Exception {
        channel(channel);
        String tag = release.optString("tag_name");
        if (!eligible(release, channel) || !newer(tag, installed, channel)) return null;
        String version = tag.startsWith("v") ? tag.substring(1) : tag;
        String name = "HoC-Core-" + version + ".apk";
        JSONArray assets = release.getJSONArray("assets");
        JSONObject apk = null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (name.equals(asset.optString("name")) && "uploaded".equals(asset.optString("state"))) {
                if (apk != null) throw new IOException("发布包含重复 APK，请稍后重试。");
                apk = asset;
            }
        }
        if (apk == null) throw new IOException("所选版本尚未提供 Android 安装包，请稍后重试。");
        String url = apk.getString("browser_download_url");
        String expected = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + name;
        String digest = apk.optString("digest");
        long bytes = apk.getLong("size");
        if (!expected.equals(url) || !digest.matches("sha256:[a-fA-F0-9]{64}") || bytes <= 0 || bytes > MAX_APK_BYTES)
            throw new IOException("发布安装包的地址、大小或校验信息无效。");
        String notes = release.optString("body");
        return new CoreUpdateRelease(version, tag, notes.substring(0, Math.min(notes.length(), 8000)), url, digest.substring(7).toLowerCase(java.util.Locale.ROOT), bytes,
            release.optBoolean("prerelease") || prerelease(version));
    }
    JSONObject json() throws Exception {
        return new JSONObject().put("version", version).put("tag", tag).put("notes", notes)
            .put("bytes", bytes).put("sha256", sha256).put("prerelease", prerelease);
    }
}
