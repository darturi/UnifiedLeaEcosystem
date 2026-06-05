import { Fragment, type ReactNode } from 'react';

interface Block {
  type: 'paragraph' | 'heading' | 'list' | 'code';
  text?: string;
  level?: number;
  items?: string[];
  language?: string;
}

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Heading = (`h${Math.min(block.level || 2, 4)}`) as 'h1' | 'h2' | 'h3' | 'h4';
          return (
            <Heading key={index} className="font-semibold text-foreground">
              {renderInlineMarkdown(block.text || '')}
            </Heading>
          );
        }

        if (block.type === 'list') {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {(block.items || []).map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === 'code') {
          return (
            <pre key={index} className="overflow-x-auto rounded-md bg-background/70 p-3 font-mono text-xs">
              <code>{block.text}</code>
            </pre>
          );
        }

        return (
          <p key={index} className="whitespace-pre-wrap">
            {renderInlineMarkdown(block.text || '')}
          </p>
        );
      })}
    </div>
  );
}

function parseMarkdownBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeLines: string[] = [];
  let codeLanguage = '';
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: 'list', items: listItems });
      listItems = [];
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeLines.join('\n'), language: codeLanguage });
        codeLines = [];
        codeLanguage = '';
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        codeLanguage = fence[1] || '';
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    const list = line.match(/^\s*[-*]\s+(.+)$/);
    if (list) {
      flushParagraph();
      listItems.push(list[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (inCode) {
    blocks.push({ type: 'code', text: codeLines.join('\n'), language: codeLanguage });
  }
  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', text: '' }];
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(renderInlineToken(match[0], nodes.length));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

function renderInlineToken(token: string, key: number): ReactNode {
  if (token.startsWith('`') && token.endsWith('`')) {
    return (
      <code key={key} className="rounded bg-background/70 px-1 py-0.5 font-mono text-[0.9em]">
        {token.slice(1, -1)}
      </code>
    );
  }

  if (token.startsWith('**') && token.endsWith('**')) {
    return <strong key={key}>{token.slice(2, -2)}</strong>;
  }

  if (token.startsWith('*') && token.endsWith('*')) {
    return <em key={key}>{token.slice(1, -1)}</em>;
  }

  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    const href = safeHref(link[2]);
    return (
      <a key={key} href={href} className="underline underline-offset-2" rel="noreferrer" target="_blank">
        {link[1]}
      </a>
    );
  }

  return token;
}

function safeHref(href: string): string {
  if (/^(https?:|mailto:)/i.test(href)) {
    return href;
  }
  return '#';
}
