// @ts-check
// mawok.amiiby.com の紹介・料金・規約・プライバシーポリシー (→ docs/account-server.md「作り」)。特商法の表記は amiiby.com に置く。
// 見た目は amiiby.com の紹介ページ (amiiby-site) から写した。窓口 (account-server/) の Worker が静的なファイルとして出す。
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import sitemap from '@astrojs/sitemap';
import { hastProse } from './src/lib/hast-prose.ts';
import { hastShowcase } from './src/lib/hast-showcase.ts';

export default defineConfig({
  site: 'https://mawok.amiiby.com',
  trailingSlash: 'always',
  integrations: [sitemap()],
  markdown: {
    // 引用符や ... を組版用の記号に変えない。アプリ (marked) の出力に合わせる
    processor: satteri({ hastPlugins: [hastProse, hastShowcase], features: { smartPunctuation: false } }),
  },
});
