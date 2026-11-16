package io.github.wetmzl.blackjack;

import org.json.*;
import java.io.IOException;
import java.util.*;

/** Static Pages contract v1. All addresses remain derived from the selected public APK. */
final class CoreUpdateChunks {
    static final String ORIGIN = "https://hoc-core-updates.pages.dev";
    static final long MAX_PART_BYTES = 24L * 1024 * 1024;
    static final class Invalid extends IOException { Invalid(String message) { super(message); } }
    static final class Unavailable extends IOException {
        Unavailable(String message) { super(message); }
        Unavailable(Throwable cause) { super("无法连接 Pages 更新源。", cause); }
    }
    static final class Part {
        final long offset, bytes;
        final String sha256, url;
        Part(long offset, long bytes, String sha256, String url) { this.offset = offset; this.bytes = bytes; this.sha256 = sha256; this.url = url; }
    }
    static long integer(Object value) throws IOException {
        if (!(value instanceof Number)) throw new IOException("分片清单的数值类型无效。");
        Number number = (Number) value;
        if (!Double.isFinite(number.doubleValue()) || number.doubleValue() != number.longValue()) throw new IOException("分片清单的数值无效。");
        return number.longValue();
    }
    static JSONObject channel(JSONObject data, String channel) throws Exception {
        if (integer(data.opt("schemaVersion")) != 1 || !channel.equals(data.opt("channel")) || !data.has("release")) throw new IOException("Pages 更新通道信息无效。");
        if (data.isNull("release")) return null;
        JSONObject release = data.getJSONObject("release");
        if (!Boolean.FALSE.equals(release.opt("draft")) || !(release.opt("prerelease") instanceof Boolean)
            || !CoreUpdateRelease.eligible(release, channel) || !(release.opt("assets") instanceof JSONArray)) throw new IOException("Pages 发布身份或通道不匹配。");
        return release;
    }
    static String manifestUrl(CoreUpdateRelease release) { return ORIGIN + "/files/" + release.tag + "/" + release.name() + ".json"; }
    static List<Part> parse(JSONObject data, CoreUpdateRelease release) throws Exception {
        if (integer(data.opt("schemaVersion")) != 1 || !release.name().equals(data.opt("name")) || integer(data.opt("bytes")) != release.bytes
            || !release.sha256.equals(data.opt("sha256")) || !release.url.equals(data.opt("sourceUrl"))) throw new IOException("分片清单与所选安装包的身份、大小或摘要不匹配。");
        JSONArray parts = data.getJSONArray("parts");
        if (parts.length() == 0 || parts.length() > 4096) throw new IOException("分片清单不完整或过大。");
        List<Part> result = new ArrayList<>();
        long offset = 0;
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.getJSONObject(i);
            long bytes = integer(part.opt("bytes"));
            String sha = part.getString("sha256"), url = part.getString("url");
            if (integer(part.opt("index")) != i || integer(part.opt("offset")) != offset || bytes <= 0 || bytes > MAX_PART_BYTES
                || !sha.matches("[a-f0-9]{64}") || !url.equals(ORIGIN + "/assets/chunks/" + sha + ".part")) throw new IOException("分片顺序、大小、摘要或下载地址无效。");
            result.add(new Part(offset, bytes, sha, url)); offset += bytes;
            if (offset > release.bytes) throw new IOException("分片总大小超过发布声明。");
        }
        if (offset != release.bytes) throw new IOException("分片清单不完整。");
        return result;
    }
}
