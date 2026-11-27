// iOS Safari appends `.xml` to a `text/xml` download. It has no extension for `text/x-opml`.
const OPML_MIME_TYPE = "text/x-opml;charset=utf-8";

export function downloadOPML(content: string, filename: string) {
  const blob = new Blob([content], { type: OPML_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
