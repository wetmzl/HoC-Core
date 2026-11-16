package io.github.wetmzl.blackjack;

import static org.junit.Assert.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

@RunWith(AndroidJUnit4.class)
public class CoreUpdateWebTest {
    @org.junit.Before public void resetUpdates() { CoreUpdateTestState.reset(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext()); }
    private static final String TAG = "v1.0.0-beta.10", NAME = "HoC-Core-1.0.0-beta.10.apk";
    private static String index(int page, String... tags) throws Exception {
        JSONArray toc = new JSONArray();
        for (String tag : tags) toc.put(new JSONObject().put("anchorId", "release-" + tag));
        JSONObject route = new JSONObject().put("repository", new JSONObject().put("ownerLogin", "wetmzl").put("name", "HoC-Core"))
            .put("page", page).put("toc", toc);
        return "<script type=\"application/json\" data-target=\"react-app.embeddedData\">" + new JSONObject().put("payload", new JSONObject().put("releasesIndexRoute", route)) + "</script>";
    }
    private static String page(String tag, boolean prerelease) {
        return (prerelease ? "<span class=\"Label Label--warning\">Pre-release</span>" : "")
            + "<div data-test-selector=\"body-content\"><p>网页发布日志 &amp; 验证</p><script>unsafe()</script><div>第二段</div></div>"
            + "<include-fragment src=\"" + CoreUpdateWeb.RELEASES_URL + "/expanded_assets/" + tag + "\"></include-fragment>";
    }
    private static class Transport implements CoreUpdateManager.ConnectionFactory {
        String sums = "a".repeat(64) + "  " + NAME + "\n";
        String length = "100";
        int apiStatus = 403;
        boolean noStable = true;
        final List<String> requests = new ArrayList<>();
        @Override public HttpURLConnection open(URL url) {
            requests.add(url.toString());
            return new HttpURLConnection(url) {
                @Override public int getResponseCode() {
                    assertNull(getRequestProperty("Authorization")); assertNull(getRequestProperty("Cookie"));
                    if (url.getHost().equals("hoc-core-updates.pages.dev")) return 503;
                    if (url.getHost().equals("api.github.com")) return apiStatus;
                    if (url.getPath().endsWith("/latest")) return 302;
                    return 200;
                }
                @Override public String getHeaderField(String name) {
                    if (name.equalsIgnoreCase("Location")) return noStable ? CoreUpdateWeb.RELEASES_URL : CoreUpdateWeb.RELEASES_URL + "/tag/v1.0.0";
                    if (name.equalsIgnoreCase("Content-Length")) return length;
                    return null;
                }
                @Override public long getContentLengthLong() { try { return Long.parseLong(length); } catch (Exception error) { return -1; } }
                @Override public InputStream getInputStream() throws IOException {
                    try {
                        String text;
                        if (url.getHost().equals("api.github.com")) text = "{}";
                        else if (url.getQuery() != null && url.getQuery().equals("page=1")) text = index(1, "v1.0.0-beta.2");
                        else if (url.getQuery() != null && url.getQuery().equals("page=2")) text = index(2, "not-semver");
                        else if (url.getQuery() != null && url.getQuery().equals("page=3")) text = index(3, TAG);
                        else if (url.getQuery() != null) text = index(4);
                        else if (url.getPath().endsWith("/SHA256SUMS")) text = sums;
                        else if (url.getPath().endsWith("/tag/" + TAG)) text = page(TAG, true);
                        else if (url.getPath().endsWith("/tag/v1.0.0")) text = page("v1.0.0", true);
                        else if (url.getPath().endsWith(".apk")) text = "x".repeat(100);
                        else text = "public releases";
                        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
                    } catch (Exception error) { throw new IOException(error); }
                }
                @Override public void connect() {} @Override public void disconnect() {} @Override public boolean usingProxy() { return false; }
            };
        }
    }
    private CoreUpdateManager manager(Transport transport) {
        return new CoreUpdateManager(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext(), transport);
    }
    @Test public void rateLimitedCheckUsesWebsiteAcrossPagesAndKeepsDownloadIntegrity() throws Exception {
        Transport transport = new Transport(); CoreUpdateManager manager = manager(transport);
        JSONObject result = manager.check("latest");
        assertEquals("available", result.getString("state"));
        JSONObject release = result.getJSONObject("release");
        assertEquals("1.0.0-beta.10", release.getString("version"));
        assertEquals("a".repeat(64), release.getString("sha256")); assertEquals(100, release.getLong("bytes"));
        assertTrue(release.getBoolean("prerelease")); assertTrue(release.getString("notes").contains("网页发布日志 & 验证"));
        assertFalse(release.getString("notes").contains("unsafe()"));
        try { manager.download(TAG, "latest", (phase, completed, total) -> {}); fail("Corrupt download accepted"); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("校验失败")); }
        assertNull(manager.ready("latest"));
        assertEquals(1, transport.requests.stream().filter(url -> url.startsWith(CoreUpdateRelease.RELEASES_URL)).count());
    }
    @Test public void stableNeverSubstitutesBetaOrAcceptsAnExplicitPrereleaseFlag() throws Exception {
        Transport transport = new Transport(); CoreUpdateManager manager = manager(transport);
        assertEquals("no-release", manager.check("stable").getString("state"));
        transport.noStable = false;
        try { manager.check("stable"); fail("Prerelease accepted as stable"); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("稳定版网页信息无效")); }
    }
    @Test public void missingChecksumsAndInvalidSizesNeverPrepareAnUpdate() throws Exception {
        Transport transport = new Transport(); CoreUpdateManager manager = manager(transport);
        for (String sums : new String[] { "", "invalid  " + NAME, "a".repeat(64) + "  " + NAME + "\n" + "a".repeat(64) + "  " + NAME }) {
            transport.sums = sums;
            try { manager.check("latest"); fail("Invalid checksum accepted"); } catch (IOException expected) { assertTrue(expected.getMessage().contains("校验")); }
        }
        transport.sums = "a".repeat(64) + "  " + NAME;
        for (String length : new String[] { "0", "-1", "invalid", Long.toString(CoreUpdateRelease.MAX_APK_BYTES + 1) }) {
            transport.length = length;
            try { manager.check("latest"); fail("Invalid size accepted"); } catch (IOException expected) { assertTrue(expected.getMessage().contains("大小")); }
        }
    }
    @Test public void rejectsChangedLayoutsForeignRepositoriesAndForgedVersionsInBody() throws Exception {
        try { CoreUpdateWeb.index("<html>changed</html>", 1); fail("Unknown layout accepted"); } catch (IOException expected) { }
        try { CoreUpdateWeb.index(index(1).replace("wetmzl", "someone"), 1); fail("Foreign repository accepted"); } catch (IOException expected) { }
        try { CoreUpdateWeb.index(index(2), 1); fail("Repeated page accepted"); } catch (IOException expected) { }
        try { CoreUpdateWeb.release(page(TAG, true), "v9.0.0"); fail("Wrong tag accepted"); } catch (IOException expected) { }
        String withFakeBadge = page("v1.0.0", false).replace("<p>", "<p><span class=\"Label Label--warning\">Pre-release</span>");
        assertFalse(CoreUpdateWeb.release(withFakeBadge, "v1.0.0").getBoolean("prerelease"));
    }
}
