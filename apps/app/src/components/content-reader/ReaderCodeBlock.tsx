import parse, { Element, Text } from "html-react-parser";
import { useEffect, useMemo, useState } from "react";
import { canHighlightCode } from "./codeHighlightingPolicy";
import type { DOMNode } from "html-react-parser";

function codeText(node: DOMNode): string {
  if (node instanceof Text) return node.data;
  if (!(node instanceof Element)) return "";
  if (node.name === "br") return "\n";
  return node.children.map((child) => codeText(child as DOMNode)).join("");
}

function codeLanguage(node: Element): string | undefined {
  const classes = node.attribs.class ?? "";
  if (/(?:^|\s)(?:no-highlight|nohighlight)(?:\s|$)/i.test(classes))
    return "text";
  return (
    /(?:^|\s)lang(?:uage)?-([\w+-]+)/i.exec(classes)?.[1]?.toLowerCase() ??
    node.attribs["data-language"]?.toLowerCase()
  );
}

function ReaderCodeBlock({
  code,
  language,
  id,
  dir,
  label,
}: {
  code: string;
  language?: string;
  id?: string;
  dir?: string;
  label?: string;
}) {
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language?: string;
    html: string | null;
  }>();

  useEffect(() => {
    let active = true;
    let cancel = () => {};
    if (!canHighlightCode(code, language)) return;
    // Load only for articles with code. The plain block is readable immediately.
    void import("./highlightCodeClient")
      .then(({ requestCodeHighlight }) => {
        if (active)
          cancel = requestCodeHighlight(code, language, (html) => {
            setHighlighted({ code, language, html });
          });
      })
      .catch(() => {
        /* Keep plain text when offline or a chunk cannot load. */
      });
    return () => {
      active = false;
      cancel();
    };
  }, [code, language]);

  const html =
    highlighted?.code === code && highlighted.language === language
      ? highlighted.html
      : null;
  const content = useMemo(() => (html ? parse(html) : code), [html, code]);

  return (
    <pre
      id={id}
      dir={dir}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Overflowing code must be scrollable with the keyboard.
      tabIndex={0}
      role="region"
      aria-label={label ?? "Code block"}
    >
      <code>{content}</code>
    </pre>
  );
}

export function replaceReaderCodeBlock(node: DOMNode) {
  if (!(node instanceof Element) || node.name !== "pre") return;
  const code = node.children.find(
    (child) => child instanceof Element && child.name === "code",
  );
  return (
    <ReaderCodeBlock
      code={codeText(node)}
      language={
        (code instanceof Element ? codeLanguage(code) : undefined) ??
        codeLanguage(node)
      }
      id={node.attribs.id}
      dir={node.attribs.dir}
      label={node.attribs["aria-label"]}
    />
  );
}
