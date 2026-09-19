import { Marked } from '../../lib/marked.esm.js';
import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

/**
 * Link label/destination scanning must treat code spans and raw tokens
 * produced by extension tokenizers as opaque: brackets (square and round)
 * inside them do not participate in link syntax.
 */
describe('link scanning respects raw token ranges', () => {
  let marked;
  beforeEach(() => {
    marked = new Marked();
  });

  describe('code spans inside link labels', () => {
    it('inline link with a closing bracket in the code span', () => {
      assert.strictEqual(
        marked.parse('[a `b] c`](x)').trim(),
        '<p><a href="x">a <code>b] c</code></a></p>',
      );
    });

    it('inline link whose code span contains ](', () => {
      assert.strictEqual(
        marked.parse('[`a](b`](x)').trim(),
        '<p><a href="x"><code>a](b</code></a></p>',
      );
    });

    it('reference link with a closing bracket in the code span', () => {
      const md = '[r]: /ref\n\n[a `x] y` b][r]';
      assert.strictEqual(
        marked.parse(md).trim(),
        '<p><a href="/ref">a <code>x] y</code> b</a></p>',
      );
    });

    it('collapsed reference candidate with a code span falls back as text', () => {
      const md = '[r]: /ref\n\n[a `x]` b][]';
      assert.strictEqual(
        marked.parse(md).trim(),
        '<p>[a <code>x]</code> b][]</p>',
      );
    });

    it('full reference link with a code span in the label', () => {
      const md = '[r]: /ref\n\n[`x]` y][r]';
      assert.strictEqual(
        marked.parse(md).trim(),
        '<p><a href="/ref"><code>x]</code> y</a></p>',
      );
    });

    it('image alt text with a bracket in a code span', () => {
      assert.strictEqual(
        marked.parse('![a `b] c`](x)').trim(),
        '<p><img src="x" alt="a b] c"></p>',
      );
    });

    it('unresolved reference falls back to text without losing characters', () => {
      assert.strictEqual(
        marked.parse('[`a]b`][nope]').trim(),
        '<p>[<code>a]b</code>][nope]</p>',
      );
    });

    it('unresolved inline-like reference keeps the whole span as text', () => {
      assert.strictEqual(
        marked.parse('[a `x] y` b][ref]').trim(),
        '<p>[a <code>x] y</code> b][ref]</p>',
      );
    });
  });

  describe('code spans inside link destinations', () => {
    it('opening paren in a code span does not raise depth', () => {
      assert.strictEqual(
        marked.parse('[x](http://u/`a(b)c`)').trim(),
        '<p><a href="http://u/%60a(b)c%60">x</a></p>',
      );
    });

    it('closing paren in a code span does not end the destination', () => {
      assert.strictEqual(
        marked.parse('[x](http://u/`a)b`c)').trim(),
        '<p><a href="http://u/%60a)b%60c">x</a></p>',
      );
    });
  });

  describe('adjacent raw tokens', () => {
    it('multiple code spans inside one reference label', () => {
      const md = '[r]: /ref\n\n[`x]` `y]` z][r]';
      assert.strictEqual(
        marked.parse(md).trim(),
        '<p><a href="/ref"><code>x]</code> <code>y]</code> z</a></p>',
      );
    });

    it('multiple code spans inside one inline label', () => {
      assert.strictEqual(
        marked.parse('[`x]` `y]` z](u)').trim(),
        '<p><a href="u"><code>x]</code> <code>y]</code> z</a></p>',
      );
    });
  });

  describe('extension raw tokens', () => {
    let bangMarked;
    beforeEach(() => {
      bangMarked = new Marked();
      bangMarked.use({
        extensions: [{
          name: 'bang',
          level: 'inline',
          start(src) {
            return src.indexOf('!!');
          },
          tokenizer(src) {
            const match = /^!!([^!]*)!!/.exec(src);
            if (match) {
              return {
                type: 'bang',
                raw: match[0],
                text: match[1],
              };
            }
          },
          renderer(token) {
            return `<b>${token.text}</b>`;
          },
        }],
      });
    });

    it('inline link label closes after an extension raw token with a bracket', () => {
      assert.strictEqual(
        bangMarked.parse('[a !!x]y!! b](http://u)').trim(),
        '<p><a href="http://u">a <b>x]y</b> b</a></p>',
      );
    });

    it('inline link survives a raw token holding ](', () => {
      assert.strictEqual(
        bangMarked.parse('[a !!x](y)!! b](http://u)').trim(),
        '<p><a href="http://u">a <b>x](y)</b> b</a></p>',
      );
    });

    it('reference link label closes after an extension raw token', () => {
      const md = '[r]: http://ref\n\n[a !!x]y!! b][r]';
      assert.strictEqual(
        bangMarked.parse(md).trim(),
        '<p><a href="http://ref">a <b>x]y</b> b</a></p>',
      );
    });

    it('multiple adjacent links with extension raw tokens', () => {
      assert.strictEqual(
        bangMarked.parse('two [a !!p]q!! x](u1) and [b !!r]s!! y](u2)').trim(),
        '<p>two <a href="u1">a <b>p]q</b> x</a> and <a href="u2">b <b>r]s</b> y</a></p>',
      );
    });

    it('two adjacent raw tokens each carrying brackets', () => {
      const md = '[z]: http://z\n\nadjacent [!!]]!!][z]';
      assert.strictEqual(
        bangMarked.parse(md).trim(),
        '<p>adjacent <a href="http://z"><b>]]</b></a></p>',
      );
    });

    it('failed candidate falls back to the extension token and text', () => {
      // no matching reference and no inline destination
      assert.strictEqual(
        bangMarked.parse('before [a !!x]y!! b][missing] after').trim(),
        '<p>before [a <b>x]y</b> b][missing] after</p>',
      );
    });

    it('parens inside an extension raw token in the destination are opaque', () => {
      assert.strictEqual(
        bangMarked.parse('[x](!!a(b)!!http://u)').trim(),
        '<p><a href="!!a(b)!!http://u">x</a></p>',
      );
    });

    it('image alt with an extension raw token', () => {
      assert.strictEqual(
        bangMarked.parse('![!!x]y!!](http://i)').trim(),
        '<p><img src="http://i" alt="&lt;b&gt;x]y&lt;/b&gt;"></p>',
      );
    });
  });

  describe('token raw and consumed length outside successful links', () => {
    it('plain text around links is consumed unchanged', () => {
      const md = 'plain text [a](http://u) trailing text';
      const html = marked.parse(md).trim();
      // a second parse of the same input must be identical (state leaks
      // between inline runs would show up across repeated parses)
      assert.strictEqual(marked.parse(md).trim(), html);
      assert.strictEqual(
        html,
        '<p>plain text <a href="http://u">a</a> trailing text</p>',
      );
    });
  });
});
