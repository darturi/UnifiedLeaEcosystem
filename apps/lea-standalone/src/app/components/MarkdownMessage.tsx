import { Fragment, type ReactNode } from 'react';
import { renderTex } from '../lib/mathRenderer.js';
import { parseInlineMarkdown, parseMarkdownBlocks } from '../lib/markdownParser.js';

type MarkdownBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; text: string; level: number }
  | { type: 'list'; items: string[] }
  | { type: 'code'; text: string; language?: string }
  | { type: 'math'; text: string; display: boolean };

type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'math'; text: string; display: boolean }
  | { type: 'strong'; text: string }
  | { type: 'emphasis'; text: string }
  | { type: 'link'; text: string; href: string };

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content) as MarkdownBlock[];

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

        if (block.type === 'math') {
          return <MathDisplay key={index} text={block.text} />;
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

function renderInlineMarkdown(text: string): ReactNode[] {
  return (parseInlineMarkdown(text) as InlineSegment[]).map((segment, index) => (
    <Fragment key={index}>{renderInlineSegment(segment, index)}</Fragment>
  ));
}

function renderInlineSegment(segment: InlineSegment, key: number): ReactNode {
  if (segment.type === 'code') {
    return (
      <code key={key} className="rounded bg-background/70 px-1 py-0.5 font-mono text-[0.9em]">
        {segment.text}
      </code>
    );
  }

  if (segment.type === 'math') {
    return <MathInline key={key} text={segment.text} />;
  }

  if (segment.type === 'strong') {
    return <strong key={key}>{segment.text}</strong>;
  }

  if (segment.type === 'emphasis') {
    return <em key={key}>{segment.text}</em>;
  }

  if (segment.type === 'link') {
    return (
      <a
        key={key}
        href={safeHref(segment.href)}
        className="underline underline-offset-2"
        rel="noreferrer"
        target="_blank"
      >
        {segment.text}
      </a>
    );
  }

  return segment.text;
}

function MathInline({ text }: { text: string }) {
  const rendered = renderTex(text, false);
  if (!rendered.ok) {
    return (
      <span className="mx-0.5 rounded bg-background/60 px-1.5 py-0.5 font-mono text-[0.9em] text-foreground">
        {text}
      </span>
    );
  }

  return (
    <span
      className="mx-0.5 text-foreground"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}

function MathDisplay({ text }: { text: string }) {
  const rendered = renderTex(text, true);
  if (!rendered.ok) {
    return (
      <div className="overflow-x-auto rounded-md bg-background/60 px-4 py-3 text-center font-mono text-sm text-foreground">
        {text}
      </div>
    );
  }

  return (
    <div
      className={[
        'overflow-x-auto rounded-md bg-background/60 px-4 py-3 text-center',
        'text-foreground',
      ].join(' ')}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}

function safeHref(href: string): string {
  if (/^(https?:|mailto:)/i.test(href)) {
    return href;
  }
  return '#';
}
