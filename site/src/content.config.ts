import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// 紹介 (index.md) と、規約類 (terms.md・privacy.md)。特商法の表記は amiiby.com の共通のページに置き、価格・動作環境と Mawok に限った定めは料金のページ (pages/pricing.astro) に書く。
// 書き方の決まりは amiiby-site の docs/product-content.md に合わせる。

const product = defineCollection({
  loader: glob({ base: './src/content', pattern: 'index.md' }),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      tagline: z.string(),
      description: z.string().max(160),
      // 冒頭 (色の帯) に出すもの。導入の1〜2文、バッジ、画面の画像 (1枚目が手前。2枚目からは奥に重ねる飾り)
      lead: z.string(),
      badges: z.array(z.string()).min(1),
      hero: z.array(z.object({ src: image(), alt: z.string() })).min(1).max(3),
      // 帯の色。白い文字を載せるので、白とのコントラスト比 4.5 以上の暗めの色にする
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      platforms: z.array(z.enum(['windows', 'macos'])).min(1),
      // platforms と status は amiiby-site の front matter に合わせて持つ。今は表示に使わず、ダウンロードの欄は常に準備中を出す
      status: z.enum(['coming-soon']),
    }),
});

const legal = defineCollection({
  loader: glob({ base: './src/content', pattern: '{terms,privacy}.md' }),
  schema: z.object({
    title: z.string(),
    updated: z.coerce.date(),
  }),
});

export const collections = { product, legal };
