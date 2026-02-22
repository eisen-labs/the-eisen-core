use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::types::{SessionKey, SessionMode, SessionModel, SessionState, SessionSummary};

const DEFAULT_DIR_NAME: &str = ".eisen";
const DEFAULT_FILE_NAME: &str = "core_sessions.json";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn default_eisen_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("EISEN_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(DEFAULT_DIR_NAME);
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join(DEFAULT_DIR_NAME);
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(DEFAULT_DIR_NAME)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredRegistry {
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<SessionKey>,
    #[serde(default)]
    sessions: Vec<SessionState>,
}

#[derive(Debug, Clone)]
struct SessionStore {
    path: PathBuf,
}

impl SessionStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn default_path() -> PathBuf {
        default_eisen_dir().join(DEFAULT_FILE_NAME)
    }

    fn load(&self) -> Result<StoredRegistry> {
        if !self.path.exists() {
            return Ok(StoredRegistry::default());
        }
        let raw = fs::read_to_string(&self.path)
            .with_context(|| format!("failed to read session store {}", self.path.display()))?;
        let parsed = serde_json::from_str(&raw)
            .with_context(|| format!("failed to parse session store {}", self.path.display()))?;
        Ok(parsed)
    }

    fn save(&self, data: &StoredRegistry) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create session store dir {}", parent.display())
            })?;
        }
        let serialized =
            serde_json::to_string_pretty(data).context("failed to serialize session registry")?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, serialized).with_context(|| {
            format!("failed to write temp session store {}", tmp_path.display())
        })?;
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
        fs::rename(&tmp_path, &self.path).with_context(|| {
            format!(
                "failed to move session store {} -> {}",
                tmp_path.display(),
                self.path.display()
            )
        })?;
        Ok(())
    }
}

#[derive(Debug)]
pub struct SessionRegistry {
    sessions: HashMap<SessionKey, SessionState>,
    active: Option<SessionKey>,
    store: SessionStore,
}

impl SessionRegistry {
    pub fn load_default() -> Self {
        Self::load(SessionStore::new(SessionStore::default_path()))
    }

    pub fn load_from_path(path: PathBuf) -> Self {
        Self::load(SessionStore::new(path))
    }

    fn load(store: SessionStore) -> Self {
        let stored = match store.load() {
            Ok(data) => data,
            Err(err) => {
                warn!(error = %err, "failed to load session registry, starting empty");
                StoredRegistry::default()
            }
        };
        let mut sessions = HashMap::new();
        for session in stored.sessions {
            sessions.insert(session.key(), session);
        }
        Self {
            sessions,
            active: stored.active,
            store,
        }
    }

    fn persist(&self) -> Result<()> {
        let stored = StoredRegistry {
            active: self.active.clone(),
            sessions: self.sessions.values().cloned().collect(),
        };
        self.store.save(&stored)
    }

    pub fn list_sessions(&self, agent_id: Option<&str>) -> Vec<SessionSummary> {
        let mut sessions: Vec<SessionSummary> = self
            .sessions
            .values()
            .filter(|session| agent_id.is_none_or(|a| a == session.agent_id))
            .map(|session| SessionSummary {
                agent_id: session.agent_id.clone(),
                session_id: session.session_id.clone(),
                mode: session.mode,
                model: session.model.clone(),
                updated_at_ms: session.updated_at_ms,
                is_active: self
                    .active
                    .as_ref()
                    .map(|key| key.matches(session))
                    .unwrap_or(false),
            })
            .collect();
        sessions.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
        sessions
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_session(
        &mut self,
        agent_id: String,
        session_id: String,
        mode: SessionMode,
        model: Option<SessionModel>,
        summary: Option<String>,
        history: Option<Vec<serde_json::Value>>,
        context: Option<Vec<serde_json::Value>>,
        providers: Option<Vec<SessionKey>>,
    ) -> Result<SessionState> {
        let key = SessionKey::new(&agent_id, &session_id);
        let now = now_ms();
        let entry = self
            .sessions
            .entry(key.clone())
            .or_insert_with(|| SessionState {
                agent_id: agent_id.clone(),
                session_id: session_id.clone(),
                mode,
                model: model.clone(),
                history: history.clone().unwrap_or_default(),
                summary: summary.clone(),
                context: context.clone().unwrap_or_default(),
                providers: providers.clone().unwrap_or_default(),
                created_at_ms: now,
                updated_at_ms: now,
            });

        entry.mode = mode;
        if model.is_some() {
            entry.model = model;
        }
        if summary.is_some() {
            entry.summary = summary;
        }
        if let Some(history) = history {
            entry.history = history;
        }
        if let Some(context) = context {
            entry.context = context;
        }
        if let Some(providers) = providers {
            entry.providers = providers;
            if !entry.providers.is_empty() {
                entry.mode = SessionMode::Orchestrator;
            }
        }
        entry.updated_at_ms = now;

        let result = entry.clone();
        self.persist()?;
        Ok(result)
    }

    pub fn close_session(&mut self, key: &SessionKey) -> Result<bool> {
        let removed = self.sessions.remove(key).is_some();
        if self.active.as_ref() == Some(key) {
            self.active = None;
        }
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    pub fn set_active_session(&mut self, key: SessionKey) -> Result<bool> {
        if !self.sessions.contains_key(&key) {
            return Ok(false);
        }
        self.active = Some(key);
        self.persist()?;
        Ok(true)
    }

    pub fn active_session(&self) -> Option<SessionKey> {
        self.active.clone()
    }

    pub fn get_session_state(&self, key: &SessionKey) -> Option<SessionState> {
        self.sessions.get(key).cloned()
    }

    pub fn orchestrator_sessions(&self) -> Vec<SessionState> {
        self.sessions
            .values()
            .filter(|session| session.mode == SessionMode::Orchestrator)
            .cloned()
            .collect()
    }

    pub fn set_orchestrator_providers(
        &mut self,
        key: &SessionKey,
        providers: Vec<SessionKey>,
    ) -> Result<Option<SessionState>> {
        let now = now_ms();
        let Some(session) = self.sessions.get_mut(key) else {
            return Ok(None);
        };
        session.providers = providers;
        session.mode = SessionMode::Orchestrator;
        session.updated_at_ms = now;
        let result = session.clone();
        self.persist()?;
        Ok(Some(result))
    }

    pub fn add_context_items(
        &mut self,
        key: &SessionKey,
        items: Vec<serde_json::Value>,
    ) -> Result<Option<SessionState>> {
        let now = now_ms();
        let Some(session) = self.sessions.get_mut(key) else {
            return Ok(None);
        };
        if !items.is_empty() {
            session.context.extend(items);
        }
        session.updated_at_ms = now;
        let result = session.clone();
        self.persist()?;
        Ok(Some(result))
    }
}

impl SessionKey {
    fn matches(&self, session: &SessionState) -> bool {
        self.agent_id == session.agent_id && self.session_id == session.session_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SessionKey, SessionMode};
    use tempfile::tempdir;

    fn test_registry() -> (SessionRegistry, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("core_sessions.json");
        (SessionRegistry::load_from_path(path), dir)
    }

    #[test]
    fn create_and_list_sessions() {
        let (mut registry, _dir) = test_registry();
        let session = registry
            .create_session(
                "agent-a".to_string(),
                "sess-1".to_string(),
                SessionMode::SingleAgent,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();

        assert_eq!(session.agent_id, "agent-a");
        let sessions = registry.list_sessions(None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "sess-1");
    }

    #[test]
    fn set_active_session() {
        let (mut registry, _dir) = test_registry();
        registry
            .create_session(
                "agent-a".to_string(),
                "sess-1".to_string(),
                SessionMode::SingleAgent,
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();

        let key = SessionKey::new("agent-a", "sess-1");
        assert!(registry.set_active_session(key).unwrap());
        let sessions = registry.list_sessions(None);
        assert!(sessions[0].is_active);
    }
}
