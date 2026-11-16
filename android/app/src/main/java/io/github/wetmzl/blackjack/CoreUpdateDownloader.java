package io.github.wetmzl.blackjack;

import android.content.Context;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Persistent verified chunks are independent from the install receipt and Android's cache eviction. */
final class CoreUpdateDownloader {
    interface Transport { HttpURLConnection open(String address, Map<String, String> headers) throws Exception; }
    interface Cancellation { void check() throws IOException; }
    static boolean unavailable(int status) { return status == 403 || status == 404 || status == 408 || status == 429 || status >= 500; }
    static boolean network(Exception error) {
        return error instanceof java.net.SocketTimeoutException || error instanceof java.net.UnknownHostException
            || error instanceof java.net.SocketException || error instanceof javax.net.ssl.SSLException || error instanceof java.io.InterruptedIOException;
    }
    static HttpURLConnection pages(Transport transport, String address) throws Exception {
        HttpURLConnection connection;
        try { connection = transport.open(address, Collections.emptyMap()); }
        catch (Exception error) { if (network(error)) throw new CoreUpdateChunks.Unavailable(error); throw error; }
        int status = connection.getResponseCode();
        if (unavailable(status)) { connection.disconnect(); throw new CoreUpdateChunks.Unavailable("Pages 更新源暂不可用（HTTP " + status + "）。"); }
        if (status != 200) { connection.disconnect(); throw new IOException("Pages 更新请求未完成（HTTP " + status + "）。"); }
        return connection;
    }
    static JSONObject pagesJson(Transport transport, String address) throws Exception {
        HttpURLConnection connection = pages(transport, address);
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[16384];
                while (true) {
                    int count;
                    try { count = input.read(buffer); } catch (IOException error) { throw new CoreUpdateChunks.Unavailable(error); }
                    if (count == -1) break;
                    if (bytes.size() + count > 4 * 1024 * 1024) throw new CoreUpdateChunks.Invalid("Pages 更新信息过大。");
                    bytes.write(buffer, 0, count);
                }
            } catch (CoreUpdateChunks.Invalid invalid) { throw invalid; }
            catch (IOException interrupted) { throw new CoreUpdateChunks.Unavailable(interrupted); }
            try { return new JSONObject(bytes.toString(StandardCharsets.UTF_8.name())); }
            catch (JSONException error) { throw new IOException("Pages 更新信息格式无效。", error); }
        } finally { connection.disconnect(); }
    }
    static String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count); }
        return CoreUpdateManager.hex(hash.digest());
    }
    static boolean valid(File file, long bytes, String sha256) throws Exception {
        File expected = new File(file.getParentFile().getCanonicalFile(), file.getName());
        return file.isFile() && file.getCanonicalFile().equals(expected) && file.length() == bytes && digest(file).equals(sha256);
    }
    static void ensure(File directory) throws IOException { if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建更新下载目录。"); }
    static JSONObject json(File file) throws Exception {
        if (file.length() > 4 * 1024 * 1024) throw new IOException("本机更新记录过大。");
        try (InputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384]; int count;
            while ((count = input.read(buffer)) != -1) { if (output.size() + count > 4 * 1024 * 1024) throw new IOException("本机更新记录过大。"); output.write(buffer, 0, count); }
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        }
    }
    static void atomicJson(File file, JSONObject value) throws Exception {
        File temporary = new File(file.getParentFile(), file.getName() + ".writing");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
            if (!temporary.renameTo(file)) throw new IOException("无法保存更新断点。");
        } finally { temporary.delete(); }
    }
    interface Bytes { void report(long bytes); }
    static void store(HttpURLConnection connection, File file, long bytes, String sha256, Cancellation cancellation, Bytes progress) throws Exception {
        File partial = new File(file.getParentFile(), file.getName() + ".partial");
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            long completed = 0;
            InputStream stream;
            try { stream = connection.getInputStream(); } catch (IOException interrupted) { cancellation.check(); throw new CoreUpdateChunks.Unavailable(interrupted); }
            try (InputStream input = stream; FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[65536];
                while (true) {
                    int count;
                    try { count = input.read(buffer); } catch (IOException error) { cancellation.check(); throw new CoreUpdateChunks.Unavailable(error); }
                    if (count == -1) break;
                    cancellation.check(); completed += count;
                    if (completed > bytes) throw new IOException("分片或安装包超出声明大小。");
                    output.write(buffer, 0, count); hash.update(buffer, 0, count); progress.report(completed);
                }
                cancellation.check(); output.getFD().sync();
            }
            if (completed != bytes || !CoreUpdateManager.hex(hash.digest()).equals(sha256)) throw new IOException("分片或安装包不完整或校验失败。");
            cancellation.check();
            if (!partial.renameTo(file)) throw new IOException("无法保存已验证的下载分片。");
        } finally { partial.delete(); connection.disconnect(); }
    }
    static File download(Context context, File directory, CoreUpdateRelease release, Transport transport,
        Cancellation cancellation, CoreUpdateManager.Progress progress) throws Exception {
        File cache = new File(context.getFilesDir(), "core-update-parts/" + release.sha256);
        ensure(directory); ensure(cache);
        File identities = new File(context.getFilesDir(), "core-update-identities"); ensure(identities);
        String key = CoreUpdateManager.hex(MessageDigest.getInstance("SHA-256").digest((release.tag + "\0" + release.name()).getBytes(StandardCharsets.UTF_8)));
        File identity = new File(identities, key + ".json");
        if (identity.isFile()) {
            JSONObject previous = json(identity);
            if (!release.tag.equals(previous.opt("tag")) || !release.name().equals(previous.opt("name"))
                || release.bytes != previous.getLong("bytes") || !release.sha256.equals(previous.opt("sha256"))) throw new IOException("同一发布版本的安装包身份或摘要已变化，已停止更新。");
        } else atomicJson(identity, new JSONObject().put("tag", release.tag).put("name", release.name()).put("bytes", release.bytes).put("sha256", release.sha256));
        File planFile = new File(cache, "manifest.json");
        List<CoreUpdateChunks.Part> plan = null;
        if (planFile.isFile()) {
            try { plan = CoreUpdateChunks.parse(json(planFile), release); }
            catch (Exception invalid) { planFile.delete(); }
        }
        if (plan == null && release.chunkManifestUrl != null) {
            try {
                JSONObject data = pagesJson(transport, release.chunkManifestUrl);
                plan = CoreUpdateChunks.parse(data, release); atomicJson(planFile, data);
            } catch (CoreUpdateChunks.Unavailable unavailable) { cancellation.check(); }
        }
        File staging = new File(directory, release.sha256 + ".assembling");
        long[] lastProgress = { 0 };
        Bytes report = completed -> {
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastProgress[0] >= 150) { progress.update("downloading", completed, release.bytes); lastProgress[0] = now; }
        };
        boolean complete = false;
        try {
            if (plan != null) {
                long completed = 0;
                for (CoreUpdateChunks.Part part : plan) {
                    cancellation.check();
                    File file = new File(cache, part.sha256 + ".part");
                    final long offset = completed;
                    if (!valid(file, part.bytes, part.sha256)) {
                        if (file.exists() && !file.delete()) throw new IOException("无法重取损坏的下载分片。");
                        try {
                            store(pages(transport, part.url), file, part.bytes, part.sha256, cancellation, bytes -> report.report(offset + bytes));
                        } catch (CoreUpdateChunks.Unavailable unavailable) {
                            cancellation.check();
                            long end = part.offset + part.bytes - 1;
                            HttpURLConnection backup = transport.open(release.url, Collections.singletonMap("Range", "bytes=" + part.offset + "-" + end));
                            if (backup.getResponseCode() != 206 || !("bytes " + part.offset + "-" + end + "/" + release.bytes).equals(backup.getHeaderField("Content-Range"))) {
                                backup.disconnect(); throw new IOException("GitHub 备用源未返回所选附件的正确分段，断点已保留。");
                            }
                            store(backup, file, part.bytes, part.sha256, cancellation, bytes -> report.report(offset + bytes));
                        }
                    }
                    completed += part.bytes; progress.update("downloading", completed, release.bytes);
                }
                MessageDigest hash = MessageDigest.getInstance("SHA-256"); long bytes = 0;
                try (FileOutputStream output = new FileOutputStream(staging)) {
                    byte[] buffer = new byte[65536];
                    for (CoreUpdateChunks.Part part : plan) try (InputStream input = new FileInputStream(new File(cache, part.sha256 + ".part"))) {
                        int count;
                        while ((count = input.read(buffer)) != -1) { cancellation.check(); bytes += count; hash.update(buffer, 0, count); output.write(buffer, 0, count); }
                    }
                    output.getFD().sync();
                }
                if (bytes != release.bytes || !CoreUpdateManager.hex(hash.digest()).equals(release.sha256)) throw new IOException("重组安装包的完整大小或摘要校验失败。");
            } else {
                cancellation.check(); HttpURLConnection direct = transport.open(release.url, Collections.emptyMap());
                if (direct.getResponseCode() != 200) { direct.disconnect(); throw new IOException("安装包下载失败，请稍后重试。"); }
                store(direct, staging, release.bytes, release.sha256, cancellation, report);
            }
            cancellation.check(); progress.update("verifying", release.bytes, release.bytes); cancellation.check(); complete = true;
            return staging;
        } catch (Exception error) {
            try { cancellation.check(); if (!(error instanceof CoreUpdateChunks.Unavailable)) planFile.delete(); } catch (IOException cancelled) { }
            throw error;
        } finally { if (!complete) staging.delete(); }
    }
}
