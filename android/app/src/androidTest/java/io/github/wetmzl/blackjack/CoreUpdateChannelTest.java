package io.github.wetmzl.blackjack;

import static org.junit.Assert.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

@RunWith(AndroidJUnit4.class)
public class CoreUpdateChannelTest {
    @org.junit.Before public void resetUpdates() { CoreUpdateTestState.reset(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext()); }
    private JSONObject release(String version, boolean prerelease) throws Exception {
        String name = "HoC-Core-" + version + ".apk";
        return new JSONObject().put("tag_name", "v" + version).put("prerelease", prerelease)
            .put("assets", new JSONArray().put(new JSONObject().put("name", name).put("state", "uploaded")
                .put("size", 100).put("digest", "sha256:" + "a".repeat(64))
                .put("browser_download_url", "https://github.com/wetmzl/HoC-Core/releases/download/v" + version + "/" + name)));
    }
    @Test public void latestAcceptsPrereleasesButStableDoesNot() throws Exception {
        JSONObject data = release("1.0.0-beta.3", true);
        assertNull(CoreUpdateRelease.parse(data, "0.2.0-beta2", "stable"));
        assertTrue(CoreUpdateRelease.parse(data, "0.2.0-beta2", "latest").prerelease);
        data.put("prerelease", false);
        assertNull(CoreUpdateRelease.parse(data, "0.2.0-beta2", "stable"));
        data.put("draft", true);
        assertNull(CoreUpdateRelease.parse(data, "0.2.0-beta2", "latest"));
    }
    @Test public void comparesNumericPrereleasePartsAndNeverDowngrades() throws Exception {
        assertTrue(CoreUpdateRelease.newer("1.0.0-beta.10", "1.0.0-beta.2", "latest"));
        assertFalse(CoreUpdateRelease.newer("1.0.0-beta.2", "1.0.0-beta.10", "latest"));
        assertTrue(CoreUpdateRelease.newer("1.0.0", "1.0.0-beta.10", "stable"));
        assertFalse(CoreUpdateRelease.newer("1.0.0-beta.10", "1.0.0", "latest"));
        assertFalse(CoreUpdateRelease.newer("1.0.0+build.2", "1.0.0", "latest"));
        assertFalse(CoreUpdateRelease.newer("0.1.0", "0.2.0-beta2", "stable"));
        assertNull(CoreUpdateRelease.parse(release("0.1.0", false), "0.2.0-beta2", "stable"));
    }
    @Test public void rejectsInvalidChannelsAndUntrustedPrereleaseAssets() throws Exception {
        try { CoreUpdateRelease.channel("nightly"); fail("Invalid channel accepted"); } catch (java.io.IOException expected) { }
        JSONObject data = release("1.0.0-beta.1", true);
        data.getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://example.com/update.apk");
        try { CoreUpdateRelease.parse(data, "0.2.0", "latest"); fail("Untrusted URL accepted"); } catch (java.io.IOException expected) { }
    }
    @Test public void latestSelectsHighestVersionAcrossPagesRatherThanUploadOrder() throws Exception {
        android.content.Context context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext();
        CoreUpdateManager manager = new CoreUpdateManager(context, url -> new java.net.HttpURLConnection(url) {
            @Override public int getResponseCode() { return url.getHost().equals("hoc-core-updates.pages.dev") ? 503 : 200; }
            @Override public java.io.InputStream getInputStream() throws java.io.IOException {
                try {
                    JSONArray page = new JSONArray();
                    if (url.getQuery().endsWith("page=1")) { for (int i = 0; i < 100; i++) page.put(release("0.1.0", false)); }
                    else page.put(release("1.0.0-beta.2", true)).put(release("1.0.0-beta.10", true));
                    return new java.io.ByteArrayInputStream(page.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                } catch (Exception error) { throw new java.io.IOException(error); }
            }
            @Override public void connect() {} @Override public void disconnect() {} @Override public boolean usingProxy() { return false; }
        });
        assertEquals("1.0.0-beta.10", manager.check("latest").getJSONObject("release").getString("version"));
    }

    @Test public void releaseNotesUseFixedAnonymousFeedAndRejectOversizedResponses() throws Exception {
        android.content.Context context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext();
        String[] body = { "<feed>发布日志</feed>" };
        CoreUpdateManager manager = new CoreUpdateManager(context, url -> {
            assertEquals("https://github.com/wetmzl/HoC-Core/releases.atom", url.toString());
            return new java.net.HttpURLConnection(url) {
                @Override public int getResponseCode() {
                    assertNull(getRequestProperty("Authorization"));
                    assertNull(getRequestProperty("Cookie"));
                    return 200;
                }
                @Override public java.io.InputStream getInputStream() {
                    return new java.io.ByteArrayInputStream(body[0].getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                @Override public void connect() {} @Override public void disconnect() {} @Override public boolean usingProxy() { return false; }
            };
        });
        assertEquals(body[0], manager.releaseNotes());
        body[0] = "x".repeat(1024 * 1024 + 1);
        try { manager.releaseNotes(); fail("Oversized feed accepted"); }
        catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("日志过大")); }
    }

}
