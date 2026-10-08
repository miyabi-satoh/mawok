import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 場所だけを持つ軽い入れ物。`run.mjs` はビルドを飛ばすときにこれを見るが、`app.mjs` を読むと
// webdriverio まで一緒に読み込むことになるので、そこから切り離してある
export const APP_PATH = path.resolve(
	__dirname,
	'..',
	'..',
	'src-tauri',
	'target',
	'release',
	'mawok.exe'
);
