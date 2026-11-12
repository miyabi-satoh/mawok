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

/// ディスプレイ1枚の、全体と作業領域（タスクバーやメニューバーを除いた所）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Display {
    pub bounds: Rect,
    pub work_area: Rect,
}

/// `window` を、`point`（マウスポインター）のあるディスプレイへ移した位置を返す。移す先では、作業領域の中の相対的な位置を保つ
/// （右下に寄せていた窓は、移した先でも右下に出る）。すでにそのディスプレイに最も重なっていれば、または `point` がどのディスプレイにも
/// 無ければ None。座標は物理ピクセルでも AppKit のポイント（y が上向き）でもよい
pub fn move_to_display_at(
    window: Rect,
    displays: &[Display],
    point: (i32, i32),
) -> Option<(i32, i32)> {
    let target = displays
        .iter()
        .find(|display| contains(&display.bounds, point))?;
    let current = displays
        .iter()
        .max_by_key(|display| window.overlap_area(&display.bounds))
        .filter(|display| window.overlap_area(&display.bounds) > 0);
    if current == Some(target) {
        return None;
    }
    let to = target.work_area;
    let (x, y) = match current {
        Some(current) => {
            let from = current.work_area;
            (
                relative_axis(
                    window.x,
                    window.width,
                    (from.x, from.width),
                    (to.x, to.width),
                ),
                relative_axis(
                    window.y,
                    window.height,
                    (from.y, from.height),
                    (to.y, to.height),
                ),
            )
        }
        // 今どのディスプレイにも載っていなければ、移す先の中央に置く
        None => (
            to.x + (to.width - window.width).max(0) / 2,
            to.y + (to.height - window.height).max(0) / 2,
        ),
    };
    Some((
        clamp_axis(x, window.width, to.x, to.width),
        clamp_axis(y, window.height, to.y, to.height),
    ))
}

fn contains(area: &Rect, (x, y): (i32, i32)) -> bool {
    (area.x..area.x + area.width).contains(&x) && (area.y..area.y + area.height).contains(&y)
}

/// 作業領域の空き（作業領域の長さから窓の長さを引いた分）のどこにいたかの割合を、移す先の空きに当てる
fn relative_axis(
    position: i32,
    length: i32,
    (start, area): (i32, i32),
    (to_start, to_area): (i32, i32),
) -> i32 {
    let room = i64::from(area - length);
    if room <= 0 {
        return to_start;
    }
    let to_room = i64::from((to_area - length).max(0));
    let offset = i64::from(position - start).clamp(0, room);
    to_start + (offset * to_room / room) as i32
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

    fn display(area: Rect) -> Display {
        Display {
            bounds: area,
            work_area: area,
        }
    }

    #[test]
    fn stays_when_the_pointer_is_on_the_same_display() {
        let displays = [display(MAIN), display(RIGHT)];
        assert_eq!(
            move_to_display_at(window(100, 200), &displays, (1000, 500)),
            None
        );
    }

    #[test]
    fn moves_to_the_pointer_display_keeping_the_relative_position() {
        let displays = [display(MAIN), display(RIGHT)];
        // メインの右下の角に寄せた窓は、右のディスプレイでも右下の角に出る
        assert_eq!(
            move_to_display_at(window(1520, 780), &displays, (2000, 100)),
            Some((2800, 420))
        );
        assert_eq!(
            move_to_display_at(window(0, 0), &displays, (2000, 100)),
            Some((1920, 0))
        );
    }

    #[test]
    fn picks_the_display_by_its_bounds_and_places_in_its_work_area() {
        // メニューバーやタスクバーの上にポインターがあっても、そのディスプレイに移す
        let right = Display {
            bounds: RIGHT,
            work_area: Rect {
                y: 40,
                height: 680,
                ..RIGHT
            },
        };
        assert_eq!(
            move_to_display_at(window(0, 0), &[display(MAIN), right], (2000, 10)),
            Some((1920, 40))
        );
    }

    #[test]
    fn does_nothing_when_the_pointer_is_on_no_display() {
        assert_eq!(
            move_to_display_at(window(0, 0), &[display(MAIN)], (-10, -10)),
            None
        );
    }

    #[test]
    fn centers_on_the_pointer_display_when_the_window_is_on_none() {
        let displays = [display(MAIN), display(RIGHT)];
        assert_eq!(
            move_to_display_at(window(9000, 9000), &displays, (2000, 100)),
            Some((2360, 210))
        );
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
