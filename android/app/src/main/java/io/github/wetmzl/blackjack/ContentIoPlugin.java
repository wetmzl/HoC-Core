package io.github.wetmzl.blackjack;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.CRC32;
import java.util.regex.Pattern;
import net.lingala.zip4j.ZipFile;
import net.lingala.zip4j.model.FileHeader;
import net.lingala.zip4j.exception.ZipException;

/** Raw file operations only. Package schemas, limits and catalog decisions stay shared. */
@CapacitorPlugin(name = "ContentIo")
public class ContentIoPlugin extends Plugin {
    static final int BUFFER_BYTES = 256 * 1024;
    static final long MAX_ENTRY = 256L * 1024 * 1024;
    static final long MAX_INPUT = 512L * 1024 * 1024;
    private static final Pattern PATH_SEGMENT = Pattern.compile("[A-Za-z0-9._-]+");
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, AtomicBoolean> jobs = new ConcurrentHashMap<>();
    private final Map<String, Long> progressTimes = new ConcurrentHashMap<>();
    private final Map<String, Archive> archives = new ConcurrentHashMap<>();
    private static class Archive {
        final File file; final boolean owned;
        Archive(File file, boolean owned) { this.file = file; this.owned = owned; }
    }
    @Override public void load() {
        File[] leftovers = getContext().getCacheDir().listFiles((directory, name) -> name.startsWith("content-archive-") && name.endsWith(".zip"));
        if (leftovers != null) for (File file : leftovers) file.delete();
    }
    interface Work { JSObject run(AtomicBoolean cancelled) throws Exception; }
    private void submit(PluginCall call, Work work) {
        String id = call.getString("operationId", UUID.randomUUID().toString());
        AtomicBoolean cancelled = jobs.computeIfAbsent(id, key -> new AtomicBoolean(false));
        executor.execute(() -> {
            long started = android.os.SystemClock.elapsedRealtime();
            try {
                check(cancelled);
                JSObject result = work.run(cancelled);
                long bytes = result.optLong("bytes", 0);
                org.json.JSONArray results = result.optJSONArray("results");
                if (results != null) for (int i = 0; i < results.length(); i++) bytes += results.getJSONObject(i).optLong("bytes", 0);
                android.util.Log.i("ContentIo", call.getMethodName() + " elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started) + " bytes=" + bytes);
                call.resolve(result);
            } catch (Exception error) {
                android.util.Log.w("ContentIo", call.getMethodName() + " elapsedMs=" + (android.os.SystemClock.elapsedRealtime() - started) + " error=" + error.getClass().getSimpleName());
                call.reject(operationError(error), operationCode(error), error);
            } finally { jobs.remove(id); progressTimes.remove(id); }
        });
    }
    static void check(AtomicBoolean cancelled) throws IOException {
        if (cancelled.get()) throw new IOException("操作已取消。");
    }
    static class ArchivePasswordException extends IOException { ArchivePasswordException() { super("此 ZIP 需要密码。"); } }
    static String operationCode(Exception error) {
        if (error instanceof ArchivePasswordException) return "ZIP_PASSWORD_REQUIRED";
        if (error instanceof ZipException && ((ZipException)error).getType() == ZipException.Type.WRONG_PASSWORD) return "ZIP_INVALID_PASSWORD";
        return "CONTENT_IO_ERROR";
    }
    static String operationError(Exception error) {
        if (error instanceof ZipException) {
            ZipException.Type type = ((ZipException)error).getType();
            if (type == ZipException.Type.WRONG_PASSWORD) return "密码不匹配，或加密内容已损坏。";
            if (type == ZipException.Type.UNSUPPORTED_ENCRYPTION || type == ZipException.Type.UNKNOWN_COMPRESSION_METHOD) return "不支持此 ZIP 的加密或压缩方式。";
            return "文件内容不完整或压缩包已损坏，请重新选择完整文件。";
        }
        String message = error.getMessage();
        if (message != null && (message.contains("ENOSPC") || message.toLowerCase(Locale.ROOT).contains("no space left"))) return "存储空间不足，请释放空间后重试。";
        if (error instanceof java.util.zip.ZipException || error instanceof EOFException) return "文件内容不完整或压缩包已损坏，请重新选择完整文件。";
        if (error instanceof FileNotFoundException) return "无法打开所选文件，请重新选择。";
        return message == null ? "文件操作失败。" : message;
    }
    static byte[] readRange(InputStream input, int offset, int length, AtomicBoolean cancelled) throws IOException {
        if (offset < 0 || offset > MAX_INPUT || length < 0 || length > 2 * 1024 * 1024) throw new IOException("导入读取范围超过限额。");
        while (offset > 0) {
            check(cancelled);
            long skipped = input.skip(offset);
            if (skipped == 0) { if (input.read() < 0) return new byte[0]; skipped = 1; }
            offset -= (int)skipped;
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream(length);
        byte[] buffer = new byte[Math.min(BUFFER_BYTES, length)];
        while (output.size() < length) {
            check(cancelled);
            int count = input.read(buffer, 0, Math.min(buffer.length, length - output.size()));
            if (count < 0) break;
            output.write(buffer, 0, count);
        }
        check(cancelled);
        return output.toByteArray();
    }
    @PluginMethod public void readRange(PluginCall call) {
        submit(call, cancelled -> {
            try (InputStream input = source(call.getObject("source"))) {
                byte[] bytes = readRange(input, call.getInt("offset", -1), call.getInt("length", -1), cancelled);
                return new JSObject().put("data", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)).put("bytes", bytes.length);
            }
        });
    }
    private File stored(String path) throws IOException {
        if (path == null || path.length() > 1024) throw new IOException("非法内容路径。");
        for (String part : path.split("/", -1)) if (!PATH_SEGMENT.matcher(part).matches() || part.equals(".") || part.equals("..")) throw new IOException("非法内容路径。");
        File root = getContext().getFilesDir().getCanonicalFile();
        File file = new File(root, path).getCanonicalFile();
        if (!file.getPath().startsWith(root.getPath() + File.separator)) throw new IOException("内容路径越界。");
        return file;
    }
    private InputStream source(org.json.JSONObject source) throws Exception {
        if (source == null) throw new IOException("缺少内容来源。");
        if ("stored".equals(source.optString("kind", null))) return new FileInputStream(stored(source.optString("path", null)));
        if ("asset".equals(source.optString("kind", null))) {
            String path = source.optString("path", null);
            // Asset references are relative to the web root, never arbitrary filesystem paths.
            if (path == null || !path.startsWith("/") || path.contains("..") || path.contains("\\") || path.contains(":")) throw new IOException("非法内嵌资源路径。");
            return getContext().getAssets().open("public" + path);
        }
        throw new IOException("不支持的内容来源。");
    }
    static JSObject transfer(InputStream input, OutputStream output, AtomicBoolean cancelled, long limit, Progress progress) throws Exception {
        return transfer(input, output, cancelled, limit, progress, new byte[BUFFER_BYTES]);
    }
    // The caller owns this buffer for one serial operation, never across queued jobs.
    static JSObject transfer(InputStream input, OutputStream output, AtomicBoolean cancelled, long limit, Progress progress, byte[] buffer) throws Exception {
        if (buffer.length == 0) throw new IllegalArgumentException("传输缓冲区不能为空。");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long bytes = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            check(cancelled);
            bytes += count;
            if (bytes > limit) throw new IOException("文件超过限额。");
            digest.update(buffer, 0, count);
            if (output != null) output.write(buffer, 0, count);
            if (progress != null) progress.update(bytes);
        }
        check(cancelled);
        byte[] bytesHash = digest.digest();
        char[] hash = new char[bytesHash.length * 2];
        for (int index = 0; index < bytesHash.length; index++) {
            int value = bytesHash[index] & 255;
            hash[index * 2] = HEX[value >>> 4];
            hash[index * 2 + 1] = HEX[value & 15];
        }
        return new JSObject().put("bytes", bytes).put("sha256", new String(hash));
    }
    interface Progress { void update(long bytes); }
    private Progress progress(PluginCall call, String phase, String path, long total) {
        String id = call.getString("operationId", "");
        return bytes -> {
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - progressTimes.getOrDefault(id, 0L) < 100) return;
            progressTimes.put(id, now);
            notifyListeners("progress", new JSObject().put("operationId", call.getString("operationId"))
                .put("phase", phase).put("path", path).put("completedBytes", bytes).put("totalBytes", total));
        };
    }
    @PluginMethod public void cancel(PluginCall call) {
        AtomicBoolean job = jobs.get(call.getString("operationId"));
        if (job != null) job.set(true);
        // The original call settles only after its streams close; this is not an unlock acknowledgement.
        call.resolve();
    }
    @PluginMethod public void inspect(PluginCall call) {
        submit(call, cancelled -> {
            JSArray results = new JSArray();
            JSArray paths = call.getArray("paths");
            byte[] buffer = new byte[BUFFER_BYTES];
            for (int i = 0; i < paths.length(); i++) {
                String path = paths.getString(i);
                File file = stored(path);
                try (InputStream input = new FileInputStream(file)) {
                    results.put(transfer(input, null, cancelled, MAX_ENTRY, progress(call, "verifying", path, file.length()), buffer));
                }
            }
            return new JSObject().put("results", results);
        });
    }
    @PluginMethod public void copy(PluginCall call) {
        submit(call, cancelled -> {
            File target = stored(call.getString("destination"));
            if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建内容目录。");
            try (InputStream input = source(call.getObject("source")); OutputStream output = new FileOutputStream(target)) {
                return transfer(input, output, cancelled, MAX_ENTRY, progress(call, "copying", call.getString("destination"), 0));
            } catch (Exception error) { target.delete(); throw error; }
        });
    }
    @PluginMethod public void copyMany(PluginCall call) {
        submit(call, cancelled -> {
            JSArray files = call.getArray("files");
            if (files == null || files.length() > 1000) throw new IOException("文件数量超过限额。");
            JSArray results = new JSArray();
            byte[] buffer = new byte[BUFFER_BYTES];
            for (int i = 0; i < files.length(); i++) {
                check(cancelled);
                org.json.JSONObject entry = files.getJSONObject(i);
                File target = stored(entry.optString("destination", null));
                if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建内容目录。");
                try (InputStream input = source(entry.optJSONObject("source")); OutputStream output = new FileOutputStream(target)) {
                    results.put(transfer(input, output, cancelled, MAX_ENTRY, progress(call, "copying", entry.optString("destination", null), 0), buffer));
                } catch (Exception error) { target.delete(); throw error; }
            }
            return new JSObject().put("results", results);
        });
    }
    private ZipFile zip(File file) throws IOException {
        ZipFile zip = new ZipFile(file);
        // UTF-8 flagged names are decoded by zip4j; retain legacy byte mapping otherwise.
        zip.setCharset(StandardCharsets.ISO_8859_1);
        if (zip.isSplitArchive()) { zip.close(); throw new IOException("不支持分卷 ZIP。"); }
        return zip;
    }
    private File pngPayload(File file, AtomicBoolean cancelled) throws Exception {
        File target = new File(getContext().getCacheDir(), "content-archive-" + UUID.randomUUID() + ".zip");
        boolean found = false;
        try (DataInputStream input = new DataInputStream(new BufferedInputStream(new FileInputStream(file)))) {
            byte[] signature = new byte[8]; input.readFully(signature);
            if (!Arrays.equals(signature, new byte[] {(byte)137,80,78,71,13,10,26,10})) return null;
            while (true) {
                long length = Integer.toUnsignedLong(input.readInt());
                if (length > MAX_ENTRY) throw new IOException("PNG 条目超过限额。");
                byte[] type = new byte[4]; input.readFully(type);
                String name = new String(type, StandardCharsets.US_ASCII);
                CRC32 crc = new CRC32(); crc.update(type);
                boolean capture = name.equals("hcPK") && !found;
                try (OutputStream output = capture ? new FileOutputStream(target) : null) {
                    byte[] buffer = new byte[BUFFER_BYTES];
                    while (length > 0) {
                        check(cancelled);
                        int count = input.read(buffer, 0, (int)Math.min(buffer.length, length));
                        if (count < 0) throw new IOException("PNG 数据不完整。");
                        crc.update(buffer, 0, count);
                        if (output != null) output.write(buffer, 0, count);
                        length -= count;
                    }
                }
                if (crc.getValue() != Integer.toUnsignedLong(input.readInt())) throw new IOException("PNG 校验失败。");
                if (capture) found = true;
                if (name.equals("IEND")) {
                    if (!found) throw new IOException("PNG 中没有 hocpkg 内容包。");
                    return target;
                }
            }
        } catch (Exception error) { target.delete(); throw error; }
    }
    @PluginMethod public void openArchive(PluginCall call) {
        submit(call, cancelled -> {
            JSObject source = call.getObject("source");
            if (source == null || !"stored".equals(source.optString("kind", null))) throw new IOException("归档必须来自受管文件。");
            File input = stored(source.optString("path", null));
            if (input.length() > MAX_INPUT) throw new IOException("导入文件超过 512 MiB 限额。");
            File payload = pngPayload(input, cancelled);
            File file = payload == null ? input : payload;
            try (ZipFile zip = zip(file)) {
                JSArray entries = new JSArray();
                int count = 0;
                for (FileHeader entry : zip.getFileHeaders()) {
                    check(cancelled);
                    if (++count > 4096) throw new IOException("ZIP 条目数量超过限制。");
                    if (!entry.isDirectory()) entries.put(new JSObject().put("path", entry.getFileName()).put("bytes", entry.getUncompressedSize()).put("compressedBytes", entry.getCompressedSize()).put("encrypted", entry.isEncrypted()));
                }
                String token = UUID.randomUUID().toString();
                archives.put(token, new Archive(file, payload != null));
                return new JSObject().put("token", token).put("entries", entries);
            } catch (Exception error) { if (payload != null) payload.delete(); throw error; }
        });
    }
    private JSObject extractEntry(ZipFile zip, String path, String destination, PluginCall call, AtomicBoolean cancelled, byte[] buffer) throws Exception {
        File target = stored(destination);
        try {
            FileHeader entry = zip.getFileHeader(path);
            if (entry == null || entry.isDirectory()) throw new IOException("ZIP 条目不存在。");
            if (entry.getUncompressedSize() < 0 || entry.getUncompressedSize() > MAX_ENTRY || entry.getCompressedSize() < 0
                || (entry.getCompressedSize() > 0 && entry.getUncompressedSize() / (double)entry.getCompressedSize() > 200)) throw new IOException("ZIP 条目超过限额。");
            if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建内容目录。");
            String password = call.getString("password");
            if (entry.isEncrypted() && password == null) throw new ArchivePasswordException();
            char[] credential = password == null ? null : password.toCharArray();
            zip.setPassword(credential);
            JSObject result;
            try (InputStream input = zip.getInputStream(entry); OutputStream output = new FileOutputStream(target)) {
                result = transfer(input, output, cancelled, entry.getUncompressedSize(), progress(call, "extracting", entry.getFileName(), entry.getUncompressedSize()), buffer);
            } finally { if (credential != null) Arrays.fill(credential, '\0'); }
            // zip4j checks CRC / AES authentication before its stream reaches EOF.
            if (result.getLong("bytes") != entry.getUncompressedSize()) throw new IOException("ZIP 条目校验失败。");
            return result;
        } catch (Exception error) { target.delete(); throw error; }
    }
    @PluginMethod public void extract(PluginCall call) {
        submit(call, cancelled -> {
            Archive archive = archives.get(call.getString("token"));
            if (archive == null) throw new IOException("归档句柄已关闭。");
            try (ZipFile zip = zip(archive.file)) {
                return extractEntry(zip, call.getString("path"), call.getString("destination"), call, cancelled, new byte[BUFFER_BYTES]);
            }
        });
    }
    @PluginMethod public void extractMany(PluginCall call) {
        submit(call, cancelled -> {
            Archive archive = archives.get(call.getString("token"));
            if (archive == null) throw new IOException("归档句柄已关闭。");
            JSArray files = call.getArray("files");
            if (files == null || files.length() > 1000) throw new IOException("文件数量超过限额。");
            JSArray results = new JSArray();
            byte[] buffer = new byte[BUFFER_BYTES];
            try (ZipFile zip = zip(archive.file)) {
                for (int i = 0; i < files.length(); i++) {
                    check(cancelled);
                    org.json.JSONObject entry = files.getJSONObject(i);
                    results.put(extractEntry(zip, entry.optString("path", null), entry.optString("destination", null), call, cancelled, buffer));
                }
            }
            return new JSObject().put("results", results);
        });
    }
    @PluginMethod public void closeArchive(PluginCall call) {
        Archive archive = archives.remove(call.getString("token"));
        if (archive != null && archive.owned) archive.file.delete();
        call.resolve();
    }
    @PluginMethod public void pickFile(PluginCall call) {
        jobs.put(call.getString("operationId", "picker"), new AtomicBoolean(false));
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "picked");
    }
    @ActivityCallback private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { jobs.remove(call.getString("operationId", "picker")); call.resolve(new JSObject().put("file", org.json.JSONObject.NULL)); return; }
        Uri uri = result.getData().getData();
        submit(call, cancelled -> {
            String name = "import.zip";
            try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) { int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (column >= 0) name = cursor.getString(column); }
            }
            String path = "content/v1/import-inputs/" + UUID.randomUUID() + ".input";
            File target = stored(path);
            if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建导入目录。");
            try (InputStream input = getContext().getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(target)) {
                if (input == null) throw new IOException("无法打开选择的文件。");
                JSObject digest = transfer(input, output, cancelled, MAX_INPUT, progress(call, "copying", name, 0));
                return new JSObject().put("file", new JSObject().put("name", name).put("size", digest.getLong("bytes"))
                    .put("source", new JSObject().put("kind", "stored").put("path", path)));
            } catch (Exception error) { target.delete(); throw error; }
        });
    }
    @Override protected void handleOnDestroy() {
        for (AtomicBoolean job : jobs.values()) job.set(true);
        executor.shutdown();
        for (Archive archive : archives.values()) if (archive.owned) archive.file.delete();
        archives.clear();
    }
}
