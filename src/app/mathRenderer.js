import katex from 'katex';

export function renderTex(tex, displayMode = false) {
  try {
    return {
      ok: true,
      html: katex.renderToString(tex, {
        displayMode,
        output: 'html',
        strict: 'ignore',
        throwOnError: true,
        trust: false,
      }),
      text: tex,
    };
  } catch {
    return {
      ok: false,
      html: '',
      text: tex,
    };
  }
}
