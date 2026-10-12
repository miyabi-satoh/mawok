//! テストで共通に使うもの

use std::{
    fs,
    path::{Path, PathBuf},
};

/// テストごとの一時フォルダー。落ちたテストでも残さないよう、手放すときにフォルダーごと消す
pub struct TempDir(PathBuf);

impl TempDir {
    /// `name` は、並んで走るほかのテストと重ならないものにする
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("mawok-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("the temporary folder can be made");
        Self(dir)
    }

    pub fn join(&self, name: impl AsRef<Path>) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
