// Markdown の HTML を整える（日本語の行の途中の改行を空白なしでつなぎ、表を横に送れる領域で包む）。
// 紹介・規約のすべてに効かせる。
import { defineHastPlugin } from 'satteri';
import type { Root, RootContent, Text } from 'hast';

const CJK = /[　-ヿ一-鿿＀-￯]/;
/** 直後に空白を置かない約物。これで終わる行は、次に何が来ても詰めてよい。 */
const TERMINATOR = /[。、！？」』）]/;

function collectTexts(node: Root | RootContent, texts: Text[]) {
  if (node.type === 'text') {
    texts.push(node);
    return;
  }
  // <pre> の中は行が意味を持つので触らない
  if (node.type === 'element' && node.tagName === 'pre') return;
  if ('children' in node) for (const child of node.children) collectTexts(child, texts);
}

export const hastProse = defineHastPlugin({
  name: 'mawok-prose',

  /**
   * 日本語の行送りが半角空白になって出るのを防ぐ。
   *
   * 詰めるのは、約物の直後の改行と、両側が日本語の文字である改行。
   * `<code>` や `<strong>` が境目に挟まっても効くよう、隣り合うテキストをつないで判断する。
   * 日本語と欧文の境目の改行は残す。
   */
  before(root, ctx) {
    const texts: Text[] = [];
    collectTexts(root, texts);
    const chars = [...texts.map((text) => text.value).join('')];
    const keep = chars.map((char, i) => {
      if (char !== '\n') return true;
      const prev = chars[i - 1] ?? '';
      const next = chars[i + 1] ?? '';
      return !(TERMINATOR.test(prev) || (CJK.test(prev) && CJK.test(next)));
    });
    let offset = 0;
    for (const text of texts) {
      const own = [...text.value];
      const value = own.filter((_, i) => keep[offset + i]).join('');
      offset += own.length;
      if (value !== text.value) ctx.replaceNode(text, { type: 'text', value });
    }
  },

  /** 横に送れる表を、キーボードでも操作できる領域で包む。 */
  element: {
    filter: ['table'],
    visit(node, ctx) {
      ctx.wrapNode(node, {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-scroll'], tabIndex: 0, role: 'region', ariaLabel: '表' },
        children: [],
      });
    },
  },
});
