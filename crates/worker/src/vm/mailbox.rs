//! A VM's incoming messages. A sync host call waits for its own reply and
//! sets everything else aside here, in order: replies to async calls (and a
//! dispose) to handle next, evals to run after the current one.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use super::VmMsg;

pub(super) struct Mailbox {
    pub(super) rx: Receiver<VmMsg>,
    pub(super) replies: RefCell<VecDeque<VmMsg>>,
    pub(super) later: RefCell<VecDeque<VmMsg>>,
}

impl Mailbox {
    pub(super) fn new(rx: Receiver<VmMsg>) -> Mailbox {
        Mailbox {
            rx,
            replies: RefCell::new(VecDeque::new()),
            later: RefCell::new(VecDeque::new()),
        }
    }

    /// The next message during an eval: held replies first. Evals that
    /// arrive are deferred.
    pub(super) fn during_eval(&self, timeout: Option<Duration>) -> Result<VmMsg, RecvTimeoutError> {
        loop {
            if let Some(m) = self.replies.borrow_mut().pop_front() {
                return Ok(m);
            }
            let m = match timeout {
                Some(t) => self.rx.recv_timeout(t)?,
                None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected)?,
            };
            match m {
                eval @ VmMsg::Eval { .. } => self.later.borrow_mut().push_back(eval),
                other => return Ok(other),
            }
        }
    }

    /// The next message between evals, waiting at most `timeout` (until the
    /// next timer is due).
    pub(super) fn idle(&self, timeout: Option<Duration>) -> Result<VmMsg, RecvTimeoutError> {
        if let Some(m) = self.replies.borrow_mut().pop_front() {
            return Ok(m);
        }
        if let Some(m) = self.later.borrow_mut().pop_front() {
            return Ok(m);
        }
        match timeout {
            Some(t) => self.rx.recv_timeout(t),
            None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        }
    }
}
