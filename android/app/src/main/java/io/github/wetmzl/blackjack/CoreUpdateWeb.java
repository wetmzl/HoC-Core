package io.github.wetmzl.blackjack;

import android.text.Html;
import org.json.*;
import java.io.IOException;
import java.util.*;
import java.util.regex.*;

/** 公开网页只提供版本与正文；安装包摘要来自同一 Release 的 SHA256SUMS。 */
final class CoreUpdateWeb {
    static final String RELEASES_URL = "https://github.com/" + CoreUpdateRelease.REPOSITORY + "/releases";
    private static final Pattern INDEX = Pattern.compile("<script\\b(?=[^>]*\\btype=\"application/json\")(?=[^>]*\\bdata-target=\"react-app\\.embeddedData\")[^>]*>([\\s\\S]*?)</script>", Pattern.CASE_INSENSITIVE);
    static JSONArray index(String html, int page) throws Exception {
        Matcher scripts = INDEX.matcher(html);
        if (!scripts.find()) throw new IOException("GitHub 网页发布目录格式已变化，请稍后重试。");
        JSONObject route = new JSONObject(scripts.group(1)).getJSONObject("payload").getJSONObject("releasesIndexRoute");
        if (scripts.find()) throw new IOException("GitHub 网页发布目录无效。");
        JSONObject repository = route.getJSONObject("repository");
        if (!"wetmzl".equals(repository.optString("ownerLogin")) || !"HoC-Core".equals(repository.optString("name")) || route.getInt("page") != page)
            throw new IOException("GitHub 网页发布目录无效。");
        JSONArray toc = route.getJSONArray("toc"), releases = new JSONArray();
        for (int i = 0; i < toc.length(); i++) {
            String anchor = toc.getJSONObject(i).optString("anchorId");
            releases.put(new JSONObject().put("tag_name", anchor.startsWith("release-") ? anchor.substring(8) : ""));
        }
        return releases;
    }
    static JSONObject release(String html, String tag) throws Exception {
        if (!html.contains("src=\"" + RELEASES_URL + "/expanded_assets/" + tag + "\"")) throw new IOException("GitHub 网页发布信息无效。");
        Matcher body = Pattern.compile("<div\\b[^>]*\\bdata-test-selector=\"body-content\"[^>]*>", Pattern.CASE_INSENSITIVE).matcher(html);
        String notes = "", header = html;
        if (body.find()) {
            header = html.substring(0, body.start());
            int start = body.end(), depth = 1, end = -1;
            Matcher divs = Pattern.compile("</?div\\b[^>]*>", Pattern.CASE_INSENSITIVE).matcher(html);
            divs.region(start, html.length());
            while (divs.find()) {
                depth += divs.group().startsWith("</") ? -1 : 1;
                if (depth == 0) { end = divs.start(); break; }
            }
            if (end < 0) throw new IOException("GitHub 网页发布正文无效。");
            String markup = html.substring(start, end).replaceAll("(?is)<(script|style)\\b[^>]*>[\\s\\S]*?</\\1>", "");
            // Html.fromHtml 不使用 ImageGetter，既不创建 WebView，也不发起图片请求。
            notes = Html.fromHtml(markup, Html.FROM_HTML_MODE_LEGACY).toString().trim();
            notes = notes.substring(0, Math.min(notes.length(), 8000));
        }
        boolean prerelease = Pattern.compile("<span\\b[^>]*\\bclass=\"[^\"]*\\bLabel--warning\\b[^\"]*\"[^>]*>\\s*Pre-release\\s*</span>", Pattern.CASE_INSENSITIVE).matcher(header).find();
        return new JSONObject().put("tag_name", tag).put("prerelease", prerelease).put("body", notes);
    }
    static Map<String, String> checksums(String text) throws IOException {
        Map<String, String> result = new HashMap<>();
        Pattern linePattern = Pattern.compile("^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$");
        for (String line : text.split("\\r?\\n")) {
            if (line.trim().isEmpty()) continue;
            Matcher match = linePattern.matcher(line);
            if (!match.matches() || result.containsKey(match.group(2))) throw new IOException("发布校验清单格式无效或包含重复文件。");
            result.put(match.group(2), match.group(1).toLowerCase(Locale.ROOT));
        }
        return result;
    }
}
