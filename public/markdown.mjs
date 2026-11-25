// Shared by the browser and the CLI. Escape each Markdown field in its own context.
export function imageMarkdown({ alt, url, caption, widthPercent }) {
  const oneLine = text => text.replace(/[\r\n]+/g, " ");
  const label = oneLine(alt).replace(/[\\\[\]`*_<>!&]/g, "\\$&");
  const destination = url.replace(/[()]/g, char => char === "(" ? "%28" : "%29")
    .replace(/[\s<>\\]/gu, encodeURIComponent);
  const title = caption ? ' "' + oneLine(caption).replace(/[\\"]/g, "\\$&") + '"' : "";
  return `![${label}${widthPercent ? ` w-${widthPercent}%` : ""}](${destination}${title})`;
}
