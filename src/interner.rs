//! [`Interner`]: the `&'static str` name table shared by the mutation
//! writer and the event-dispatch path.
//!
//! Names (tags, attribute names, event names, namespaces) cross the boundary
//! once as a `cache-string` operation and are referenced by `u16` id
//! thereafter; `handle-event` names arrive back as those same ids, so the
//! reverse lookup lives here too. See the `mutations` interface in
//! `wit/world.wit` for the protocol's side of this.

use rustc_hash::FxHashMap;

/// Interns `&'static str` names (tags, attribute/event names, namespaces) by
/// pointer identity, assigning each a `u16` id on first sight of a given
/// pointer+length.
///
/// Pointer-identity interning (rather than content hashing) is the same
/// keying [`crate::writer::MutationWriter`] uses for template identity, and
/// carries the same tradeoff: two distinct statics with equal contents may
/// get two ids. That's harmless (a few extra `cache-string` operations /
/// interned slots at worst), and avoids hashing string contents on every
/// intern call.
pub struct Interner {
    /// Keyed by `(ptr as usize, len)` — the fat-pointer components of the
    /// `&'static str`, which uniquely identify a given static allocation.
    ids: FxHashMap<(usize, usize), u16>,
    /// Reverse map for event dispatch (`resolve`): id -> the original
    /// `&'static str`.
    names: Vec<&'static str>,
}

impl Interner {
    /// Create an empty interner.
    pub fn new() -> Self {
        Interner { ids: FxHashMap::default(), names: Vec::new() }
    }

    /// Return the interned id for `s`, plus whether *this* call is the one
    /// that defined it (i.e. whether the caller owes the wire a
    /// `cache-string` operation for it).
    ///
    /// Panics if more than `u16::MAX + 1` distinct strings are interned:
    /// `str-ref` is a `u16` and every value is a legal id (optionality is
    /// carried by `option<str-ref>` in the schema, so no id is reserved).
    pub fn intern(&mut self, s: &'static str) -> (u16, bool) {
        let key = (s.as_ptr() as usize, s.len());
        if let Some(&id) = self.ids.get(&key) {
            return (id, false);
        }
        let next = self.names.len();
        assert!(
            next <= u16::MAX as usize,
            "interner: interned more than {} strings; str-ref id space (u16) \
             exhausted",
            u16::MAX as usize + 1
        );
        let id = next as u16;
        self.ids.insert(key, id);
        self.names.push(s);
        (id, true)
    }

    /// Reverse lookup for event dispatch: interned id -> the original
    /// `&'static str`, or `None` if `id` was never interned.
    pub fn resolve(&self, id: u16) -> Option<&'static str> {
        self.names.get(id as usize).copied()
    }
}

impl Default for Interner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Interning is idempotent per pointer identity, and the reverse lookup
    /// `handle-event` depends on round-trips.
    #[test]
    fn intern_is_idempotent_and_resolves() {
        let mut i = Interner::new();
        static DIV: &str = "div";
        let (a, a_new) = i.intern(DIV);
        let (b, b_new) = i.intern(DIV);
        assert_eq!(a, b);
        assert!(a_new, "first sight defines the slot");
        assert!(!b_new, "second sight must not redefine it");
        assert_eq!(i.resolve(a), Some("div"));
        assert_eq!(i.resolve(a + 1), None);
    }
}
