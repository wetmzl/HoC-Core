import { compareHocpkgVersions } from "../content/packages/package-state";

/** Atom 仅用于展示日志，不能作为更新通道、安装包或校验信息的来源。 */
export function latestReleaseNotes(feed: string): { tag: string; notes: string } | undefined {
  if (feed.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(feed)) throw new Error("发布日志格式无效。");
  const xml = new DOMParser().parseFromString(feed, "application/xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "feed" || xml.documentElement.namespaceURI !== "http://www.w3.org/2005/Atom")
    throw new Error("发布日志格式无效。");
  const entries = [...xml.getElementsByTagNameNS("http://www.w3.org/2005/Atom", "entry")].flatMap(entry => {
    const link = [...entry.getElementsByTagNameNS("http://www.w3.org/2005/Atom", "link")].find(item => item.getAttribute("rel") === "alternate");
    const match = link?.getAttribute("href")?.match(/^https:\/\/github\.com\/wetmzl\/HoC-Core\/releases\/tag\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
    const content = entry.getElementsByTagNameNS("http://www.w3.org/2005/Atom", "content")[0];
    if (!match || !content || !["html", "text"].includes(content.getAttribute("type") ?? "text")) return [];
    let notes = content.textContent ?? "";
    if (content.getAttribute("type") === "html") {
      // template 保持离线、惰性；只取文本，绝不把远程 HTML 插入页面。
      const template = document.createElement("template");
      template.innerHTML = notes;
      const text = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        const name = node.nodeName.toLowerCase();
        if (["script", "style", "iframe", "object", "template", "svg", "math"].includes(name)) return "";
        const value = [...node.childNodes].map(text).join("");
        return name === "br" ? "\n" : /^(p|div|h[1-6]|ul|ol|li|pre|blockquote)$/.test(name) ? `${value}\n\n` : value;
      };
      notes = text(template.content);
    }
    return [{ tag: match[1]!, notes: notes.replace(/\n[\t ]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000) }];
  });
  return entries.sort((a, b) => compareHocpkgVersions(b.tag.replace(/^v/, ""), a.tag.replace(/^v/, "")))[0];
}
