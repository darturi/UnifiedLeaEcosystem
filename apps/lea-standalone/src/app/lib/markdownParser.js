export function parseMarkdownBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  let codeLines = [];
  let mathLines = [];
  let codeLanguage = '';
  let inCode = false;
  let inMath = false;
  let mathClosingFence = '';

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
    const codeFence = line.match(/^```(\w+)?\s*$/);
    if (codeFence) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeLines.join('\n'), language: codeLanguage });
        codeLines = [];
        codeLanguage = '';
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        codeLanguage = codeFence[1] || '';
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (inMath) {
      const closingIndex = line.indexOf(mathClosingFence);
      if (closingIndex >= 0) {
        const closingFence = mathClosingFence;
        mathLines.push(line.slice(0, closingIndex));
        blocks.push({ type: 'math', text: mathLines.join('\n').trim(), display: true });
        mathLines = [];
        inMath = false;
        mathClosingFence = '';
        const rest = line.slice(closingIndex + closingFence.length).trim();
        if (rest) {
          paragraph.push(rest);
        }
      } else {
        mathLines.push(line);
      }
      continue;
    }

    const blockMath = blockMathStart(line);
    if (blockMath) {
      flushParagraph();
      flushList();
      if (blockMath.inlineContent !== undefined) {
        blocks.push({ type: 'math', text: blockMath.inlineContent.trim(), display: true });
      } else {
        inMath = true;
        mathClosingFence = blockMath.close;
        mathLines = [blockMath.firstLine];
      }
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
  if (inMath) {
    blocks.push({ type: 'math', text: mathLines.join('\n').trim(), display: true });
  }
  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', text: '' }];
}

export function parseInlineMarkdown(text) {
  const pattern = /(`[^`]+`|\\\([^()\n]+\\\)|\$[^$\n]+\$|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  const segments = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    segments.push(parseInlineToken(match[0]));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function parseInlineToken(token) {
  if (token.startsWith('`') && token.endsWith('`')) {
    return { type: 'code', text: token.slice(1, -1) };
  }
  if (token.startsWith('\\(') && token.endsWith('\\)')) {
    return { type: 'math', text: token.slice(2, -2), display: false };
  }
  if (token.startsWith('$') && token.endsWith('$')) {
    return { type: 'math', text: token.slice(1, -1), display: false };
  }
  if (token.startsWith('**') && token.endsWith('**')) {
    return { type: 'strong', text: token.slice(2, -2) };
  }
  if (token.startsWith('*') && token.endsWith('*')) {
    return { type: 'emphasis', text: token.slice(1, -1) };
  }

  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    return { type: 'link', text: link[1], href: link[2] };
  }

  return { type: 'text', text: token };
}

function blockMathStart(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('$$')) {
    const rest = trimmed.slice(2);
    const closeIndex = rest.indexOf('$$');
    if (closeIndex >= 0) {
      return { inlineContent: rest.slice(0, closeIndex), close: '$$' };
    }
    return { firstLine: rest, close: '$$' };
  }
  if (trimmed.startsWith('\\[')) {
    const rest = trimmed.slice(2);
    const closeIndex = rest.indexOf('\\]');
    if (closeIndex >= 0) {
      return { inlineContent: rest.slice(0, closeIndex), close: '\\]' };
    }
    return { firstLine: rest, close: '\\]' };
  }
  return null;
}
