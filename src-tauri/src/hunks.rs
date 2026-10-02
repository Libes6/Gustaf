//! Pure hunk logic for partial accept: a line diff of two texts, grouping into hunks (like `git diff -U3`) and
//! rebuilding a text from a chosen subset of hunks. No filesystem, no Tauri.
//!
//! Lines keep their terminators (`\n` or `\r\n`, and a missing one on the last line), so applying every hunk gives the
//! new text byte for byte and applying none gives the old text byte for byte.

use serde::Serialize;
use std::ops::Range;

/// Unchanged lines shown around a change; changes closer than twice this share a hunk.
const CONTEXT: usize = 3;
/// Myers edit-distance budget. Beyond it the changed middle becomes a single edit (still correct, just coarser).
const MAX_EDIT_DISTANCE: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub old: Range<usize>,
    pub new: Range<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HunkLine {
    /// `' '` context, `'-'` removed from the old text, `'+'` added in the new one.
    pub kind: char,
    /// Line without its terminator.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hunk {
    /// Stable identity (position + content). Decisions name hunks by id so a stale view cannot hit a different hunk.
    pub id: String,
    pub header: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<HunkLine>,
}

pub struct Plan {
    pub hunks: Vec<Hunk>,
    edits: Vec<Edit>,
    /// Hunk index of every edit.
    group: Vec<usize>,
    old: Vec<String>,
    new: Vec<String>,
}

fn split(s: &str) -> Vec<&str> {
    s.split_inclusive('\n').collect()
}

/// Minimal line edits turning `a` into `b`, in order and non-overlapping.
pub fn diff_edits(a: &[&str], b: &[&str]) -> Vec<Edit> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    if a.is_empty() && b.is_empty() { return Vec::new(); }
    let matches = myers_matches(a, b);
    let mut edits = Vec::new();
    let (mut ai, mut bi) = (0, 0);
    for (ma, mb) in matches.into_iter().chain([(a.len(), b.len())]) {
        if ma > ai || mb > bi { edits.push(Edit { old: prefix + ai..prefix + ma, new: prefix + bi..prefix + mb }); }
        ai = ma + 1;
        bi = mb + 1;
    }
    edits
}

/// Index pairs `(i, j)` with `a[i] == b[j]` forming a longest common subsequence; empty when over budget.
fn myers_matches(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    if a.is_empty() || b.is_empty() { return Vec::new(); }
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max = ((n + m) as usize).min(MAX_EDIT_DISTANCE) as isize;
    let off = max + 1;
    let mut v = vec![0isize; (2 * max + 3) as usize];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    'outer: for d in 0..=max {
        for k in (-d..=d).step_by(2) {
            let mut x = if k == -d || (k != d && v[(off + k - 1) as usize] < v[(off + k + 1) as usize]) { v[(off + k + 1) as usize] } else { v[(off + k - 1) as usize] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] { x += 1; y += 1; }
            v[(off + k) as usize] = x;
            if x >= n && y >= m { found = Some(d); trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec()); break 'outer; }
        }
        trace.push(v[(off - d) as usize..=(off + d) as usize].to_vec());
    }
    let Some(last) = found else { return Vec::new() };
    let mut out = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (1..=last).rev() {
        let prev = &trace[(d - 1) as usize];
        let at = |k: isize| prev[(k + d - 1) as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && at(k - 1) < at(k + 1)) { k + 1 } else { k - 1 };
        let (px, py) = (at(prev_k), at(prev_k) - prev_k);
        let (mx, _my) = if prev_k == k + 1 { (px, py + 1) } else { (px + 1, py) };
        for i in 0..(x - mx) { out.push(((x - 1 - i) as usize, (y - 1 - i) as usize)); }
        x = px;
        y = py;
    }
    for i in 0..x { out.push(((x - 1 - i) as usize, (y - 1 - i) as usize)); }
    out.reverse();
    out
}

fn trim_eol(line: &str) -> &str {
    line.strip_suffix('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).unwrap_or(line)
}

fn fnv(parts: impl Iterator<Item = String>) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts { for b in p.bytes().chain([0xff]) { h = (h ^ b as u64).wrapping_mul(0x100000001b3); } }
    format!("{h:016x}")
}

pub fn plan(old: &str, new: &str) -> Plan {
    let (a, b) = (split(old), split(new));
    let edits = diff_edits(&a, &b);
    let mut group = Vec::with_capacity(edits.len());
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for (i, e) in edits.iter().enumerate() {
        match ranges.last_mut() {
            Some(r) if e.old.start - edits[r.end - 1].old.end <= 2 * CONTEXT => r.end = i + 1,
            _ => ranges.push(i..i + 1),
        }
        group.push(ranges.len() - 1);
    }
    let hunks = ranges.iter().map(|r| {
        let (first, last) = (&edits[r.start], &edits[r.end - 1]);
        let before = first.old.start.min(CONTEXT);
        let after = (a.len() - last.old.end).min(CONTEXT);
        let (old_from, new_from) = (first.old.start - before, first.new.start - before);
        let mut lines = Vec::new();
        let ctx = |lines: &mut Vec<HunkLine>, range: Range<usize>| for l in &a[range] { lines.push(HunkLine { kind: ' ', text: trim_eol(l).into() }); };
        ctx(&mut lines, old_from..first.old.start);
        for (n, e) in edits[r.clone()].iter().enumerate() {
            if n > 0 { ctx(&mut lines, edits[r.start + n - 1].old.end..e.old.start); }
            for l in &a[e.old.clone()] { lines.push(HunkLine { kind: '-', text: trim_eol(l).into() }); }
            for l in &b[e.new.clone()] { lines.push(HunkLine { kind: '+', text: trim_eol(l).into() }); }
        }
        ctx(&mut lines, last.old.end..last.old.end + after);
        let old_lines = lines.iter().filter(|l| l.kind != '+').count();
        let new_lines = lines.iter().filter(|l| l.kind != '-').count();
        let (old_start, new_start) = (old_from + usize::from(old_lines > 0), new_from + usize::from(new_lines > 0));
        let header = format!("@@ -{old_start},{old_lines} +{new_start},{new_lines} @@");
        let id = fnv(std::iter::once(header.clone()).chain(lines.iter().map(|l| format!("{}{}", l.kind, l.text))));
        Hunk { id, header, old_start, old_lines, new_start, new_lines, lines }
    }).collect();
    Plan { hunks, edits, group, old: a.iter().map(|s| s.to_string()).collect(), new: b.iter().map(|s| s.to_string()).collect() }
}

impl Plan {
    /// The old text with the hunks flagged in `take` replaced by their new version; the others stay as in the old text.
    pub fn apply(&self, take: &[bool]) -> String {
        let mut out = String::new();
        let mut pos = 0;
        for (e, g) in self.edits.iter().zip(&self.group) {
            out.extend(self.old[pos..e.old.start].iter().map(String::as_str));
            let src = if take[*g] { &self.new[e.new.clone()] } else { &self.old[e.old.clone()] };
            out.extend(src.iter().map(String::as_str));
            pos = e.old.end;
        }
        out.extend(self.old[pos..].iter().map(String::as_str));
        out
    }

    /// Flags for `apply`: true for the hunks whose id is in `ids`. Fails if an id is unknown (the diff changed).
    pub fn select(&self, ids: &[String]) -> Result<Vec<bool>, String> {
        if let Some(bad) = ids.iter().find(|id| !self.hunks.iter().any(|h| &h.id == *id)) {
            return Err(format!("Hunk {bad} no longer exists. Reload the diff."));
        }
        Ok(self.hunks.iter().map(|h| ids.contains(&h.id)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(n: usize) -> String { (1..=n).map(|i| format!("line {i}\n")).collect() }
    fn all(p: &Plan, v: bool) -> Vec<bool> { vec![v; p.hunks.len()] }

    #[test]
    fn identical_texts_have_no_hunks() {
        let p = plan("a\nb\n", "a\nb\n");
        assert!(p.hunks.is_empty());
        assert_eq!(p.apply(&[]), "a\nb\n");
        assert!(plan("", "").hunks.is_empty());
    }

    #[test]
    fn single_change_has_git_like_header_and_context() {
        let old = numbered(10);
        let new = old.replace("line 5\n", "five\n");
        let p = plan(&old, &new);
        assert_eq!(p.hunks.len(), 1);
        let h = &p.hunks[0];
        assert_eq!(h.header, "@@ -2,7 +2,7 @@");
        let kinds: String = h.lines.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, "   -+   ");
        assert_eq!(h.lines[3].text, "line 5");
        assert_eq!(h.lines[4].text, "five");
    }

    #[test]
    fn distant_changes_make_separate_hunks_and_apply_independently() {
        let old = numbered(30);
        let new = old.replace("line 3\n", "THREE\n").replace("line 25\n", "TWENTY-FIVE\n");
        let p = plan(&old, &new);
        assert_eq!(p.hunks.len(), 2);
        assert_eq!(p.apply(&[true, true]), new);
        assert_eq!(p.apply(&[false, false]), old);
        assert_eq!(p.apply(&[true, false]), old.replace("line 3\n", "THREE\n"));
        assert_eq!(p.apply(&[false, true]), old.replace("line 25\n", "TWENTY-FIVE\n"));
    }

    #[test]
    fn nearby_changes_share_a_hunk() {
        let old = numbered(20);
        let new = old.replace("line 5\n", "a\n").replace("line 9\n", "b\n");
        assert_eq!(plan(&old, &new).hunks.len(), 1);
        let far = old.replace("line 5\n", "a\n").replace("line 13\n", "b\n");
        assert_eq!(plan(&old, &far).hunks.len(), 2);
    }

    #[test]
    fn insertions_deletions_at_edges() {
        let old = numbered(12);
        let new = format!("top\n{}", old.replace("line 12\n", ""));
        let p = plan(&old, &new);
        assert_eq!(p.hunks.len(), 2);
        assert_eq!(p.apply(&all(&p, true)), new);
        assert_eq!(p.apply(&[true, false]), format!("top\n{old}"));
        assert_eq!(p.apply(&[false, true]), old.replace("line 12\n", ""));
        let grown = plan("", "x\ny\n");
        assert_eq!(grown.hunks[0].header, "@@ -0,0 +1,2 @@");
        assert_eq!(grown.apply(&[true]), "x\ny\n");
        let shrunk = plan("x\ny\n", "");
        assert_eq!(shrunk.hunks[0].header, "@@ -1,2 +0,0 @@");
        assert_eq!(shrunk.apply(&[false]), "x\ny\n");
    }

    #[test]
    fn line_endings_and_missing_final_newline_are_preserved() {
        let old = "a\r\nb\r\nc";
        let new = "a\r\nB\r\nc\n";
        let p = plan(old, new);
        assert_eq!(p.apply(&all(&p, true)), new);
        assert_eq!(p.apply(&all(&p, false)), old);
        assert!(p.hunks[0].lines.iter().all(|l| !l.text.contains('\r') && !l.text.contains('\n')));
    }

    #[test]
    fn select_maps_ids_and_rejects_unknown() {
        let old = numbered(30);
        let new = old.replace("line 3\n", "x\n").replace("line 25\n", "y\n");
        let p = plan(&old, &new);
        let flags = p.select(&[p.hunks[1].id.clone()]).unwrap();
        assert_eq!(flags, vec![false, true]);
        assert!(p.select(&["nope".into()]).is_err());
        // The same change at another position has another id.
        assert_ne!(p.hunks[0].id, p.hunks[1].id);
        assert_eq!(p.hunks[0].id, plan(&old, &new).hunks[0].id);
    }

    #[test]
    fn random_edits_roundtrip_for_every_selection() {
        let mut seed = 12345u64;
        let mut rnd = move |n: u64| { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) % n };
        for _ in 0..200 {
            let old: Vec<String> = (0..rnd(60)).map(|_| format!("v{}\n", rnd(6))).collect();
            let mut new = old.clone();
            for _ in 0..rnd(8) {
                match rnd(3) {
                    0 if !new.is_empty() => { let i = rnd(new.len() as u64) as usize; new.remove(i); }
                    1 => { let i = rnd(new.len() as u64 + 1) as usize; new.insert(i, format!("n{}\n", rnd(9))); }
                    _ if !new.is_empty() => { let i = rnd(new.len() as u64) as usize; new[i] = format!("m{}\n", rnd(9)); }
                    _ => {}
                }
            }
            let (old, new) = (old.concat(), new.concat());
            let p = plan(&old, &new);
            assert_eq!(p.apply(&all(&p, true)), new);
            assert_eq!(p.apply(&all(&p, false)), old);
            for i in 0..p.hunks.len() {
                let mut one = all(&p, false); one[i] = true;
                // Accepting one hunk and then the diff of the rest must lead to the new text.
                let partial = p.apply(&one);
                assert_eq!(plan(&partial, &new).apply(&all(&plan(&partial, &new), true)), new);
            }
        }
    }

    #[test]
    fn over_budget_diff_falls_back_to_one_correct_edit() {
        let old: String = (0..5000).map(|i| format!("a{i}\n")).collect();
        let new: String = (0..5000).map(|i| format!("b{i}\n")).collect();
        let p = plan(&old, &new);
        assert_eq!(p.apply(&all(&p, true)), new);
        assert_eq!(p.apply(&all(&p, false)), old);
    }
}
