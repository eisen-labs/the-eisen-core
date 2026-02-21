use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{Action, Delta, FileNode, Snapshot, TrackerConfig, UsageMessage};

/// Current wall-clock time in milliseconds since Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// ContextTracker is the stateful core of Eisen.
///
/// It maintains a map of file nodes, tracks which files are inferred to be
/// "in context" vs merely "visited", applies heat decay on each tick, and
/// generates deltas that describe what changed.
///
/// Concurrency: wrapped in `Arc<Mutex<ContextTracker>>` by the caller.
/// All mutation goes through the public methods below. The caller is
/// responsible for locking; this struct is not internally synchronized.
pub struct ContextTracker {
    agent_id: String,
    session_id: String,
    files: HashMap<String, FileNode>,
    seq: u64,
    current_turn: u32,
    last_used_tokens: u32,
    context_size: u32,
    config: TrackerConfig,
    /// Paths that changed since the last tick. Populated by file_access /
    /// usage_update / end_turn, drained by tick() to build a minimal delta.
    changed_paths: HashSet<String>,
    /// Usage messages queued by usage_update(), drained by
    /// take_pending_usage(). This lets the tick loop broadcast them
    /// without the caller needing to handle the return value.
    pending_usage: Vec<UsageMessage>,
    pending_terminal_output_ids: HashSet<u64>,
}

impl ContextTracker {
    pub fn new(config: TrackerConfig) -> Self {
        Self {
            agent_id: String::new(),
            session_id: String::new(),
            files: HashMap::new(),
            seq: 0,
            current_turn: 0,
            last_used_tokens: 0,
            context_size: 0,
            config,
            changed_paths: HashSet::new(),
            pending_usage: Vec::new(),
            pending_terminal_output_ids: HashSet::new(),
        }
    }

    /// Set the agent instance ID. Called from the `--agent-id` CLI flag.
    /// Each connected agent gets a unique instance ID (e.g. "opencode-a1b2c3").
    pub fn set_agent_id(&mut self, id: String) {
        self.agent_id = id;
    }

    /// Return the current agent instance ID (empty string if not yet set).
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }

    /// Set the session ID. Called when sessionId is detected from the ACP
    /// stream or provided via CLI flag.
    pub fn set_session_id(&mut self, id: String) {
        self.session_id = id;
    }

    /// Return the current session ID (empty string if not yet set).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    // -------------------------------------------------------------------
    // Public API — called by the proxy/extract layer
    // -------------------------------------------------------------------

    pub fn add_pending_terminal_output(&mut self, id: u64) {
        self.pending_terminal_output_ids.insert(id);
    }

    pub fn take_pending_terminal_output(&mut self, id: u64) -> bool {
        self.pending_terminal_output_ids.remove(&id)
    }

    /// Record a file access from any extraction channel.
    ///
    /// Sets heat to 1.0, marks the file as in-context, and updates the
    /// turn-accessed counter. If the file is new it is created.
    pub fn file_access(&mut self, path: &str, action: Action) {
        let ts = now_ms();
        let node = self
            .files
            .entry(path.to_string())
            .or_insert_with(|| FileNode {
                path: path.to_string(),
                heat: 0.0,
                in_context: false,
                last_action: action,
                turn_accessed: 0,
                timestamp_ms: 0,
            });

        node.heat = 1.0;
        node.in_context = true;
        node.last_action = action;
        node.turn_accessed = self.current_turn;
        node.timestamp_ms = ts;

        self.changed_paths.insert(path.to_string());
    }

    /// Record a token usage update from the agent.
    ///
    /// If the usage drops by more than `compaction_threshold` relative to
    /// the previous report, we infer that the LLM runtime compacted the
    /// context. All files are evicted from context — only files re-accessed
    /// in subsequent turns will re-enter.
    ///
    /// The resulting `UsageMessage` is queued internally and drained by
    /// `take_pending_usage()` — typically called by the tick loop right
    /// after `tick()`. Callers can treat `usage_update()` as
    /// fire-and-forget; the broadcast happens automatically.
    pub fn usage_update(&mut self, used: u32, size: u32) {
        let previous = self.last_used_tokens;
        self.last_used_tokens = used;
        self.context_size = size;

        // Detect compaction: usage dropped by more than threshold
        if previous > 0 {
            let drop_ratio = 1.0 - (used as f32 / previous as f32);
            if drop_ratio >= self.config.compaction_threshold {
                self.handle_compaction();
            }
        }

        self.pending_usage.push(UsageMessage::new(
            &self.agent_id,
            &self.session_id,
            used,
            size,
            None,
        ));
    }

    /// Drain any pending usage messages queued by `usage_update()`.
    ///
    /// Called by the tick loop alongside `tick()` to broadcast usage
    /// messages to TCP clients. Returns an empty vec if nothing is pending.
    pub fn take_pending_usage(&mut self) -> Vec<UsageMessage> {
        std::mem::take(&mut self.pending_usage)
    }

    /// Signal the end of an agent turn (agent returned PromptResponse).
    ///
    /// Increments the turn counter and transitions files that haven't been
    /// accessed recently out of context.
    pub fn end_turn(&mut self) {
        self.current_turn += 1;

        // Files not accessed within the context window exit context
        for (path, node) in &mut self.files {
            if node.in_context
                && self.current_turn.saturating_sub(node.turn_accessed) > self.config.context_turns
            {
                node.in_context = false;
                self.changed_paths.insert(path.clone());
            }
        }
    }

    /// Called every 100ms by the tick loop.
    ///
    /// Applies heat decay to non-context files, collects all changes since
    /// the last tick (from file_access calls + decay), and returns a Delta
    /// if anything changed. Returns `None` on empty ticks.
    pub fn tick(&mut self) -> Option<Delta> {
        // Decay heat on files that are NOT in context
        for (path, node) in &mut self.files {
            if !node.in_context && node.heat > 0.01 {
                node.heat *= self.config.decay_rate;
                // Clamp to zero when negligible
                if node.heat <= 0.01 {
                    node.heat = 0.0;
                }
                self.changed_paths.insert(path.clone());
            }
        }

        if self.changed_paths.is_empty() {
            return None;
        }

        self.seq += 1;

        let mut updates = Vec::new();
        let mut removed = Vec::new();

        for path in self.changed_paths.drain().collect::<Vec<_>>() {
            if let Some(node) = self.files.get(&path) {
                // Only include nodes that are still warm or in-context
                if node.heat > 0.0 || node.in_context {
                    updates.push(node.to_update());
                } else {
                    // File heat hit zero and not in context — prune
                    removed.push(path.clone());
                }
            }
        }

        // Actually remove pruned files from the map
        for path in &removed {
            self.files.remove(path);
        }

        if updates.is_empty() && removed.is_empty() {
            return None;
        }

        Some(Delta::new(
            &self.agent_id,
            &self.session_id,
            self.seq,
            updates,
            removed,
        ))
    }

    /// Return a full snapshot of the current state.
    ///
    /// Used when a new TCP client connects or when a client sends
    /// `request_snapshot`.
    pub fn snapshot(&self) -> Snapshot {
        // Only include files that are warm or in-context
        let nodes: HashMap<String, FileNode> = self
            .files
            .iter()
            .filter(|(_, n)| n.heat > 0.0 || n.in_context)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        Snapshot::new(&self.agent_id, &self.session_id, self.seq, nodes)
    }

    /// Current sequence number (useful for tests / diagnostics).
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Current turn number.
    pub fn current_turn(&self) -> u32 {
        self.current_turn
    }

    // -------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------

    /// On compaction, all files exit context.
    fn handle_compaction(&mut self) {
        for (path, node) in &mut self.files {
            if node.in_context {
                node.in_context = false;
                self.changed_paths.insert(path.clone());
            }
        }
    }
}

// =======================================================================
// Tests
// =======================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn default_tracker() -> ContextTracker {
        ContextTracker::new(TrackerConfig::default())
    }

    fn config_with(
        context_turns: u32,
        compaction_threshold: f32,
        decay_rate: f32,
    ) -> TrackerConfig {
        TrackerConfig {
            context_turns,
            compaction_threshold,
            decay_rate,
        }
    }

    // ---------------------------------------------------------------
    // session_id
    // ---------------------------------------------------------------

    #[test]
    fn session_id_default_empty() {
        let t = default_tracker();
        assert_eq!(t.session_id(), "");
    }

    #[test]
    fn set_session_id_propagates_to_snapshot() {
        let mut t = default_tracker();
        t.set_session_id("sess_123".to_string());
        assert_eq!(t.session_id(), "sess_123");

        let snap = t.snapshot();
        assert_eq!(snap.session_id, "sess_123");
    }

    #[test]
    fn set_session_id_propagates_to_delta() {
        let mut t = default_tracker();
        t.set_session_id("sess_abc".to_string());
        t.file_access("/a.rs", Action::Read);
        let delta = t.tick().unwrap();
        assert_eq!(delta.session_id, "sess_abc");
    }

    #[test]
    fn set_session_id_propagates_to_usage() {
        let mut t = default_tracker();
        t.set_session_id("sess_xyz".to_string());
        t.usage_update(100_000, 200_000);
        let msgs = t.take_pending_usage();
        assert_eq!(msgs[0].session_id, "sess_xyz");
    }

    // ---------------------------------------------------------------
    // file_access
    // ---------------------------------------------------------------

    #[test]
    fn file_access_creates_node() {
        let mut t = default_tracker();
        t.file_access("/src/main.rs", Action::Read);

        let snap = t.snapshot();
        assert_eq!(snap.nodes.len(), 1);

        let node = &snap.nodes["/src/main.rs"];
        assert_eq!(node.path, "/src/main.rs");
        assert_eq!(node.heat, 1.0);
        assert!(node.in_context);
        assert_eq!(node.last_action, Action::Read);
        assert_eq!(node.turn_accessed, 0);
    }

    #[test]
    fn file_access_resets_heat_and_updates_action() {
        let mut t = default_tracker();
        t.file_access("/src/main.rs", Action::Read);

        // Simulate some decay
        let node = t.files.get_mut("/src/main.rs").unwrap();
        node.heat = 0.5;
        node.in_context = false;

        // Re-access with a different action
        t.file_access("/src/main.rs", Action::Write);

        let node = &t.files["/src/main.rs"];
        assert_eq!(node.heat, 1.0);
        assert!(node.in_context);
        assert_eq!(node.last_action, Action::Write);
    }

    #[test]
    fn file_access_updates_turn_accessed() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);
        t.end_turn(); // turn 0 -> 1
        t.end_turn(); // turn 1 -> 2
        t.file_access("/a.rs", Action::Write);

        assert_eq!(t.files["/a.rs"].turn_accessed, 2);
    }

    // ---------------------------------------------------------------
    // end_turn + context expiry
    // ---------------------------------------------------------------

    #[test]
    fn end_turn_increments_turn() {
        let mut t = default_tracker();
        assert_eq!(t.current_turn(), 0);
        t.end_turn();
        assert_eq!(t.current_turn(), 1);
        t.end_turn();
        assert_eq!(t.current_turn(), 2);
    }

    #[test]
    fn file_exits_context_after_context_turns() {
        let mut t = ContextTracker::new(config_with(2, 0.5, 0.95));
        t.file_access("/a.rs", Action::Read); // turn 0

        // Still in context after 2 turns
        t.end_turn(); // turn 1
        t.end_turn(); // turn 2
        assert!(t.files["/a.rs"].in_context);

        // Exits context after 3rd end_turn (current_turn=3, accessed=0, gap=3 > 2)
        t.end_turn(); // turn 3
        assert!(!t.files["/a.rs"].in_context);
    }

    #[test]
    fn re_access_keeps_file_in_context() {
        let mut t = ContextTracker::new(config_with(1, 0.5, 0.95));
        t.file_access("/a.rs", Action::Read); // turn 0

        t.end_turn(); // turn 1
        t.file_access("/a.rs", Action::Read); // re-access at turn 1

        t.end_turn(); // turn 2
                      // gap = 2 - 1 = 1, which is NOT > 1, so still in context
        assert!(t.files["/a.rs"].in_context);

        t.end_turn(); // turn 3
                      // gap = 3 - 1 = 2 > 1 — now exits
        assert!(!t.files["/a.rs"].in_context);
    }

    // ---------------------------------------------------------------
    // tick + heat decay
    // ---------------------------------------------------------------

    #[test]
    fn tick_does_not_decay_in_context_files() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);

        // First tick drains the dirty set (the file_access above), but
        // the file is in_context so heat should stay at 1.0
        let delta = t.tick();
        assert!(delta.is_some()); // dirty from file_access

        let node = &t.files["/a.rs"];
        assert_eq!(node.heat, 1.0);

        // Subsequent tick — nothing changed
        let delta = t.tick();
        assert!(delta.is_none());
    }

    #[test]
    fn tick_decays_non_context_files() {
        let mut t = ContextTracker::new(config_with(0, 0.5, 0.90));
        t.file_access("/a.rs", Action::Read); // turn 0, in_context=true

        t.end_turn(); // turn 1, gap=1 > 0, file exits context
        assert!(!t.files["/a.rs"].in_context);

        // First tick: drains dirty from file_access+end_turn AND applies
        // decay (file is !in_context, heat=1.0 > 1.0*0.90 = 0.90)
        let delta = t.tick();
        assert!(delta.is_some());
        let d = delta.unwrap();
        assert_eq!(d.updates.len(), 1);
        assert!((d.updates[0].heat - 0.90).abs() < 0.001);

        // Second tick: 0.90 * 0.90 = 0.81
        let delta2 = t.tick().unwrap();
        assert!((delta2.updates[0].heat - 0.81).abs() < 0.001);
    }

    #[test]
    fn tick_clamps_heat_to_zero() {
        let mut t = ContextTracker::new(config_with(0, 0.5, 0.001));
        t.file_access("/a.rs", Action::Read);
        t.end_turn(); // exits context

        // First tick: heat=1.0 * 0.001 = 0.001 < 0.01 > clamped to 0.
        // File is removed (heat=0, !in_context).
        let delta = t.tick();
        assert!(delta.is_some());
        let d = delta.unwrap();
        assert!(d.removed.contains(&"/a.rs".to_string()));
        assert!(!t.files.contains_key("/a.rs"));
    }

    #[test]
    fn empty_tick_returns_none() {
        let mut t = default_tracker();
        assert!(t.tick().is_none());
    }

    // ---------------------------------------------------------------
    // delta sequencing
    // ---------------------------------------------------------------

    #[test]
    fn seq_increments_on_each_tick_with_changes() {
        let mut t = default_tracker();
        assert_eq!(t.seq(), 0);

        t.file_access("/a.rs", Action::Read);
        let d1 = t.tick().unwrap();
        assert_eq!(d1.seq, 1);

        t.file_access("/b.rs", Action::Write);
        let d2 = t.tick().unwrap();
        assert_eq!(d2.seq, 2);
    }

    #[test]
    fn seq_does_not_increment_on_empty_tick() {
        let mut t = default_tracker();
        t.tick(); // no changes
        assert_eq!(t.seq(), 0);
    }

    #[test]
    fn snapshot_includes_current_seq() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);
        t.tick(); // seq > 1

        let snap = t.snapshot();
        assert_eq!(snap.seq, 1);
    }

    // ---------------------------------------------------------------
    // compaction detection
    // ---------------------------------------------------------------

    #[test]
    fn compaction_evicts_all_files_from_context() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);
        t.file_access("/b.rs", Action::Write);

        // Simulate usage: 180k used
        t.usage_update(180_000, 200_000);

        assert!(t.files["/a.rs"].in_context);
        assert!(t.files["/b.rs"].in_context);

        // Usage drops to 45k — that's a 75% drop, above the 50% threshold
        t.usage_update(45_000, 200_000);

        assert!(!t.files["/a.rs"].in_context);
        assert!(!t.files["/b.rs"].in_context);
    }

    #[test]
    fn no_compaction_on_small_usage_drop() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);

        t.usage_update(100_000, 200_000);
        // Small drop: 100k -> 80k = 20% drop, below 50%
        t.usage_update(80_000, 200_000);

        assert!(t.files["/a.rs"].in_context);
    }

    #[test]
    fn compaction_on_first_usage_is_ignored() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);

        // First usage report — previous was 0, so no compaction logic
        t.usage_update(45_000, 200_000);

        assert!(t.files["/a.rs"].in_context);
    }

    // ---------------------------------------------------------------
    // usage_update queues UsageMessage
    // ---------------------------------------------------------------

    #[test]
    fn usage_update_queues_message() {
        let mut t = default_tracker();
        t.usage_update(100_000, 200_000);

        let msgs = t.take_pending_usage();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].used, 100_000);
        assert_eq!(msgs[0].size, 200_000);
        assert_eq!(msgs[0].msg_type, "usage");
    }

    #[test]
    fn take_pending_usage_drains() {
        let mut t = default_tracker();
        t.usage_update(100_000, 200_000);
        t.usage_update(50_000, 200_000);

        let msgs = t.take_pending_usage();
        assert_eq!(msgs.len(), 2);

        // Second call returns empty
        let msgs2 = t.take_pending_usage();
        assert!(msgs2.is_empty());
    }

    // ---------------------------------------------------------------
    // snapshot filtering
    // ---------------------------------------------------------------

    #[test]
    fn snapshot_excludes_cold_files() {
        let mut t = ContextTracker::new(config_with(0, 0.5, 0.001));
        t.file_access("/a.rs", Action::Read);
        t.end_turn(); // exits context

        // Drain dirty + decay to zero
        t.tick();
        t.tick();

        let snap = t.snapshot();
        assert!(snap.nodes.is_empty());
    }

    #[test]
    fn snapshot_includes_in_context_zero_heat() {
        // Edge case: shouldn't happen normally, but test the filter logic
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);
        // Artificially set heat to 0 while keeping in_context
        t.files.get_mut("/a.rs").unwrap().heat = 0.0;

        let snap = t.snapshot();
        // in_context=true, so it should still be included
        assert_eq!(snap.nodes.len(), 1);
    }

    // ---------------------------------------------------------------
    // multiple files in a single tick
    // ---------------------------------------------------------------

    #[test]
    fn multiple_file_accesses_coalesced_into_single_delta() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);
        t.file_access("/b.rs", Action::Write);
        t.file_access("/c.rs", Action::Search);

        let delta = t.tick().unwrap();
        assert_eq!(delta.seq, 1); // single seq increment
        assert_eq!(delta.updates.len(), 3);
    }

    // ---------------------------------------------------------------
    // Action variants in file node
    // ---------------------------------------------------------------

    #[test]
    fn all_action_variants_stored() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::UserProvided);
        assert_eq!(t.files["/a.rs"].last_action, Action::UserProvided);

        t.file_access("/b.rs", Action::UserReferenced);
        assert_eq!(t.files["/b.rs"].last_action, Action::UserReferenced);

        t.file_access("/c.rs", Action::Search);
        assert_eq!(t.files["/c.rs"].last_action, Action::Search);
    }

    #[test]
    fn search_access_marks_in_context() {
        let mut t = default_tracker();
        t.file_access("/src", Action::Search);
        assert!(t.files["/src"].in_context);
        assert_eq!(t.files["/src"].heat, 1.0);
    }

    // ---------------------------------------------------------------
    // Edge cases: long paths
    // ---------------------------------------------------------------

    #[test]
    fn long_file_path() {
        let mut t = default_tracker();
        // 1000-char path
        let long_path = format!("/{}", "a".repeat(999));
        t.file_access(&long_path, Action::Read);

        let snap = t.snapshot();
        assert_eq!(snap.nodes.len(), 1);
        assert!(snap.nodes.contains_key(&long_path));

        let delta = t.tick().unwrap();
        assert_eq!(delta.updates[0].path, long_path);
    }

    #[test]
    fn unicode_file_path() {
        let mut t = default_tracker();
        let path = "/home/user/src/\u{1F600}_emoji.rs";
        t.file_access(path, Action::Write);

        let snap = t.snapshot();
        assert!(snap.nodes.contains_key(path));
    }

    #[test]
    fn empty_path() {
        let mut t = default_tracker();
        t.file_access("", Action::Read);

        let snap = t.snapshot();
        assert_eq!(snap.nodes.len(), 1);
        assert!(snap.nodes.contains_key(""));
    }

    // ---------------------------------------------------------------
    // Edge cases: thousands of nodes (perf sanity)
    // ---------------------------------------------------------------

    #[test]
    fn thousand_nodes_tick_performance() {
        let mut t = ContextTracker::new(config_with(0, 0.5, 0.95));

        // Add 1000 files
        for i in 0..1000 {
            t.file_access(&format!("/file_{i:04}.rs"), Action::Read);
        }
        t.end_turn(); // all exit context

        // First tick: should process all 1000 nodes
        let delta = t.tick().unwrap();
        assert_eq!(delta.updates.len(), 1000);

        // Second tick: still 1000 decaying
        let delta2 = t.tick().unwrap();
        assert_eq!(delta2.updates.len(), 1000);

        // Verify seq increments correctly
        assert_eq!(delta.seq, 1);
        assert_eq!(delta2.seq, 2);
    }

    #[test]
    fn thousand_nodes_snapshot() {
        let mut t = default_tracker();
        for i in 0..1000 {
            t.file_access(&format!("/file_{i:04}.rs"), Action::Read);
        }

        let snap = t.snapshot();
        assert_eq!(snap.nodes.len(), 1000);
    }

    // ---------------------------------------------------------------
    // Edge cases: rapid file_access + tick interleaving
    // ---------------------------------------------------------------

    #[test]
    fn file_access_between_ticks() {
        let mut t = default_tracker();

        // Access, tick, access same file, tick
        t.file_access("/a.rs", Action::Read);
        let d1 = t.tick().unwrap();
        assert_eq!(d1.updates.len(), 1);
        assert_eq!(d1.updates[0].heat, 1.0); // just accessed

        // Re-access same file between ticks
        t.file_access("/a.rs", Action::Write);
        let d2 = t.tick().unwrap();
        assert_eq!(d2.updates.len(), 1);
        assert_eq!(d2.updates[0].last_action, Action::Write);
        assert_eq!(d2.updates[0].heat, 1.0); // re-accessed resets heat
    }

    #[test]
    fn same_file_accessed_multiple_times_between_ticks() {
        let mut t = default_tracker();

        // Access same file 5 times with different actions
        t.file_access("/a.rs", Action::Read);
        t.file_access("/a.rs", Action::Write);
        t.file_access("/a.rs", Action::Search);
        t.file_access("/a.rs", Action::Read);
        t.file_access("/a.rs", Action::UserProvided);

        let delta = t.tick().unwrap();
        // Should coalesce into a single update (last action wins)
        assert_eq!(delta.updates.len(), 1);
        assert_eq!(delta.updates[0].last_action, Action::UserProvided);
        assert_eq!(delta.updates[0].heat, 1.0);
    }

    // ---------------------------------------------------------------
    // Edge cases: multiple compaction events
    // ---------------------------------------------------------------

    #[test]
    fn multiple_compactions_in_sequence() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);
        t.file_access("/b.rs", Action::Write);

        // First usage report
        t.usage_update(180_000, 200_000);

        // First compaction
        t.usage_update(45_000, 200_000);
        assert!(!t.files["/a.rs"].in_context);
        assert!(!t.files["/b.rs"].in_context);

        // Re-access after compaction
        t.file_access("/a.rs", Action::Read);
        assert!(t.files["/a.rs"].in_context);
        assert!(!t.files["/b.rs"].in_context);

        // Usage climbs back up
        t.usage_update(160_000, 200_000);

        // Second compaction
        t.usage_update(40_000, 200_000);
        assert!(!t.files["/a.rs"].in_context);
    }

    #[test]
    fn compaction_then_immediate_file_access() {
        let mut t = default_tracker();
        t.file_access("/a.rs", Action::Read);

        t.usage_update(180_000, 200_000);
        t.usage_update(45_000, 200_000); // compaction

        assert!(!t.files["/a.rs"].in_context);

        // Immediately re-access
        t.file_access("/a.rs", Action::Write);
        assert!(t.files["/a.rs"].in_context);
        assert_eq!(t.files["/a.rs"].heat, 1.0);
        assert_eq!(t.files["/a.rs"].last_action, Action::Write);
    }

    #[test]
    fn compaction_with_no_files() {
        let mut t = default_tracker();
        // Compaction on empty tracker should not panic
        t.usage_update(180_000, 200_000);
        t.usage_update(45_000, 200_000);
        // No files to evict — should be a no-op
        assert!(t.files.is_empty());
    }

    // ---------------------------------------------------------------
    // Edge cases: end_turn with no files
    // ---------------------------------------------------------------

    #[test]
    fn end_turn_with_no_files() {
        let mut t = default_tracker();
        // Should not panic
        t.end_turn();
        t.end_turn();
        assert_eq!(t.current_turn(), 2);
    }

    // ---------------------------------------------------------------
    // Edge cases: tick after file removed
    // ---------------------------------------------------------------

    #[test]
    fn tick_after_all_files_pruned() {
        let mut t = ContextTracker::new(config_with(0, 0.5, 0.001));
        t.file_access("/a.rs", Action::Read);
        t.end_turn();

        // First tick prunes the file
        let d = t.tick().unwrap();
        assert!(!d.removed.is_empty());

        // Subsequent ticks are empty
        assert!(t.tick().is_none());
        assert!(t.tick().is_none());
    }

    // ---------------------------------------------------------------
    // Edge cases: re-access a pruned file
    // ---------------------------------------------------------------

    #[test]
    fn re_access_after_prune() {
        let mut t = ContextTracker::new(config_with(0, 0.5, 0.001));
        t.file_access("/a.rs", Action::Read);
        t.end_turn();
        t.tick(); // prunes /a.rs
        assert!(!t.files.contains_key("/a.rs"));

        // Re-access creates a fresh node
        t.file_access("/a.rs", Action::Write);
        assert!(t.files.contains_key("/a.rs"));
        assert_eq!(t.files["/a.rs"].heat, 1.0);
        assert!(t.files["/a.rs"].in_context);
        assert_eq!(t.files["/a.rs"].last_action, Action::Write);
    }

    // ---------------------------------------------------------------
    // Edge cases: usage queuing
    // ---------------------------------------------------------------

    #[test]
    fn multiple_usage_updates_queue_all() {
        let mut t = default_tracker();
        t.usage_update(100_000, 200_000);
        t.usage_update(110_000, 200_000);
        t.usage_update(120_000, 200_000);

        let msgs = t.take_pending_usage();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].used, 100_000);
        assert_eq!(msgs[1].used, 110_000);
        assert_eq!(msgs[2].used, 120_000);
    }
}
