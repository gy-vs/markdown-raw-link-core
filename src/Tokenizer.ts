import { _defaults } from './defaults.ts';
import {
  rtrim,
  splitCells,
  findClosingBracket,
  expandTabs,
  normalizeLabel,
  trimTrailingBlankLines,
} from './helpers.ts';
import type { Rules } from './rules.ts';
import type { _Lexer } from './Lexer.ts';
import type { Links, Tokens, Token } from './Tokens.ts';
import type { MarkedOptions } from './MarkedOptions.ts';

/**
 * A link rule match. Captures are copied back from the original source even
 * when the rule ran against masked text. `rawRanges` lists opaque token
 * spans (code spans and extension tokens) inside the candidate, and
 * `matchEnd` is where the masked match ended in the source.
 */
type LinkRuleMatch = RegExpExecArray & {
  rawRanges?: [number, number][];
  matchEnd?: number;
};

function outputLink(cap: string[], link: Pick<Tokens.Link, 'href' | 'title'>, raw: string, lexer: _Lexer, rules: Rules): Tokens.Link | Tokens.Image | undefined {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(rules.other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  lexer.state.inLink = true;
  const outerLinkEmitted = lexer.state.linkEmitted;
  const outerInRawBlock = lexer.state.inRawBlock;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const textHasLink = lexer.state.linkEmitted;
  lexer.state.linkEmitted = outerLinkEmitted;
  lexer.state.inLink = false;

  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of nesting."
    // Bail so the caller falls through to text and the inner link is the one kept.
    // Images are exempt: their text is flattened into an alt attribute.
    if (textHasLink) {
      // these tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text that is re-scanned
      lexer.state.inRawBlock = outerInRawBlock;
      return;
    }
    lexer.state.linkEmitted = true;
  }

  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text,
    tokens,
  };
}

function indentCodeCompensation(raw: string, text: string, rules: Rules) {
  const matchIndentToCode = raw.match(rules.other.indentCodeCompensation);

  if (matchIndentToCode === null) {
    return text;
  }

  const indentToCode = matchIndentToCode[1];

  return text
    .split('\n')
    .map(node => {
      const matchIndentInNode = node.match(rules.other.beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }

      const [indentInNode] = matchIndentInNode;

      // Up to the fence's own indentation is removed from each line, so a line
      // indented less than the fence loses whatever indentation it has.
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

/**
 * Tokenizer
 */
export class _Tokenizer<ParserOutput = string, RendererOutput = string> {
  options: MarkedOptions<ParserOutput, RendererOutput>;
  rules!: Rules; // set by the lexer
  lexer!: _Lexer<ParserOutput, RendererOutput>; // set by the lexer

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    this.options = options || _defaults;
  }

  space(src: string): Tokens.Space | undefined {
    const cap = this.rules.block.newline.exec(src);
    if (cap && cap[0].length > 0) {
      return {
        type: 'space',
        raw: cap[0],
      };
    }
  }

  code(src: string): Tokens.Code | undefined {
    const cap = this.rules.block.code.exec(src);
    if (cap) {
      const raw = this.options.pedantic
        ? cap[0]
        : trimTrailingBlankLines(cap[0]);
      const text = raw.replace(this.rules.other.codeRemoveIndent, '');
      return {
        type: 'code',
        raw,
        codeBlockStyle: 'indented',
        text,
      };
    }
  }

  fences(src: string): Tokens.Code | undefined {
    const cap = this.rules.block.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = indentCodeCompensation(raw, cap[3] || '', this.rules);

      return {
        type: 'code',
        raw,
        lang: cap[2] ? cap[2].trim().replace(this.rules.inline.anyPunctuation, '$1') : cap[2],
        text,
      };
    }
  }

  heading(src: string): Tokens.Heading | undefined {
    const cap = this.rules.block.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();

      // remove trailing #s
      if (this.rules.other.endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (this.options.pedantic) {
          text = trimmed.trim();
        } else if (!trimmed || this.rules.other.endingSpaceTabChar.test(trimmed)) {
          // CommonMark requires a space or tab before trailing #s
          text = trimmed.trim();
        }
      }

      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src: string): Tokens.Hr | undefined {
    const cap = this.rules.block.hr.exec(src);
    if (cap) {
      return {
        type: 'hr',
        raw: rtrim(cap[0], '\n'),
      };
    }
  }

  blockquote(src: string): Tokens.Blockquote | undefined {
    const cap = this.rules.block.blockquote.exec(src);
    if (cap) {
      let lines = rtrim(cap[0], '\n').split('\n');
      let raw = '';
      let text = '';
      const tokens: Token[] = [];

      while (lines.length > 0) {
        let inBlockquote = false;
        const currentLines = [];

        let i;
        for (i = 0; i < lines.length; i++) {
          // get lines up to a continuation
          if (this.rules.other.blockquoteStart.test(lines[i])) {
            currentLines.push(lines[i]);
            inBlockquote = true;
          } else if (!inBlockquote) {
            currentLines.push(lines[i]);
          } else {
            break;
          }
        }
        lines = lines.slice(i);

        const currentRaw = currentLines.join('\n');
        const currentText = currentRaw
          // precede setext continuation with 4 spaces so it isn't a setext
          .replace(this.rules.other.blockquoteSetextReplace, '\n    $1')
          .replace(this.rules.other.blockquoteSetextReplace2, '');
        raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
        text = text ? `${text}\n${currentText}` : currentText;

        // parse blockquote lines as top level tokens
        // merge paragraphs if this is a continuation
        const top = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(currentText, tokens, true);
        this.lexer.state.top = top;

        // if there is no continuation then we are done
        if (lines.length === 0) {
          break;
        }

        const lastToken = tokens.at(-1);

        if (lastToken?.type === 'code') {
          // blockquote continuation cannot be preceded by a code block
          break;
        } else if (lastToken?.type === 'blockquote') {
          // include continuation in nested blockquote
          const oldToken = lastToken as Tokens.Blockquote;
          // The continuation lines belong to the same nesting frame as the
          // nested blockquote, which already had one '>' marker stripped, so
          // strip one marker from them too. Otherwise a restated marker after a
          // lazy line is re-parsed as a spurious deeper blockquote.
          const continuation = lines.join('\n');
          const newText = oldToken.raw + '\n' + continuation.replace(this.rules.other.blockquoteSetextReplace2, '');
          const newToken = this.blockquote(newText)!;
          tokens[tokens.length - 1] = newToken;

          raw = `${raw}\n${continuation}`;
          text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
          break;
        } else if (lastToken?.type === 'list') {
          // include continuation in nested list
          const oldToken = lastToken as Tokens.List;
          const newText = oldToken.raw + '\n' + lines.join('\n');
          const newToken = this.list(newText)!;
          tokens[tokens.length - 1] = newToken;

          raw = raw.substring(0, raw.length - lastToken.raw.length) + newToken.raw;
          text = text.substring(0, text.length - oldToken.raw.length) + newToken.raw;
          lines = newText.substring(tokens.at(-1)!.raw.length).split('\n');
          continue;
        }
      }

      return {
        type: 'blockquote',
        raw,
        tokens,
        text,
      };
    }
  }

  list(src: string): Tokens.List | undefined {
    let cap = this.rules.block.list.exec(src);
    if (cap) {
      let bull = cap[1].trim();
      const isordered = bull.length > 1;

      const list: Tokens.List = {
        type: 'list',
        raw: '',
        ordered: isordered,
        start: isordered ? +bull.slice(0, -1) : '',
        loose: false,
        items: [],
      };

      bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

      if (this.options.pedantic) {
        bull = isordered ? bull : '[*+-]';
      }

      // Get next list item
      const itemRegex = this.rules.other.listItemRegex(bull);
      let endsWithBlankLine = false;
      // Check if current bullet point can start a new List Item
      while (src) {
        let endEarly = false;
        let raw = '';
        let itemContents = '';
        if (!(cap = itemRegex.exec(src))) {
          break;
        }

        if (this.rules.block.hr.test(src)) { // End list if bullet was actually HR (possibly move into itemRegex?)
          break;
        }

        raw = cap[0];
        src = src.substring(raw.length);

        let line = expandTabs(cap[2].split('\n', 1)[0], cap[1].length);
        let nextLine = src.split('\n', 1)[0];
        let blankLine = !line.trim();

        let indent = 0;
        if (this.options.pedantic) {
          indent = 2;
          itemContents = line.trimStart();
        } else if (blankLine) {
          indent = cap[1].length + 1;
        } else {
          indent = line.search(this.rules.other.nonSpaceChar); // Find first non-space char
          indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent
          itemContents = line.slice(indent);
          indent += cap[1].length;
        }

        if (blankLine && this.rules.other.blankLine.test(nextLine)) { // Items begin with at most one blank line
          raw += nextLine + '\n';
          src = src.substring(nextLine.length + 1);
          endEarly = true;
        }

        if (!endEarly) {
          const nextBulletRegex = this.rules.other.nextBulletRegex(indent);
          const hrRegex = this.rules.other.hrRegex(indent);
          const fencesBeginRegex = this.rules.other.fencesBeginRegex(indent);
          const headingBeginRegex = this.rules.other.headingBeginRegex(indent);
          const htmlBeginRegex = this.rules.other.htmlBeginRegex(indent);
          const blockquoteBeginRegex = this.rules.other.blockquoteBeginRegex(indent);

          // Check if following lines should be included in List Item
          while (src) {
            const rawLine = src.split('\n', 1)[0];
            let nextLineWithoutTabs;
            nextLine = rawLine;

            // Re-align to follow commonmark nesting rules
            if (this.options.pedantic) {
              nextLine = nextLine.replace(this.rules.other.listReplaceNesting, '  ');
              nextLineWithoutTabs = nextLine;
            } else {
              nextLineWithoutTabs = nextLine.replace(this.rules.other.tabCharGlobal, '    ');
            }

            // End list item if found code fences
            if (fencesBeginRegex.test(nextLine)) {
              break;
            }

            // End list item if found start of new heading
            if (headingBeginRegex.test(nextLine)) {
              break;
            }

            // End list item if found start of html block
            if (htmlBeginRegex.test(nextLine)) {
              break;
            }

            // End list item if found start of blockquote
            if (blockquoteBeginRegex.test(nextLine)) {
              break;
            }

            // End list item if found start of new bullet
            if (nextBulletRegex.test(nextLine)) {
              break;
            }

            // Horizontal rule found
            if (hrRegex.test(nextLine)) {
              break;
            }

            if (nextLineWithoutTabs.search(this.rules.other.nonSpaceChar) >= indent || !nextLine.trim()) { // Dedent if possible
              itemContents += '\n' + nextLineWithoutTabs.slice(indent);
            } else {
              // not enough indentation
              if (blankLine) {
                break;
              }

              // paragraph continuation unless last line was a different block level element
              if (line.replace(this.rules.other.tabCharGlobal, '    ').search(this.rules.other.nonSpaceChar) >= 4) { // indented code block
                break;
              }
              if (fencesBeginRegex.test(line)) {
                break;
              }
              if (headingBeginRegex.test(line)) {
                break;
              }
              if (hrRegex.test(line)) {
                break;
              }

              itemContents += '\n' + nextLine;
            }

            blankLine = !nextLine.trim();

            raw += rawLine + '\n';
            src = src.substring(rawLine.length + 1);
            line = nextLineWithoutTabs.slice(indent);
          }
        }

        if (!list.loose) {
          // If the previous item ended with a blank line, the list is loose
          if (endsWithBlankLine) {
            list.loose = true;
          } else if (this.rules.other.doubleBlankLine.test(raw)) {
            endsWithBlankLine = true;
          }
        }

        list.items.push({
          type: 'list_item',
          raw,
          task: !!this.options.gfm && this.rules.other.listIsTask.test(itemContents),
          loose: false,
          text: itemContents,
          tokens: [],
        });

        list.raw += raw;
      }

      // Do not consume newlines at end of final item. Alternatively, make itemRegex *start* with any newlines to simplify/speed up endsWithBlankLine logic
      const lastItem = list.items.at(-1);
      if (lastItem) {
        lastItem.raw = lastItem.raw.trimEnd();
        lastItem.text = lastItem.text.trimEnd();
      } else {
        // not a list since there were no items
        return;
      }
      list.raw = list.raw.trimEnd();

      // Item child tokens handled here at end because we needed to have the final item to trim it first
      // First pass: tokenize items and finalize list.loose from spacers before placing checkboxes
      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);

        if (!list.loose) {
          // Check if list should be loose
          const spacers = item.tokens.filter(t => t.type === 'space');
          const hasMultipleLineBreaks = spacers.length > 0 && spacers.some(t => this.rules.other.anyLine.test(t.raw));

          list.loose = hasMultipleLineBreaks;
        }
      }

      // Second pass: place task checkboxes using the final list.loose
      for (const item of list.items) {
        const itemToken = item.tokens[0];
        if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
          // Remove checkbox markdown from item tokens
          item.text = item.text.replace(this.rules.other.listReplaceTask, '');
          itemToken.raw = itemToken.raw.replace(this.rules.other.listReplaceTask, '');
          itemToken.text = itemToken.text.replace(this.rules.other.listReplaceTask, '');
          for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
              this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(this.rules.other.listReplaceTask, '');
              break;
            }
          }

          const taskRaw = this.rules.other.listTaskCheckbox.exec(item.raw);
          if (taskRaw) {
            const checkboxToken: Tokens.Checkbox = {
              type: 'checkbox',
              raw: taskRaw[0] + ' ',
              checked: taskRaw[0] !== '[ ]',
            };
            item.checked = checkboxToken.checked;
            if (list.loose) {
              if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
                item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkboxToken);
              } else {
                item.tokens.unshift({
                  type: 'paragraph',
                  raw: checkboxToken.raw,
                  text: checkboxToken.raw,
                  tokens: [checkboxToken],
                });
              }
            } else {
              item.tokens.unshift(checkboxToken);
            }
          }
        } else if (item.task) {
          item.task = false;
        }
      }

      // Set all items to loose if list is loose
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const token of item.tokens) {
            if (token.type === 'text') {
              token.type = 'paragraph';
            }
          }
        }
      }

      return list;
    }
  }

  html(src: string): Tokens.HTML | undefined {
    const cap = this.rules.block.html.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const token: Tokens.HTML = {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
      return token;
    }
  }

  def(src: string): Tokens.Def | undefined {
    const cap = this.rules.block.def.exec(src);
    if (cap) {
      const tag = normalizeLabel(cap[1]).replace(this.rules.other.multipleSpaceGlobal, ' ');
      const href = cap[2] ? cap[2].replace(this.rules.other.hrefBrackets, '$1').replace(this.rules.inline.anyPunctuation, '$1') : '';
      const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(this.rules.inline.anyPunctuation, '$1') : cap[3];
      return {
        type: 'def',
        tag,
        raw: rtrim(cap[0], '\n'),
        href,
        title,
      };
    }
  }

  table(src: string): Tokens.Table | undefined {
    const cap = this.rules.block.table.exec(src);
    if (!cap) {
      return;
    }

    if (!this.rules.other.tableDelimiter.test(cap[2])) {
      // delimiter row must have a pipe (|) or colon (:) otherwise it is a setext heading
      return;
    }

    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(this.rules.other.tableAlignChars, '').split('|');
    const rows = cap[3]?.trim() ? cap[3].replace(this.rules.other.tableRowBlankLine, '').split('\n') : [];

    const item: Tokens.Table = {
      type: 'table',
      raw: rtrim(cap[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };

    if (headers.length !== aligns.length) {
      // header and align columns must be equal, rows can be different.
      return;
    }

    for (const align of aligns) {
      if (this.rules.other.tableAlignRight.test(align)) {
        item.align.push('right');
      } else if (this.rules.other.tableAlignCenter.test(align)) {
        item.align.push('center');
      } else if (this.rules.other.tableAlignLeft.test(align)) {
        item.align.push('left');
      } else {
        item.align.push(null);
      }
    }

    for (let i = 0; i < headers.length; i++) {
      item.header.push({
        text: headers[i],
        tokens: this.lexer.inline(headers[i]),
        header: true,
        align: item.align[i],
      });
    }

    for (const row of rows) {
      item.rows.push(splitCells(row, item.header.length).map((cell, i) => {
        return {
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: item.align[i],
        };
      }));
    }

    return item;
  }

  lheading(src: string): Tokens.Heading | undefined {
    const cap = this.rules.block.lheading.exec(src);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading',
        raw: rtrim(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src: string): Tokens.Paragraph | undefined {
    const cap = this.rules.block.paragraph.exec(src);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n'
        ? cap[1].slice(0, -1)
        : cap[1];
      return {
        type: 'paragraph',
        raw: cap[0],
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  text(src: string): Tokens.Text | undefined {
    const cap = this.rules.block.text.exec(src);
    if (cap) {
      return {
        type: 'text',
        raw: cap[0],
        text: cap[0],
        tokens: this.lexer.inline(cap[0]),
      };
    }
  }

  escape(src: string): Tokens.Escape | undefined {
    const cap = this.rules.inline.escape.exec(src);
    if (cap) {
      return {
        type: 'escape',
        raw: cap[0],
        text: cap[1],
      };
    }
  }

  tag(src: string): Tokens.Tag | undefined {
    const cap = this.rules.inline.tag.exec(src);
    if (cap) {
      if (!this.lexer.state.inLink && this.rules.other.startATag.test(cap[0])) {
        this.lexer.state.inLink = true;
      } else if (this.lexer.state.inLink && this.rules.other.endATag.test(cap[0])) {
        this.lexer.state.inLink = false;
      }
      if (!this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = true;
      } else if (this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(cap[0])) {
        this.lexer.state.inRawBlock = false;
      }

      return {
        type: 'html',
        raw: cap[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: cap[0],
      };
    }
  }

  link(src: string): Tokens.Link | Tokens.Image | undefined {
    const cap = this.matchLinkRule(src, this.rules.inline.link);
    if (cap) {
      const trimmedUrl = cap[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(trimmedUrl)) {
        // commonmark requires matching angle brackets
        if (!(this.rules.other.endAngleBracket.test(trimmedUrl))) {
          return;
        }

        // ending angle bracket cannot be escaped
        const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
        if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
          return;
        }
      } else {
        // find closing parenthesis. Parens inside a raw token do not
        // participate; matchLinkRule reports those ranges so depth is
        // counted over syntax text only.
        const lastParenIndex = this.findClosingParen(cap);
        if (lastParenIndex === -2) {
          // more open parens than closed
          return;
        }

        if (lastParenIndex > -1) {
          const start = cap[0].indexOf('!') === 0 ? 5 : 4;
          const linkLen = start + cap[1].length + lastParenIndex;
          cap[2] = cap[2].substring(0, lastParenIndex);
          cap[0] = src.substring(0, linkLen).trim();
          cap[3] = '';
        }
      }
      let href = cap[2];
      let title = '';
      if (this.options.pedantic) {
        // split pedantic href and title
        const link = this.rules.other.pedanticHrefTitle.exec(href);

        if (link) {
          href = link[1];
          title = link[3];
        }
      } else {
        title = cap[3] ? cap[3].slice(1, -1) : '';
      }

      href = href.trim();
      if (this.rules.other.startAngleBracket.test(href)) {
        if (this.options.pedantic && !(this.rules.other.endAngleBracket.test(trimmedUrl))) {
          // pedantic allows starting angle bracket without ending angle bracket
          href = href.slice(1);
        } else {
          href = href.slice(1, -1);
        }
      }
      return outputLink(cap, {
        href: href ? href.replace(this.rules.inline.anyPunctuation, '$1') : href,
        title: title ? title.replace(this.rules.inline.anyPunctuation, '$1') : title,
      }, cap[0], this.lexer, this.rules);
    }
  }

  reflink(src: string, links: Links): Tokens.Link | Tokens.Image | Tokens.Text | undefined {
    let cap;
    if ((cap = this.matchLinkRule(src, this.rules.inline.reflink))
      || (cap = this.matchLinkRule(src, this.rules.inline.nolink))) {
      const linkString = (cap[2] || cap[1]).replace(this.rules.other.multipleSpaceGlobal, ' ');
      const link = links[normalizeLabel(linkString)];
      if (!link) {
        const text = cap[0].charAt(0);
        return {
          type: 'text',
          raw: text,
          text,
        };
      }
      return outputLink(cap, link, cap[0], this.lexer, this.rules);
    }
  }

  emStrong(src: string, maskedSrc: string, prevChar = ''): Tokens.Em | Tokens.Strong | undefined {
    let match = this.rules.inline.emStrongLDelim.exec(src);
    if (!match) return;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return;

    // _ can't be between two alphanumerics. \p{L}\p{N} includes non-english alphabet/numbers as well
    if (match[4] && prevChar.match(this.rules.other.unicodeAlphaNumeric)) return;

    const nextChar = match[1] || match[3] || '';

    if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
      // unicode Regex counts emoji as 1 char; spread into array for proper count (used multiple times below)
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

      const delimChar = match[0][0];
      // A mid-run opener (for example the second star of an unmatched `**`) must
      // only pair with a delimiter that can only close, otherwise it steals the
      // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
      const midRun = prevChar === delimChar;
      const endReg = delimChar === '*' ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      endReg.lastIndex = 0;

      // Clip maskedSrc to same section of string as src (move to lexer?)
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);

      while ((match = endReg.exec(maskedSrc)) !== null) {
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue; // skip single * in __abc*abc__

        rLength = [...rDelim].length;

        if (match[3] || match[4]) { // found another Left Delim
          delimTotal += rLength;
          continue;
        } else if (match[5] || match[6]) { // either Left or Right Delim
          if (lLength % 3 && !((lLength + rLength) % 3)) {
            midDelimTotal += rLength;
            continue; // CommonMark Emphasis Rules 9-10
          }
          if (midRun) {
            // A mid-run opener cannot close against an ambiguous delimiter that
            // can also open; that delimiter opens its own emphasis span instead.
            break;
          }
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue; // Haven't found enough closing delimiters

        // Remove extra characters. *a*** -> *a*
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        // char length can be >1 for unicode characters;
        const lastCharLength = [...match[0]][0].length;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        // Create `em` if smallest delimiter has odd char count. *a***
        if (Math.min(lLength, rLength) % 2) {
          const text = raw.slice(1, -1);
          return {
            type: 'em',
            raw,
            text,
            tokens: this.lexer.inlineTokens(text),
          };
        }

        // Create 'strong' if smallest delimiter has even char count. **a***
        const text = raw.slice(2, -2);
        return {
          type: 'strong',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
  }

  codespan(src: string): Tokens.Codespan | undefined {
    const cap = this.rules.inline.code.exec(src);
    if (cap) {
      let text = cap[2].replace(this.rules.other.newLineCharGlobal, ' ');
      const hasNonSpaceChars = this.rules.other.nonSpaceChar.test(text);
      const hasSpaceCharsOnBothEnds = this.rules.other.startingSpaceChar.test(text) && this.rules.other.endingSpaceChar.test(text);
      if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
        text = text.substring(1, text.length - 1);
      }
      return {
        type: 'codespan',
        raw: cap[0],
        text,
      };
    }
  }

  br(src: string): Tokens.Br | undefined {
    const cap = this.rules.inline.br.exec(src);
    if (cap) {
      return {
        type: 'br',
        raw: cap[0],
      };
    }
  }

  del(src: string, maskedSrc: string, prevChar = ''): Tokens.Del | undefined {
    let match = this.rules.inline.delLDelim.exec(src);
    if (!match) return;

    const nextChar = match[1] || '';

    if (!nextChar || !prevChar || this.rules.inline.punctuation.exec(prevChar)) {
      // unicode Regex counts emoji as 1 char; spread into array for proper count
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength;

      const endReg = this.rules.inline.delRDelim;
      endReg.lastIndex = 0;

      // Clip maskedSrc to same section of string as src
      maskedSrc = maskedSrc.slice(-1 * src.length + lLength);

      while ((match = endReg.exec(maskedSrc)) !== null) {
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];

        if (!rDelim) continue;

        rLength = [...rDelim].length;

        if (rLength !== lLength) continue;

        if (match[3] || match[4]) { // found another Left Delim
          delimTotal += rLength;
          continue;
        }

        delimTotal -= rLength;

        if (delimTotal > 0) continue; // Haven't found enough closing delimiters

        // Remove extra characters
        rLength = Math.min(rLength, rLength + delimTotal);
        // char length can be >1 for unicode characters
        const lastCharLength = [...match[0]][0].length;
        const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

        // Create del token - only single ~ or double ~~ supported
        const text = raw.slice(lLength, -lLength);
        return {
          type: 'del',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
  }

  autolink(src: string): Tokens.Link | undefined {
    const cap = this.rules.inline.autolink.exec(src);
    if (cap) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[1];
        href = 'mailto:' + text;
      } else {
        text = cap[1];
        href = text;
      }

      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [
          {
            type: 'text',
            raw: text,
            text,
          },
        ],
      };
    }
  }

  url(src: string): Tokens.Link | undefined {
    let cap;
    if (cap = this.rules.inline.url.exec(src)) {
      let text, href;
      if (cap[2] === '@') {
        text = cap[0];
        href = 'mailto:' + text;
      } else {
        // do extended autolink path validation
        let prevCapZero;
        do {
          prevCapZero = cap[0];
          cap[0] = this.rules.inline._backpedal.exec(cap[0])?.[0] ?? '';
        } while (prevCapZero !== cap[0]);
        text = cap[0];
        if (cap[1] === 'www.') {
          href = 'http://' + cap[0];
        } else {
          href = cap[0];
        }
      }
      return {
        type: 'link',
        raw: cap[0],
        text,
        href,
        autolink: true,
        tokens: [
          {
            type: 'text',
            raw: text,
            text,
          },
        ],
      };
    }
  }

  inlineText(src: string): Tokens.Text | undefined {
    const cap = this.rules.inline.text.exec(src);
    if (cap) {
      const escaped = this.lexer.state.inRawBlock;
      return {
        type: 'text',
        raw: cap[0],
        text: cap[0],
        escaped,
      };
    }
  }

  /**
   * Run a link rule (inline link, reflink or collapsed/shortcut link).
   *
   * The label part of these regexes can only see code spans and backslash
   * escapes as opaque text; brackets returned inside a raw token from an
   * extension tokenizer count as label-ending brackets even though the
   * tokenizer itself treats that whole span as one unit. That mismatch both
   * accepts links whose label closes in the middle of a token and rejects
   * valid links, leaving the later `]` to throw off token consumption.
   *
   * Re-scan the label tracking bracket depth over syntax-participating text
   * only (escapes, code spans and extension raw tokens are skipped), then
   * re-run the rule with raw token interiors masked, so the regex closes
   * the label at the bracket the scanner found. Capture groups are copied
   * back from the original source, so raw text and consumed length are
   * unchanged on every accepted link. A candidate that does not survive the
   * scan returns undefined and the lexer falls back to ordinary text without
   * dropping a character.
   */
  private matchLinkRule(src: string, rule: RegExp): LinkRuleMatch | undefined {
    // link rules only match from an opening bracket; everything else is a
    // fast rejection that must not scan the source
    const isImage = src.charCodeAt(0) === 0x21;
    const openPos = isImage ? 1 : 0;
    if (src.charCodeAt(openPos) !== 0x5B /* [ */) {
      return;
    }

    const direct = rule.exec(src);
    const hasExtension = !!this.options.extensions?.inline;

    // bound the work to what the regex itself allows (labels to 999 items
    // plus a short destination/title tail)
    const scanEnd = Math.min(src.length, 4000);

    if (!hasExtension) {
      // code spans are opaque to the label regex already; they only matter
      // in a matched inline link's destination, so no source-wide scan runs
      // at every '['
      if (direct && rule === this.rules.inline.link) {
        const result = direct as LinkRuleMatch;
        const ranges = this.scanDestinationRawRanges(src, result);
        if (ranges.length > 0) {
          result.rawRanges = ranges;
          result.matchEnd = result[0].length;
        }
      }
      return direct ?? undefined;
    }

    // an extension token can hide brackets anywhere in the candidate
    const rawRanges = this.scanRawRanges(src, 0, scanEnd);
    if (rawRanges.length === 0) {
      return direct ?? undefined;
    }

    const masked = this.maskRawRanges(src, rawRanges);
    const indicesRule = rule.flags.includes('d')
      ? rule
      : new RegExp(rule.source, `${rule.flags}d`);
    const maskMatch = indicesRule.exec(masked) as
      | (RegExpExecArray & { indices: ([number, number] | undefined)[] })
      | null;
    if (!maskMatch || maskMatch[1] === undefined) {
      return;
    }

    // copy capture group text from the original source at the (unchanged)
    // masked offsets, and carry the raw token ranges so the destination's
    // paren scan can skip them
    const result = this.copyMatchFromSource(src, maskMatch) as LinkRuleMatch;
    result.rawRanges = rawRanges;
    result.matchEnd = maskMatch.indices[0]?.[1] ?? maskMatch.index + maskMatch[0].length;
    return result;
  }

  /**
   * Raw token ranges (code spans) overlapping the inline link match's
   * destination. The regex already closes the label correctly, so only the
   * destination's paren scan needs these.
   */
  private scanDestinationRawRanges(src: string, match: RegExpExecArray): [number, number][] {
    const destStart = match[0].length - match[2].length;
    const destEnd = match[0].length;
    if (src.indexOf('`', destStart) >= destEnd) {
      return [];
    }
    const ranges: [number, number][] = [];
    for (let i = destStart; i < destEnd; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 0x5C /* \ */) {
        i++;
      } else if (ch === 0x60 /* ` */) {
        const end = this.codespanRawEnd(src, i, destEnd + 1);
        if (end > i) {
          ranges.push([i, end]);
          i = end - 1;
        }
      }
    }
    return ranges;
  }

  /** Copy capture group text from `src` at the masked match's offsets. */
  private copyMatchFromSource(
    src: string,
    match: RegExpExecArray & { indices: ([number, number] | undefined)[] },
  ): RegExpExecArray {
    return match.map((group, i) => {
      if (i === 0 || group === undefined) {
        return group;
      }
      const range = match.indices[i];
      return range ? src.slice(range[0], range[1]) : group;
    }) as RegExpExecArray;
  }

  /** Replace every raw token interior with equal-length neutral text. */
  private maskRawRanges(src: string, ranges: [number, number][]): string {
    let masked = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
      masked += src.slice(cursor, start) + 'a'.repeat(end - start);
      cursor = end;
    }
    return masked + src.slice(cursor);
  }

  /**
   * Collect raw token ranges (code spans and inline extension tokens) in
   * src.slice(start, scanEnd), scanning the text as the lexer would.
   */
  private scanRawRanges(src: string, start: number, scanEnd: number): [number, number][] {
    const ranges: [number, number][] = [];
    const hintEnds = this.extensionHintEnds(src, start, scanEnd);
    const hasOpenExtension = hintEnds.includes(Infinity);
    let hintIndex = 0;

    for (let i = start; i < scanEnd; i++) {
      const ch = src.charCodeAt(i);

      if (hasOpenExtension || hintIndex < hintEnds.length) {
        while (hintIndex < hintEnds.length && hintEnds[hintIndex] < i) {
          hintIndex++;
        }
        if (hasOpenExtension || hintIndex < hintEnds.length) {
          const rawEnd = this.extensionRawEnd(src, i);
          if (rawEnd > i) {
            ranges.push([i, rawEnd]);
            i = rawEnd - 1;
            while (hintIndex < hintEnds.length && hintEnds[hintIndex] < rawEnd) {
              hintIndex++;
            }
            continue;
          }
        }
      }

      if (ch === 0x5C /* \ */ && i + 1 < src.length) {
        i++;
      } else if (ch === 0x60 /* ` */) {
        const codeEnd = this.codespanRawEnd(src, i, scanEnd);
        if (codeEnd > i) {
          ranges.push([i, codeEnd]);
          i = codeEnd - 1;
        }
      }
    }
    return ranges;
  }

  /**
   * Sorted positions at or after `pos` where an inline extension with a
   * `start` hint may begin. An extension without a hint can start anywhere,
   * represented by `Infinity`; an empty array means no extension token can
   * follow, so the scanner never has to probe one.
   *
   * The regexes themselves bound candidate length (labels to 999 items),
   * and `scanEnd` passes that bound on: hints past it cannot affect this
   * candidate. A small cap keeps repeated hint calls linear regardless of
   * how many times the extension marker appears.
   */
  private extensionHintEnds(src: string, pos: number, scanEnd: number): number[] {
    const ext = this.options.extensions;
    if (!ext?.inline) {
      return [];
    }
    const ends: number[] = [];
    if (!ext.startInline) {
      return [Infinity];
    }
    const MAX_HINTS = 16;
    for (let e = 0; e < ext.inline.length; e++) {
      const start = ext.startInline[e];
      if (!start) {
        // this extension has no hint, so it may begin at any position
        ends.push(Infinity);
        continue;
      }
      let cursor = pos;
      for (let n = 0; n < MAX_HINTS; n++) {
        const hint = start.call({ lexer: this.lexer }, src.slice(cursor));
        if (typeof hint !== 'number' || hint < 0) {
          break;
        }
        cursor += hint;
        if (cursor > scanEnd) {
          break;
        }
        ends.push(cursor);
        if (hint === 0) {
          cursor++; // guard against a hint that always reports 0
        }
      }
    }
    ends.sort((a, b) => a - b);
    return ends;
  }

  /**
   * End index of the raw token an inline extension would consume at `pos`,
   * mirroring the order used by the lexer. The caller has already used the
   * extensions' `start` hints to decide a token may start here; extensions
   * without hints are probed directly, as the lexer does.
   */
  private extensionRawEnd(src: string, pos: number): number {
    const ext = this.options.extensions;
    const extensions = ext?.inline;
    if (!extensions) {
      return pos;
    }
    const slice = src.slice(pos);
    for (let i = 0; i < extensions.length; i++) {
      const start = ext!.startInline?.[i];
      if (start && start.call({ lexer: this.lexer }, slice) !== 0) {
        continue;
      }
      const token = extensions[i].call({ lexer: this.lexer }, slice, []);
      if (token && token.raw) {
        return pos + token.raw.length;
      }
    }
    return pos;
  }

  /**
   * End index of a code span beginning with the backtick run at `pos`.
   * Matches the inline code rule's notion of a span: a run of backticks
   * closes when followed by a run of the same length that is not part of a
   * longer run. The search stops at `scanEnd`; a fence that only closes
   * beyond it does not bound this link candidate.
   */
  private codespanRawEnd(src: string, pos: number, scanEnd: number): number {
    let run = pos + 1;
    while (run < src.length && src.charCodeAt(run) === 0x60) {
      run++;
    }
    const fenceLen = run - pos;

    let search = run;
    while (search < scanEnd) {
      const tick = src.indexOf('`', search);
      if (tick === -1 || tick >= scanEnd) {
        return pos;
      }
      let closeRun = tick + 1;
      while (closeRun < src.length && src.charCodeAt(closeRun) === 0x60) {
        closeRun++;
      }
      if (closeRun - tick === fenceLen && src.charCodeAt(closeRun) !== 0x60) {
        return closeRun;
      }
      search = closeRun;
    }
    return pos;
  }

  /**
   * Find the parenthesis that closes an inline link destination, counting
   * depth only over syntax-participating text. Backslash escapes and raw
   * tokens (code spans, extension tokens) are opaque. Returns the index
   * relative to the destination capture (-1: no close needed, -2:
   * unbalanced).
   */
  private findClosingParen(cap: LinkRuleMatch): number {
    const destination = cap[2];
    const rawRanges = cap.rawRanges;
    if (!rawRanges || (destination.indexOf(')') === -1 && destination.indexOf('(') === -1)) {
      return findClosingBracket(destination, '()');
    }

    // absolute start of the destination in the source
    const destOffset = (cap.matchEnd ?? cap[0].length) - destination.length;
    let level = 0;
    let rangeIndex = 0;

    for (let i = 0; i < destination.length; i++) {
      const abs = destOffset + i;
      const ch = destination.charCodeAt(i);

      // inside a raw token: skip to its end
      while (rangeIndex < rawRanges.length && rawRanges[rangeIndex][1] <= abs) {
        rangeIndex++;
      }
      const range = rawRanges[rangeIndex];
      if (range && abs >= range[0] && abs < range[1]) {
        i += range[1] - abs - 1;
        rangeIndex++;
        continue;
      }

      if (ch === 0x5C /* \ */ && i + 1 < destination.length) {
        i++;
      } else if (ch === 0x28 /* ( */) {
        level++;
      } else if (ch === 0x29 /* ) */) {
        level--;
        if (level < 0) {
          return i;
        }
      }
    }
    return level > 0 ? -2 : -1;
  }
}
