package io.github.wetmzl.blackjack;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

@RunWith(AndroidJUnit4.class)
public class CoreUpdatePagesTest {
    private Context context;
    private File fixture;
    private JSONObject release, manifest;
    private final Map<String, Integer> requests = new HashMap<>();
    private List<CoreUpdateChunks.Part> parts;
    private int corrupt = -1, unavailable = -1, pagesStatus = 200;
    private boolean empty, invalidRange;
    private static final String TAG = "v1.0.0", NAME = "HoC-Core-1.0.0.apk";
    private static final String SOURCE = "https://github.com/wetmzl/HoC-Core/releases/download/" + TAG + "/" + NAME;
    private static final String MANIFEST = CoreUpdateChunks.ORIGIN + "/files/" + TAG + "/" + NAME + ".json";
    @Before public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext(); CoreUpdateTestState.reset(context);
        fixture = new File(context.getCacheDir(), "pages-target-fixture.apk");
        InputStream source;
        try { source = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("update-fixture.apk"); }
        catch (IOException missing) { Assume.assumeNoException("Generate signed neutral APK fixtures before updater tests", missing); return; }
        try (InputStream input = source; OutputStream output = new FileOutputStream(fixture)) {
            byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
        String digest = CoreUpdateDownloader.digest(fixture);
        release = new JSONObject().put("tag_name", TAG).put("draft", false).put("prerelease", false).put("body", "完整的中性更新日志")
            .put("assets", new JSONArray().put(new JSONObject().put("name", NAME).put("state", "uploaded").put("size", fixture.length())
                .put("digest", "sha256:" + digest).put("browser_download_url", SOURCE).put("chunk_manifest_url", MANIFEST)));
        JSONArray pieces = new JSONArray(); long offset = 0;
        try (InputStream input = new FileInputStream(fixture)) {
            byte[] buffer = new byte[8 * 1024 * 1024];
            while (offset < fixture.length()) {
                int bytes = 0;
                while (bytes < buffer.length) { int count = input.read(buffer, bytes, buffer.length - bytes); if (count == -1) break; bytes += count; }
                MessageDigest hash = MessageDigest.getInstance("SHA-256"); hash.update(buffer, 0, bytes);
                String sha = CoreUpdateManager.hex(hash.digest());
                pieces.put(new JSONObject().put("index", pieces.length()).put("offset", offset).put("bytes", bytes).put("sha256", sha)
                    .put("url", CoreUpdateChunks.ORIGIN + "/assets/chunks/" + sha + ".part")); offset += bytes;
            }
        }
        manifest = new JSONObject().put("schemaVersion", 1).put("name", NAME).put("bytes", fixture.length()).put("sha256", digest).put("sourceUrl", SOURCE).put("parts", pieces);
        parts = CoreUpdateChunks.parse(manifest, CoreUpdateRelease.parse(release, "0.2.0-beta2", "latest"));
    }
    @After public void tearDown() { if (fixture != null) fixture.delete(); CoreUpdateTestState.reset(context); }
    private byte[] text(Object value) { return value.toString().getBytes(StandardCharsets.UTF_8); }
    private CoreUpdateManager manager() {
        return new CoreUpdateManager(context, url -> {
            String address = url.toString(); requests.put(address, requests.getOrDefault(address, 0) + 1);
            return new HttpURLConnection(url) {
                private InputStream stream;
                private int part() { for (int i = 0; i < parts.size(); i++) if (parts.get(i).url.equals(address)) return i; return -1; }
                @Override public int getResponseCode() {
                    if (address.contains("/channels/")) return pagesStatus;
                    if (part() == unavailable && part() >= 0) return 503;
                    if (address.equals(SOURCE) && getRequestProperty("Range") != null) return 206;
                    return 200;
                }
                @Override public String getHeaderField(String key) {
                    if (key.equalsIgnoreCase("Content-Range") && getRequestProperty("Range") != null)
                        return invalidRange ? "bytes 0-0/1" : getRequestProperty("Range").replace("bytes=", "bytes ") + "/" + fixture.length();
                    return null;
                }
                @Override public InputStream getInputStream() throws IOException {
                    try {
                        if (address.contains("/channels/")) {
                            String channel = address.contains("/stable.") ? "stable" : "latest";
                            stream = new ByteArrayInputStream(text(new JSONObject().put("schemaVersion", 1).put("channel", channel).put("release", empty ? JSONObject.NULL : release)));
                        } else if (address.equals(MANIFEST)) stream = new ByteArrayInputStream(text(manifest));
                        else if (url.getHost().equals("api.github.com")) stream = new ByteArrayInputStream(text(url.getQuery() == null ? release : new JSONArray().put(release)));
                        else {
                            int index = part(); long offset = index < 0 ? 0 : parts.get(index).offset, length = index < 0 ? fixture.length() : parts.get(index).bytes;
                            String range = getRequestProperty("Range");
                            if (range != null) { String[] bounds = range.substring(6).split("-"); offset = Long.parseLong(bounds[0]); length = Long.parseLong(bounds[1]) - offset + 1; }
                            FileInputStream input = new FileInputStream(fixture); input.getChannel().position(offset);
                            final long size = length; final boolean damaged = index == corrupt && index >= 0;
                            stream = new FilterInputStream(input) {
                                long remaining = size; boolean flipped;
                                @Override public int read(byte[] buffer, int start, int length) throws IOException {
                                    if (remaining == 0) return -1;
                                    int count = in.read(buffer, start, (int) Math.min(remaining, length));
                                    if (count > 0) { remaining -= count; if (damaged && !flipped) { buffer[start] ^= 1; flipped = true; } }
                                    return count;
                                }
                            };
                        }
                        return stream;
                    } catch (Exception error) { throw new IOException(error); }
                }
                @Override public void connect() { }
                @Override public void disconnect() { try { if (stream != null) stream.close(); } catch (Exception ignored) { } }
                @Override public boolean usingProxy() { return false; }
            };
        });
    }
    private File partFile(int index) throws Exception { return new File(context.getFilesDir(), "core-update-parts/" + manifest.getString("sha256") + "/" + parts.get(index).sha256 + ".part"); }
    private void download(CoreUpdateManager manager) throws Exception { manager.check("latest"); manager.download(TAG, "latest", (phase, completed, total) -> {}); }
    private void rejects(String fragment, Throwing action) throws Exception {
        try { action.run(); fail("Expected rejection: " + fragment); } catch (IOException expected) { assertTrue(expected.getMessage(), expected.getMessage().contains(fragment)); }
    }
    interface Throwing { void run() throws Exception; }
    @Test public void pagesChunksPrepareRealSignedApkAndRestoreItsReceipt() throws Exception {
        CoreUpdateManager manager = manager(); download(manager);
        assertEquals(CoreUpdateDownloader.digest(fixture), CoreUpdateDownloader.digest(manager.preparedApk("latest")));
        assertNotNull(new CoreUpdateManager(context).ready("latest"));
        assertTrue(requests.keySet().stream().allMatch(url -> url.startsWith(CoreUpdateChunks.ORIGIN)));
    }
    @Test public void legacyPreparedReceiptRemainsInstallable() throws Exception {
        CoreUpdateManager manager = manager(); download(manager);
        JSONObject receipt = new JSONObject(context.getSharedPreferences("core-updates", 0).getString("ready", "{}"));
        File legacy = new File(context.getCacheDir(), "core-updates/update.apk");
        assertTrue(manager.preparedApk("latest").renameTo(legacy));
        receipt.remove("file");
        context.getSharedPreferences("core-updates", 0).edit().putString("ready", receipt.toString()).commit();
        assertEquals(CoreUpdateDownloader.digest(fixture), CoreUpdateDownloader.digest(new CoreUpdateManager(context).preparedApk("latest")));
    }
    @Test public void noReleaseAndCurrentDoNotConsultGithub() throws Exception {
        empty = true; assertEquals("no-release", manager().check("stable").getString("state"));
        empty = false; release.put("tag_name", "v0.1.0"); assertEquals("current", manager().check("latest").getString("state"));
        assertTrue(requests.keySet().stream().allMatch(url -> url.startsWith(CoreUpdateChunks.ORIGIN)));
    }
    @Test public void cancellationAndManagerRestartReuseOnlyPersistedVerifiedParts() throws Exception {
        CoreUpdateManager first = manager(); first.check("latest");
        rejects("取消", () -> first.download(TAG, "latest", (phase, completed, total) -> { try { if (partFile(0).isFile()) first.cancel(); } catch (Exception error) { throw new RuntimeException(error); } }));
        assertNull(first.ready("latest")); assertTrue(partFile(0).isFile());
        requests.clear(); CoreUpdateManager second = manager(); download(second);
        assertEquals(0, requests.getOrDefault(parts.get(0).url, 0).intValue());
        assertEquals(CoreUpdateDownloader.digest(fixture), CoreUpdateDownloader.digest(second.preparedApk("latest")));
    }
    @Test public void corruptRemotePartNeverUsesGithubAndRetryKeepsOtherParts() throws Exception {
        corrupt = 1; CoreUpdateManager first = manager(); rejects("校验失败", () -> download(first));
        assertNull(first.ready("latest")); assertFalse(requests.containsKey(SOURCE)); assertTrue(partFile(0).isFile());
        corrupt = -1; requests.clear(); download(manager()); assertFalse(requests.containsKey(parts.get(0).url));
    }
    @Test public void corruptLocalPartIsFetchedAgain() throws Exception {
        CoreUpdateManager first = manager(); first.check("latest");
        rejects("取消", () -> first.download(TAG, "latest", (phase, completed, total) -> { try { if (partFile(0).isFile()) first.cancel(); } catch (Exception error) { throw new RuntimeException(error); } }));
        try (RandomAccessFile file = new RandomAccessFile(partFile(0), "rw")) { file.seek(0); file.write(0); file.write(0); }
        requests.clear(); download(manager()); assertEquals(1, requests.get(parts.get(0).url).intValue());
    }
    @Test public void unavailablePagesChunkUsesPinnedGithubRange() throws Exception {
        unavailable = 1; CoreUpdateManager manager = manager(); download(manager);
        assertEquals(1, requests.get(SOURCE).intValue()); assertFalse(requests.keySet().stream().anyMatch(url -> url.startsWith(CoreUpdateRelease.RELEASES_URL)));
        assertEquals(CoreUpdateDownloader.digest(fixture), CoreUpdateDownloader.digest(manager.preparedApk("latest")));
    }
    @Test public void wrongGithubRangeCannotPrepareInstallation() throws Exception {
        unavailable = 1; invalidRange = true; CoreUpdateManager manager = manager(); rejects("正确分段", () -> download(manager)); assertNull(manager.ready("latest"));
    }
    @Test public void pageMetadataOutageAllowsGithubButIdentityConflictsNeverDo() throws Exception {
        pagesStatus = 503; assertEquals("available", manager().check("latest").getString("state"));
        pagesStatus = 200; requests.clear(); manifest.put("sha256", "0".repeat(64));
        rejects("不匹配", () -> download(manager())); assertFalse(requests.containsKey(SOURCE));
    }
    @Test public void sameVersionHashChangeKeepsTheOldVerifiedTargetAndReceipt() throws Exception {
        CoreUpdateManager manager = manager(); download(manager); File original = manager.preparedApk("latest");
        String receipt = context.getSharedPreferences("core-updates", 0).getString("ready", null);
        release.getJSONArray("assets").getJSONObject(0).put("digest", "sha256:" + "0".repeat(64));
        rejects("身份或摘要已变化", () -> download(manager()));
        assertEquals(receipt, context.getSharedPreferences("core-updates", 0).getString("ready", null));
        assertEquals(CoreUpdateDownloader.digest(fixture), CoreUpdateDownloader.digest(original));
    }
}
