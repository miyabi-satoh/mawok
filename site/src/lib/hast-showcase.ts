// 紹介 (src/content/index.md) の本文を、見せ方に合わせて組み直す。
// 「##」ごとに <section> で包み、画像が2枚以上ある節は、文と画像の組 (ステップ) に分ける。
// ステップは、広い画面では画像が止まったまま文が流れ、次の組で画像が入れ替わる (src/components/ProductPage.astro)。
import { defineHastPlugin } from 'satteri';
import type { Element, ElementContent, Root, RootContent } from 'hast';

const PRODUCT_INDEX = /\/src\/content\/index\.md$/;
const isBlank = (node: RootContent) => node.type === 'text' && node.value.trim() === '';

const isElement = (node: RootContent, tagName: string): node is Element => node.type === 'element' && node.tagName === tagName;

/** 画像1枚だけの段落 */
function isImageParagraph(node: RootContent) {
  if (!isElement(node, 'p')) return false;
  const inner = node.children.filter((child) => !isBlank(child));
  return inner.length === 1 && isElement(inner[0], 'img');
}

const div = (className: string, children: ElementContent[]): Element => ({
  type: 'element',
  tagName: 'div',
  properties: { className: [className] },
  children,
});

/** 画像の段落の手前にある文を、その画像と組にする。最後の画像より後ろの文は、組にせず後ろに残す */
function toSteps(content: RootContent[]): ElementContent[] {
  const steps: Element[] = [];
  let pending: ElementContent[] = [];
  for (const node of content) {
    if (isBlank(node)) continue;
    if (isImageParagraph(node)) {
      steps.push(div('step', [div('step-text', pending), div('step-shot', [node as Element])]));
      pending = [];
    } else {
      pending.push(node as ElementContent);
    }
  }
  return [div('steps', steps), ...pending];
}

/** 「**ラベル**: 説明」の項目なら、ラベルの後ろの「: 」を外す（ラベルは見出しのように別の行に出すため） */
function dropLabelColon(list: Element): Element {
  const items = list.children.map((item) => {
    if (!isElement(item, 'li')) return item;
    const [first, second, ...rest] = item.children;
    if (!first || !isElement(first, 'strong') || second?.type !== 'text' || !/^[:：]/.test(second.value)) return item;
    return { ...item, children: [first, { type: 'text', value: second.value.replace(/^[:：]\s*/, '') }, ...rest] } satisfies Element;
  });
  return { ...list, children: items };
}

export const hastShowcase = defineHastPlugin({
  name: 'mawok-showcase',

  before(root, ctx) {
    if (!PRODUCT_INDEX.test(ctx.fileURL?.pathname ?? '')) return;
    const children: RootContent[] = [];
    let section: { heading: Element; content: RootContent[] } | undefined;
    const flush = () => {
      if (!section) return;
      const images = section.content.filter(isImageParagraph).length;
      children.push({
        type: 'element',
        tagName: 'section',
        properties: { className: images >= 2 ? ['block', 'has-steps'] : ['block'] },
        children: [section.heading, ...(images >= 2 ? toSteps(section.content) : (section.content as ElementContent[]))],
      });
    };
    for (const node of root.children) {
      if (isElement(node, 'h2')) {
        flush();
        section = { heading: node, content: [] };
      } else if (section) {
        section.content.push(isElement(node, 'ul') ? dropLabelColon(node) : node);
      } else {
        children.push(node);
      }
    }
    flush();
    ctx.replaceNode(root, { type: 'root', children } satisfies Root);
  },
});
