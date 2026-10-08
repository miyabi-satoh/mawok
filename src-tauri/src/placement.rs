//! ウィンドウを画面内に収める位置の計算

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    fn overlap_area(&self, other: &Rect) -> i64 {
        let width = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let height = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        if width <= 0 || height <= 0 {
            0
        } else {
            i64::from(width) * i64::from(height)
        }
    }
}

/// `window` を `areas`（各ディスプレイの作業領域。先頭がメインディスプレイ）に収めた位置を返す。
/// 最も重なっているディスプレイの中に収める。どのディスプレイとも重ならなければ、先頭のディスプレイの中央に置く。
pub fn fit(window: Rect, areas: &[Rect]) -> (i32, i32) {
    let Some(area) = areas.iter().max_by_key(|area| window.overlap_area(area)) else {
        return (window.x, window.y);
    };
    if window.overlap_area(area) == 0 {
        let main = &areas[0];
        return (
            main.x + (main.width - window.width).max(0) / 2,
            main.y + (main.height - window.height).max(0) / 2,
        );
    }
    (
        clamp_axis(window.x, window.width, area.x, area.width),
        clamp_axis(window.y, window.height, area.y, area.height),
    )
}

// ディスプレイより大きいウィンドウは、左端（上端）に揃える
fn clamp_axis(position: i32, length: i32, start: i32, area_length: i32) -> i32 {
    position.min(start + area_length - length).max(start)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    const RIGHT: Rect = Rect {
        x: 1920,
        y: 0,
        width: 1280,
        height: 720,
    };

    fn window(x: i32, y: i32) -> Rect {
        Rect {
            x,
            y,
            width: 400,
            height: 300,
        }
    }

    #[test]
    fn keeps_position_when_inside() {
        assert_eq!(fit(window(100, 200), &[MAIN]), (100, 200));
    }

    #[test]
    fn pulls_back_when_partly_outside() {
        assert_eq!(fit(window(1700, -50), &[MAIN]), (1520, 0));
    }

    #[test]
    fn centers_on_main_display_when_no_overlap() {
        assert_eq!(fit(window(5000, 5000), &[MAIN, RIGHT]), (760, 390));
    }

    #[test]
    fn fits_into_display_with_largest_overlap() {
        // 右のディスプレイとの重なり（330×300）がメインとの重なり（70×300）より大きい
        assert_eq!(fit(window(1850, 600), &[MAIN, RIGHT]), (1920, 420));
    }

    #[test]
    fn aligns_to_origin_when_larger_than_display() {
        let large = Rect {
            x: 100,
            y: 100,
            width: 2000,
            height: 1200,
        };
        assert_eq!(fit(large, &[MAIN]), (0, 0));
    }
}
