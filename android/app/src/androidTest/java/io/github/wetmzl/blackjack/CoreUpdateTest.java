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
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(AndroidJUnit4.class)
public class CoreUpdateTest {
    private Context context;
    private File fixture;
    @Before public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        CoreUpdateTestState.reset(context);
        context.getSharedPreferences("core-updates", 0).edit().clear().commit();
        File directory = new File(context.getCacheDir(), "core-updates");
        if (directory.exists()) for (File file : directory.listFiles()) file.delete();
        fixture = new File(context.getCacheDir(), "test-update.apk");
        InputStream fixtureInput;
        try { fixtureInput = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("update-fixture.apk"); }
        catch (IOException missing) { Assume.assumeNoException("Generate signed update test assets before running the updater integration tests", missing); return; }
        try (InputStream input = fixtureInput; OutputStream output = new FileOutputStream(fixture)) {
            byte[] buffer = new byte[65536]; int n; while ((n = input.read(buffer)) != -1) output.write(buffer, 0, n);
        }
    }
    @After public void tearDown() { fixture.delete(); }
    private String digest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[65536]; int n; while ((n = input.read(buffer)) != -1) digest.update(buffer, 0, n); }
        return CoreUpdateManager.hex(digest.digest());
    }
    private JSONObject release(File file) throws Exception {
        JSONObject asset = new JSONObject().put("name", "HoC-Core-1.0.0.apk").put("state", "uploaded")
            .put("size", file.length()).put("digest", "sha256:" + digest(file))
            .put("browser_download_url", "https://github.com/wetmzl/HoC-Core/releases/download/v1.0.0/HoC-Core-1.0.0.apk");
        return new JSONObject().put("tag_name", "v1.0.0").put("body", "稳定版更新说明").put("draft", false).put("prerelease", false).put("assets", new JSONArray().put(asset));
    }
    private HttpURLConnection response(URL url, int status, InputStream body) {
        return new HttpURLConnection(url) {
            @Override public int getResponseCode() { return status; }
            @Override public InputStream getInputStream() { return body; }
            @Override public void connect() {}
            @Override public void disconnect() { try { body.close(); } catch (Exception ignored) {} }
            @Override public boolean usingProxy() { return false; }
        };
    }
    private CoreUpdateManager manager(JSONObject release, File download) {
        return new CoreUpdateManager(context, url -> {
            if (url.getHost().equals("hoc-core-updates.pages.dev")) return response(url, 503, new ByteArrayInputStream(new byte[0]));
            InputStream body = url.getHost().equals("api.github.com") ? new ByteArrayInputStream((url.getQuery() == null ? release.toString() : new JSONArray().put(release).toString()).getBytes(java.nio.charset.StandardCharsets.UTF_8)) : new FileInputStream(download);
            return response(url, 200, body);
        });
    }
    private void rejects(String fragment, ThrowingRunnable operation) throws Exception {
        try { operation.run(); fail("must reject: " + fragment); }
        catch (IOException expected) { assertTrue(expected.getMessage(), expected.getMessage().contains(fragment)); }
    }
    interface ThrowingRunnable { void run() throws Exception; }

    @Test public void comparesStableSemverAndNeverDowngrades() {
        assertTrue(CoreUpdateRelease.newerStable("v0.2.0", "0.2.0-beta2"));
        assertTrue(CoreUpdateRelease.newerStable("1.10.0", "1.9.99"));
        assertFalse(CoreUpdateRelease.newerStable("0.1.0", "0.2.0-beta2"));
        assertFalse(CoreUpdateRelease.newerStable("1.0.0-beta1", "0.2.0"));
        assertFalse(CoreUpdateRelease.newerStable("1.0.0", "1.0.0"));
        assertFalse(CoreUpdateRelease.newerStable("junk", "0.2.0"));
    }
    @Test public void excludesPrereleasesDraftsWrongAssetsAndUntrustedMetadata() throws Exception {
        JSONObject data = release(fixture);
        assertNull(CoreUpdateRelease.parse(new JSONObject(data.toString()).put("prerelease", true), "0.2.0"));
        assertNull(CoreUpdateRelease.parse(new JSONObject(data.toString()).put("draft", true), "0.2.0"));
        JSONObject apk = data.getJSONArray("assets").getJSONObject(0);
        apk.put("digest", JSONObject.NULL);
        rejects("校验信息", () -> CoreUpdateRelease.parse(data, "0.2.0"));
        apk.put("digest", "sha256:" + digest(fixture)).put("browser_download_url", "https://example.com/update.apk");
        rejects("地址", () -> CoreUpdateRelease.parse(data, "0.2.0"));
        apk.put("name", "other.apk");
        rejects("尚未提供", () -> CoreUpdateRelease.parse(data, "0.2.0"));
    }
    @Test public void missingStableReleaseIsNormalAndRateLimitIsActionable() throws Exception {
        CoreUpdateManager missing = new CoreUpdateManager(context, url -> response(url, 404, new ByteArrayInputStream(new byte[0])));
        assertEquals("no-release", missing.check().getString("state"));
        CoreUpdateManager limited = new CoreUpdateManager(context, url -> response(url, 403, new ByteArrayInputStream(new byte[0])));
        rejects("网页", limited::check);
    }
    @Test public void downloadsVerifiesAndRestoresPreparedUpdateAcrossManagerRestart() throws Exception {
        CoreUpdateManager manager = manager(release(fixture), fixture);
        assertEquals("available", manager.check().getString("state"));
        AtomicInteger progress = new AtomicInteger();
        assertEquals("1.0.0", manager.download("v1.0.0", (phase, completed, total) -> progress.incrementAndGet()).getString("version"));
        assertTrue(progress.get() > 0);
        CoreUpdateManager restarted = new CoreUpdateManager(context);
        assertEquals("1.0.0", restarted.status().getJSONObject("ready").getString("version"));
        assertEquals(digest(fixture), digest(restarted.preparedApk()));
    }
    @Test public void downloadedPrereleaseRemainsExcludedAfterSwitchingBackToStable() throws Exception {
        CoreUpdateManager manager = manager(release(fixture).put("prerelease", true), fixture);
        assertEquals("available", manager.check("latest").getString("state"));
        manager.download("v1.0.0", "latest", (phase, completed, total) -> {});
        assertNull(manager.status("stable").optJSONObject("ready"));
        rejects("没有可安装", () -> manager.preparedApk("stable"));
        CoreUpdateManager restarted = new CoreUpdateManager(context);
        assertTrue(restarted.status("latest").getJSONObject("ready").getBoolean("prerelease"));
        assertEquals(digest(fixture), digest(restarted.preparedApk("latest")));
    }
    @Test public void rejectsTruncatedDownloadsAndCleansTemporaryFiles() throws Exception {
        JSONObject data = release(fixture); data.getJSONArray("assets").getJSONObject(0).put("size", fixture.length() + 1);
        CoreUpdateManager manager = manager(data, fixture); manager.check();
        rejects("不完整", () -> manager.download("v1.0.0", (phase, completed, total) -> {}));
        assertNull(manager.ready()); assertFalse(new File(context.getCacheDir(), "core-updates/download.part").exists());
    }
    @Test public void rejectsDigestMismatchAndCancellationWithoutPreparingAnUpdate() throws Exception {
        JSONObject data = release(fixture); data.getJSONArray("assets").getJSONObject(0).put("digest", "sha256:" + "0".repeat(64));
        CoreUpdateManager bad = manager(data, fixture); bad.check();
        rejects("校验失败", () -> bad.download("v1.0.0", (phase, completed, total) -> {})); assertNull(bad.ready());
        CoreUpdateTestState.reset(context);
        CoreUpdateManager cancelled = manager(release(fixture), fixture); cancelled.check();
        rejects("取消", () -> cancelled.download("v1.0.0", (phase, completed, total) -> { if (phase.equals("downloading")) cancelled.cancel(); }));
        assertNull(cancelled.ready());
    }
    @Test public void rejectsForeignPackageOlderVersionAndWrongSigner() throws Exception {
        CoreUpdateManager manager = new CoreUpdateManager(context);
        File testApk = new File(InstrumentationRegistry.getInstrumentation().getContext().getApplicationInfo().sourceDir);
        rejects("身份不匹配", () -> manager.verifyApk(testApk, "1.0.0"));
        rejects("版本", () -> manager.verifyApk(new File(context.getApplicationInfo().sourceDir), "1.0.0"));
        File wrongSigner = new File(context.getCacheDir(), "wrong-signer.apk");
        try (InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("wrong-signer.apk"); OutputStream output = new FileOutputStream(wrongSigner)) {
            byte[] buffer = new byte[65536]; int n; while ((n = input.read(buffer)) != -1) output.write(buffer, 0, n);
        }
        try { rejects("签名不匹配", () -> manager.verifyApk(wrongSigner, "1.0.0")); }
        finally { wrongSigner.delete(); }
    }
    @Test public void detectsTamperingAgainImmediatelyBeforeInstallation() throws Exception {
        CoreUpdateManager manager = manager(release(fixture), fixture); manager.check(); manager.download("v1.0.0", (phase, completed, total) -> {});
        File apk = manager.preparedApk();
        try (RandomAccessFile file = new RandomAccessFile(apk, "rw")) { file.seek(100); file.write(42); }
        rejects("已损坏", manager::preparedApk); assertNull(manager.ready());
    }
    @Test public void refusesHttpsDowngradesAndUnexpectedRedirectHosts() throws Exception {
        for (String target : new String[] {"http://github.com/a.apk", "https://example.com/a.apk"}) {
            CoreUpdateManager manager = new CoreUpdateManager(context, url -> new HttpURLConnection(url) {
                @Override public int getResponseCode() { return 302; }
                @Override public String getHeaderField(String name) { return target; }
                @Override public void connect() {} @Override public void disconnect() {} @Override public boolean usingProxy() { return false; }
            });
            rejects("不受信任", manager::check);
        }
    }
}
