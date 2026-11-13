// linux-run.mjs が各テストファイルの前に `--import` で読み込む。テストの本体が落ちたら、その時点の画面と窓の一覧を残す
// (テストファイルごとに書かずに済むよう、ここで全体に掛ける)。Mawok を閉じるテストファイルの後始末は、この afterEach より
// 先に回るので、閉じる所 (linux.mjs の closeApp) でも残す
import { afterEach, beforeEach } from 'node:test';
import { captureIfFailed, trackTest } from './linux.mjs';

beforeEach((t) => trackTest(t));
afterEach(() => captureIfFailed());
