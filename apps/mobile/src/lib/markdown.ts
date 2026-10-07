// A small, dependency-free Markdown reader for assistant messages: fenced code, headings, lists, quotes, paragraphs and the
// inline marks bold, italic, code and links. Pure (no React Native), so it is unit-tested with node (markdown.test.ts).

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; text: string; url: string };

export type Block =
  | { type: "paragraph"; inline: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: { number: number; inline: Inline[] }[] }
  | { type: "quote"; inline: Inline[] };

/** Inline marks. Unmatched markers stay literal, so half-streamed text never throws or swallows characters. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ type: "code", text: m[1]! });
      i += m[0].length;
    } else if ((m = /^\*\*([^\n]+?)\*\*/.exec(rest)) || (m = /^__([^\n]+?)__/.exec(rest))) {
      flush();
      out.push({ type: "bold", children: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\*([^*\s][^*\n]*?)\*/.exec(rest)) || (m = /^_([^_\s][^_\n]*?)_(?![A-Za-z0-9])/.exec(rest))) {
      flush();
      out.push({ type: "italic", children: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) {
      flush();
      out.push({ type: "link", text: m[1]!, url: m[2]! });
      i += m[0].length;
    } else {
      text += src[i];
      i++;
    }
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      i++;
      // An unterminated fence (the message is still streaming) takes the rest of the text.
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      endPara();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      endPara();
      blocks.push({ type: "heading", level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, inline: parseInline(heading[2]!.trim()) });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      const entry = { number: ordered ? Number(item[2]) : 0, inline: parseInline(item[3]!) };
      if (last?.type === "list" && last.ordered === ordered) last.items.push(entry);
      else blocks.push({ type: "list", ordered, items: [entry] });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      endPara();
      const last = blocks[blocks.length - 1];
      if (last?.type === "quote") last.inline = [...last.inline, { type: "text", text: "\n" }, ...parseInline(quote[1]!)];
      else blocks.push({ type: "quote", inline: parseInline(quote[1]!) });
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}
