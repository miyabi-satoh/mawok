//! 続けて届く知らせを、落ち着いてから1回だけ処理する（下書きのフォーカスが外れた知らせに使う）

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Default)]
pub struct Debounce {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    /// 知らせが届くたびに増やす。待ち終えたときに変わっていたら、待ち直す
    generation: u64,
    /// 待っているスレッドがあるか。知らせが揺れても、待つスレッドを増やさない
    pending: bool,
}

impl Debounce {
    /// 知らせが届いたことを記録する。待っている処理があれば、そこから待ち直させる
    pub fn touch(&self) {
        self.state.lock().unwrap().generation += 1;
    }

    /// `delay` の間ほかの知らせが届かなければ、`run` を1回呼ぶ。
    /// 待っている間に呼ばれたら待ち直させるだけで、この `run` は捨てる（呼ぶ側は、呼ばれた時点の状態を見て決めること）。
    /// 待ち終えて `run` を呼ぶと決めた後に届いた知らせは、新しい一続きとして改めて待つ
    pub fn trigger(&self, delay: Duration, run: impl FnOnce() + Send + 'static) {
        {
            let mut state = self.state.lock().unwrap();
            state.generation += 1;
            if state.pending {
                return;
            }
            state.pending = true;
        }
        let shared = Arc::clone(&self.state);
        thread::spawn(move || {
            loop {
                let observed = shared.lock().unwrap().generation;
                thread::sleep(delay);
                // 知らせの有無を見るのと、待っている印を寝かせるのを、同じロックの中で行う。
                // 分けると、その間に届いた知らせで待つスレッドが増えたり、2回呼んだりする
                let mut state = shared.lock().unwrap();
                if state.generation == observed {
                    state.pending = false;
                    break;
                }
            }
            run();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    const DELAY: Duration = Duration::from_millis(100);

    fn counter() -> (
        Arc<AtomicUsize>,
        impl Fn() -> Box<dyn FnOnce() + Send> + Clone,
    ) {
        let count = Arc::new(AtomicUsize::new(0));
        let make = {
            let count = Arc::clone(&count);
            move || -> Box<dyn FnOnce() + Send> {
                let count = Arc::clone(&count);
                Box::new(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                })
            }
        };
        (count, make)
    }

    /// `expected` 回呼ばれるまで待ち、余分に呼ばれないかを少し見てから回数を返す。
    /// CI のマシンでは sleep が大きくずれるので、決まった時間だけ待って数えると揺れる
    fn settled(count: &AtomicUsize, expected: usize) -> usize {
        let deadline = Instant::now() + Duration::from_secs(10);
        while count.load(Ordering::SeqCst) < expected && Instant::now() < deadline {
            thread::sleep(DELAY / 10);
        }
        thread::sleep(DELAY * 3);
        count.load(Ordering::SeqCst)
    }

    #[test]
    fn runs_once_for_a_burst() {
        let debounce = Debounce::default();
        let (count, make) = counter();
        for _ in 0..20 {
            debounce.trigger(DELAY, make());
        }
        assert_eq!(settled(&count, 1), 1);
    }

    #[test]
    fn runs_once_for_a_burst_from_many_threads() {
        let debounce = Arc::new(Debounce::default());
        let (count, make) = counter();
        let senders: Vec<_> = (0..8)
            .map(|_| {
                let debounce = Arc::clone(&debounce);
                let make = make.clone();
                thread::spawn(move || {
                    for _ in 0..50 {
                        debounce.trigger(DELAY, make());
                        debounce.touch();
                    }
                })
            })
            .collect();
        for sender in senders {
            sender.join().unwrap();
        }
        assert_eq!(settled(&count, 1), 1);
    }

    #[test]
    fn waits_again_when_touched() {
        // 触るのが、最初の待ちを終える前であるように、待つ時間を長く取る
        let delay = Duration::from_secs(1);
        let debounce = Debounce::default();
        let ran = Arc::new(Mutex::new(None));
        {
            let ran = Arc::clone(&ran);
            debounce.trigger(delay, move || *ran.lock().unwrap() = Some(Instant::now()));
        }
        thread::sleep(delay / 5);
        let touched = Instant::now();
        debounce.touch();
        let deadline = touched + Duration::from_secs(10);
        while ran.lock().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(DELAY / 10);
        }
        let ran = ran.lock().unwrap().expect("呼ばれなかった");
        assert!(ran >= touched + delay);
    }

    #[test]
    fn runs_again_for_a_later_burst() {
        let debounce = Debounce::default();
        let (count, make) = counter();
        debounce.trigger(DELAY, make());
        assert_eq!(settled(&count, 1), 1);
        debounce.trigger(DELAY, make());
        assert_eq!(settled(&count, 2), 2);
    }
}
