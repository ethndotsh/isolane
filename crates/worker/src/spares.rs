//! The worker's spare isolates (see `vm::Spare`), kept by shape: up to
//! `--spare-isolates` of each of the shapes its VMs used most recently, at
//! most `MAX_SHAPES` of them. A tenant whose programs run with two heap
//! limits keeps spares for both, instead of making them again for each
//! whenever the other runs.

/// Most shapes of spare a worker keeps at once: a worker that sees a new
/// one drops the spares of the shape used least recently.
pub const MAX_SHAPES: usize = 4;

/// Spares by shape, generic so the policy is testable without V8.
pub struct Spares<K, S> {
    /// Least recently used shape first.
    shapes: Vec<(K, Vec<S>)>,
    per_shape: usize,
}

impl<K: PartialEq + Copy, S> Spares<K, S> {
    /// Spares of `per_shape` of each shape (0 keeps none).
    pub fn new(per_shape: usize) -> Self {
        Spares {
            shapes: Vec::new(),
            per_shape,
        }
    }

    /// A spare of `shape`, if one is ready. Makes `shape` the most recently
    /// used.
    pub fn take(&mut self, shape: K) -> Option<S> {
        let at = self.shapes.iter().position(|(k, _)| *k == shape)?;
        let mut entry = self.shapes.remove(at);
        let spare = entry.1.pop();
        self.shapes.push(entry);
        spare
    }

    /// Start spares of `shape` until it has `per_shape`, dropping the least
    /// recently used shape's past `MAX_SHAPES`. Stops at the first spare
    /// that won't start (out of threads or memory).
    pub fn refill<E>(&mut self, shape: K, mut start: impl FnMut(K) -> Result<S, E>) {
        if self.per_shape == 0 {
            return;
        }
        let entry = match self.shapes.iter().position(|(k, _)| *k == shape) {
            Some(at) => self.shapes.remove(at),
            None => (shape, Vec::new()),
        };
        self.shapes.push(entry);
        if self.shapes.len() > MAX_SHAPES {
            self.shapes.remove(0);
        }
        let Some((_, spares)) = self.shapes.last_mut() else {
            return;
        };
        while spares.len() < self.per_shape {
            match start(shape) {
                Ok(spare) => spares.push(spare),
                Err(_) => break,
            }
        }
    }

    /// How many spares are ready, of every shape.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.shapes.iter().map(|(_, s)| s.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(shape: u32) -> Result<u32, ()> {
        Ok(shape)
    }

    #[test]
    fn keeps_spares_of_each_shape() {
        let mut spares = Spares::new(2);
        spares.refill(1, start);
        spares.refill(2, start);
        assert_eq!(spares.len(), 4);
        assert_eq!(spares.take(1), Some(1));
        assert_eq!(spares.take(2), Some(2));
        spares.refill(1, start);
        assert_eq!(spares.len(), 3);
    }

    #[test]
    fn drops_the_least_recently_used_shape() {
        let mut spares = Spares::new(1);
        for shape in 0..MAX_SHAPES as u32 {
            spares.refill(shape, start);
        }
        // Shape 0 is used again, so shape 1 is the least recently used.
        assert_eq!(spares.take(0), Some(0));
        spares.refill(0, start);
        spares.refill(99, start);
        assert_eq!(spares.len(), MAX_SHAPES);
        assert_eq!(spares.take(1), None);
        assert_eq!(spares.take(0), Some(0));
        assert_eq!(spares.take(99), Some(99));
    }

    #[test]
    fn keeps_none_when_off() {
        let mut spares = Spares::new(0);
        spares.refill(1, start);
        assert_eq!(spares.take(1), None);
    }

    #[test]
    fn stops_at_a_spare_that_wont_start() {
        let mut spares: Spares<u32, u32> = Spares::new(3);
        spares.refill(1, |_| Err(()));
        assert_eq!(spares.len(), 0);
    }
}
