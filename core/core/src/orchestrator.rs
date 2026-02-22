use std::collections::HashMap;

use crate::session_registry::SessionRegistry;
use crate::tracker::ContextTracker;
use crate::types::{
    Action, Cost, Delta, FileNode, NodeUpdate, SessionKey, SessionMode, Snapshot, UsageMessage,
};

#[derive(Debug, Default)]
pub struct OrchestratorAggregator {
    sessions: HashMap<SessionKey, OrchestratorSessionState>,
}

#[derive(Debug, Default)]
struct OrchestratorSessionState {
    seq: u64,
    nodes: HashMap<String, FileNode>,
    provider_usage: HashMap<SessionKey, UsageMessage>,
}

impl OrchestratorAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot_for_session(
        &mut self,
        session: &crate::types::SessionState,
        tracker: &ContextTracker,
    ) -> Snapshot {
        let key = session.key();
        let nodes = compute_aggregate_nodes(&session.providers, tracker);
        let state = self.sessions.entry(key).or_default();

        if nodes_changed(&state.nodes, &nodes) {
            state.seq += 1;
        }
        state.nodes = nodes;

        Snapshot::new(
            tracker.agent_id(),
            &session.session_id,
            SessionMode::Orchestrator,
            state.seq,
            state.nodes.clone(),
        )
    }

    pub fn tick(&mut self, tracker: &ContextTracker, registry: &SessionRegistry) -> Vec<Delta> {
        let mut deltas = Vec::new();
        let orchestrators = registry.orchestrator_sessions();
        let agent_id = tracker.agent_id().to_string();

        let mut active_keys = Vec::new();
        for session in orchestrators {
            let key = session.key();
            active_keys.push(key.clone());

            let nodes = compute_aggregate_nodes(&session.providers, tracker);
            let state = self.sessions.entry(key.clone()).or_default();

            let (updates, removed) = diff_nodes(&state.nodes, &nodes);
            if !updates.is_empty() || !removed.is_empty() {
                state.seq += 1;
                deltas.push(Delta::new(
                    &agent_id,
                    &session.session_id,
                    SessionMode::Orchestrator,
                    state.seq,
                    updates,
                    removed,
                ));
            }

            state.nodes = nodes;
        }

        // Drop orchestrator state for sessions that no longer exist
        self.sessions
            .retain(|key, _| active_keys.iter().any(|active| active == key));

        deltas
    }

    pub fn aggregate_usage(
        &mut self,
        tracker: &ContextTracker,
        registry: &SessionRegistry,
        usage_msgs: &[UsageMessage],
    ) -> Vec<UsageMessage> {
        if usage_msgs.is_empty() {
            return Vec::new();
        }

        let mut outputs = Vec::new();
        let orchestrators = registry.orchestrator_sessions();
        if orchestrators.is_empty() {
            return outputs;
        }

        for usage in usage_msgs {
            let provider_key = SessionKey::new(&usage.agent_id, &usage.session_id);
            for session in &orchestrators {
                if !session.providers.contains(&provider_key) {
                    continue;
                }
                let state = self.sessions.entry(session.key()).or_default();
                state
                    .provider_usage
                    .insert(provider_key.clone(), usage.clone());

                state
                    .provider_usage
                    .retain(|key, _| session.providers.contains(key));
                if let Some(usage_msg) = aggregate_usage_for_session(
                    tracker.agent_id(),
                    &session.session_id,
                    &session.providers,
                    &state.provider_usage,
                ) {
                    outputs.push(usage_msg);
                }
            }
        }

        outputs
    }
}

fn compute_aggregate_nodes(
    providers: &[SessionKey],
    tracker: &ContextTracker,
) -> HashMap<String, FileNode> {
    let mut aggregate = HashMap::new();
    let agent_id = tracker.agent_id();

    for provider in providers {
        if provider.agent_id != agent_id {
            continue;
        }
        let snap = tracker.snapshot_for_session(&provider.session_id);
        for node in snap.nodes.values() {
            merge_node(&mut aggregate, node);
        }
    }

    aggregate
}

fn merge_node(target: &mut HashMap<String, FileNode>, node: &FileNode) {
    match target.get_mut(&node.path) {
        None => {
            target.insert(node.path.clone(), node.clone());
        }
        Some(existing) => {
            existing.heat = existing.heat.max(node.heat);
            existing.in_context = existing.in_context || node.in_context;
            existing.turn_accessed = existing.turn_accessed.max(node.turn_accessed);

            let should_replace = node.timestamp_ms > existing.timestamp_ms
                || (node.timestamp_ms == existing.timestamp_ms
                    && action_priority(node.last_action) > action_priority(existing.last_action));
            if should_replace {
                existing.last_action = node.last_action;
                existing.timestamp_ms = node.timestamp_ms;
            }
        }
    }
}

fn action_priority(action: Action) -> u8 {
    match action {
        Action::Write => 3,
        Action::Search => 2,
        _ => 1,
    }
}

fn nodes_changed(old: &HashMap<String, FileNode>, new: &HashMap<String, FileNode>) -> bool {
    if old.len() != new.len() {
        return true;
    }
    for (path, node) in new {
        let Some(old_node) = old.get(path) else {
            return true;
        };
        if !nodes_equal(old_node, node) {
            return true;
        }
    }
    false
}

fn nodes_equal(a: &FileNode, b: &FileNode) -> bool {
    a.heat == b.heat
        && a.in_context == b.in_context
        && a.last_action == b.last_action
        && a.turn_accessed == b.turn_accessed
        && a.timestamp_ms == b.timestamp_ms
}

fn diff_nodes(
    old: &HashMap<String, FileNode>,
    new: &HashMap<String, FileNode>,
) -> (Vec<NodeUpdate>, Vec<String>) {
    let mut updates = Vec::new();
    let mut removed = Vec::new();

    for (path, node) in new {
        match old.get(path) {
            None => updates.push(node.to_update()),
            Some(old_node) => {
                if !nodes_equal(old_node, node) {
                    updates.push(node.to_update());
                }
            }
        }
    }

    for path in old.keys() {
        if !new.contains_key(path) {
            removed.push(path.clone());
        }
    }

    (updates, removed)
}

fn aggregate_usage_for_session(
    agent_id: &str,
    session_id: &str,
    providers: &[SessionKey],
    provider_usage: &HashMap<SessionKey, UsageMessage>,
) -> Option<UsageMessage> {
    if providers.is_empty() {
        return None;
    }

    let mut used_total: u32 = 0;
    let mut size_total: u32 = 0;
    let mut cost_total: Option<Cost> = None;

    for provider in providers {
        let Some(usage) = provider_usage.get(provider) else {
            continue;
        };
        used_total = used_total.saturating_add(usage.used);
        size_total = size_total.saturating_add(usage.size);

        match (&cost_total, &usage.cost) {
            (None, Some(cost)) => {
                cost_total = Some(Cost {
                    amount: cost.amount,
                    currency: cost.currency.clone(),
                });
            }
            (Some(existing), Some(cost)) => {
                if existing.currency == cost.currency {
                    cost_total = Some(Cost {
                        amount: existing.amount + cost.amount,
                        currency: existing.currency.clone(),
                    });
                } else {
                    cost_total = None;
                }
            }
            (_, None) => {
                cost_total = None;
            }
        }
    }

    Some(UsageMessage::new(
        agent_id,
        session_id,
        SessionMode::Orchestrator,
        used_total,
        size_total,
        cost_total,
    ))
}
