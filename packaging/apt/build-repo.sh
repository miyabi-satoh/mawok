#!/usr/bin/env bash
# apt リポジトリ (GitHub Pages に置く中身) を作る。
# 使い方: build-repo.sh <.deb> <出力先のフォルダー>
# 署名には、gpg に取り込んである秘密鍵を使う。取り込む鍵は1つだけにする (公開鍵の書き出しが全部の鍵を含むため)。
set -euo pipefail

deb=$1
out=$2

name=$(dpkg-deb --field "$deb" Package)
version=$(dpkg-deb --field "$deb" Version)
arch=$(dpkg-deb --field "$deb" Architecture)

# 置くのは今の版だけ。apt が更新に使うのは最新の版で、前の版は GitHub Releases に残る (docs/platform.md「Linux の配る版」)
pool="pool/main/${name:0:1}/$name"
dist="dists/stable"
mkdir -p "$out/$pool" "$out/$dist/main/binary-$arch"
cp "$deb" "$out/$pool/${name}_${version}_${arch}.deb"

# Packages の Filename はリポジトリの URL からの相対で、apt はそこから .deb を取る
(cd "$out" && dpkg-scanpackages --arch "$arch" pool > "$dist/main/binary-$arch/Packages")
gzip --best --keep --no-name "$out/$dist/main/binary-$arch/Packages"

# apt-ftparchive は書き出し先のフォルダーも数えるので、Release は外に書いてから移す
release=$(mktemp)
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Mawok \
  -o APT::FTPArchive::Release::Label=Mawok \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures="$arch" \
  -o APT::FTPArchive::Release::Components=main \
  release "$out/$dist" > "$release"
mv "$release" "$out/$dist/Release"

gpg --batch --yes --armor --detach-sign --output "$out/$dist/Release.gpg" "$out/$dist/Release"
gpg --batch --yes --clearsign --output "$out/$dist/InRelease" "$out/$dist/Release"

# 利用者が /etc/apt/keyrings に置く公開鍵 (signed-by は armor でない形を読む)
gpg --export > "$out/mawok.gpg"

# リポジトリの URL を開いた人を紹介のページへ送る
cat > "$out/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=https://amiiby.com/apps/mawok/">
<title>Mawok apt repository</title>
<a href="https://amiiby.com/apps/mawok/">Mawok</a>
HTML
