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

    #[test]
    fn runs_once_for_a_burst() {
        let debounce = Debounce::default();
        let (count, make) = counter();
        for _ in 0..20 {
            debounce.trigger(DELAY, make());
        }
        thread::sleep(DELAY * 4);
        assert_eq!(count.load(Ordering::SeqCst), 1);
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
        thread::sleep(DELAY * 4);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn waits_again_when_touched() {
        let debounce = Debounce::default();
        let (count, make) = counter();
        debounce.trigger(DELAY, make());
        thread::sleep(DELAY / 2);
        debounce.touch();
        // 最初の知らせからは待つ時間を過ぎたが、触ってからはまだ
        thread::sleep(DELAY * 7 / 10);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        thread::sleep(DELAY * 3);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn runs_again_for_a_later_burst() {
        let debounce = Debounce::default();
        let (count, make) = counter();
        debounce.trigger(DELAY, make());
        thread::sleep(DELAY * 3);
        debounce.trigger(DELAY, make());
        thread::sleep(DELAY * 3);
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}
