//! How sources are grouped on the Sources page and in the sidebar
//! (Settings → General → Source grouping).
//!
//! Docker sources keep their container labels ([`SourceMeta::labels`](crate::hub::SourceMeta));
//! the group is worked out from them each time `/api/sources` is read, so a
//! change in Settings regroups everything live, without a restart and without
//! touching stored lines.
//!
//! - **auto** (default): a `quiet.group` label wins, then the Compose project
//!   (`com.docker.compose.project`), then the Swarm stack
//!   (`com.docker.stack.namespace`), else **Standalone**.
//! - **label**: the value of one label the owner names (e.g. `quiet.group`);
//!   containers without it are **Standalone**.
//! - **off**: no groups (a flat list).
//!
//! Pushed sources (HTTP, Vector, Fluent Bit, OTLP) have no labels and form one
//! **Ingest** group in auto and label mode.
//!
//! Process-wide like [`idpolicy`](crate::idpolicy): [`Settings`](crate::settings::Settings)
//! installs the effective value at startup and on every change; tests and
//! `Settings::memory()` never touch it, so the default (auto) holds there.

use crate::hub::SourceKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use ts_rs::TS;

pub const COMPOSE_PROJECT: &str = "com.docker.compose.project";
pub const SWARM_STACK: &str = "com.docker.stack.namespace";
/// Per-container override in auto mode, and the suggested custom label.
pub const QUIET_GROUP: &str = "quiet.group";
pub const DEFAULT_GROUP_LABEL: &str = QUIET_GROUP;
pub const STANDALONE_GROUP: &str = "Standalone";
pub const INGEST_GROUP: &str = "Ingest";

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default, clap::ValueEnum,
)]
#[serde(rename_all = "lowercase")]
pub enum GroupMode {
    /// `quiet.group` → Compose project → Swarm stack → Standalone.
    #[default]
    Auto,
    /// One Docker label the owner names; missing → Standalone.
    Label,
    /// No groups.
    Off,
}

/// What a source's group is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    /// `com.docker.compose.project`
    Compose,
    /// `com.docker.stack.namespace` (Swarm)
    Stack,
    /// From `quiet.group` (auto) or the custom label.
    Custom,
    /// A Docker container in no group.
    Standalone,
    /// Pushed over HTTP, Vector, Fluent Bit or OTLP.
    Ingest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grouping {
    pub mode: GroupMode,
    /// The label read in `label` mode.
    pub label: String,
}

impl Default for Grouping {
    fn default() -> Self {
        Grouping {
            mode: GroupMode::Auto,
            label: DEFAULT_GROUP_LABEL.into(),
        }
    }
}

impl Grouping {
    /// The group of a source of `kind` whose (first) container carries `labels`.
    pub fn group_of(
        &self,
        kind: SourceKind,
        labels: &HashMap<String, String>,
    ) -> Option<(String, GroupKind)> {
        if self.mode == GroupMode::Off {
            return None;
        }
        if kind != SourceKind::Docker {
            return Some((INGEST_GROUP.into(), GroupKind::Ingest));
        }
        let label = |k: &str| {
            labels
                .get(k)
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(String::from)
        };
        let found = match self.mode {
            GroupMode::Label => label(&self.label).map(|g| (g, GroupKind::Custom)),
            _ => label(QUIET_GROUP)
                .map(|g| (g, GroupKind::Custom))
                .or_else(|| label(COMPOSE_PROJECT).map(|g| (g, GroupKind::Compose)))
                .or_else(|| label(SWARM_STACK).map(|g| (g, GroupKind::Stack))),
        };
        Some(found.unwrap_or_else(|| (STANDALONE_GROUP.into(), GroupKind::Standalone)))
    }
}

/// A label key Docker accepts: letters, digits, `.`, `-`, `_`, `/`; 1–128 chars.
pub fn valid_label(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 128
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'))
}

static CURRENT: LazyLock<RwLock<Grouping>> = LazyLock::new(|| RwLock::new(Grouping::default()));

/// Group every source this way from now on.
pub fn install(g: Grouping) {
    *CURRENT.write().unwrap() = g;
}

pub fn current() -> Grouping {
    CURRENT.read().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn auto_mode_label_to_group() {
        let g = Grouping::default();
        let d = SourceKind::Docker;
        let of = |p: &[(&str, &str)]| g.group_of(d, &labels(p)).unwrap();
        assert_eq!(
            of(&[(COMPOSE_PROJECT, "apps")]),
            ("apps".into(), GroupKind::Compose)
        );
        assert_eq!(
            of(&[(SWARM_STACK, "shop")]),
            ("shop".into(), GroupKind::Stack)
        );
        // Compose project before Swarm stack; quiet.group before both.
        assert_eq!(
            of(&[(SWARM_STACK, "shop"), (COMPOSE_PROJECT, "apps")]),
            ("apps".into(), GroupKind::Compose)
        );
        assert_eq!(
            of(&[(QUIET_GROUP, "payments"), (COMPOSE_PROJECT, "apps")]),
            ("payments".into(), GroupKind::Custom)
        );
        // No label, or an empty one: Standalone.
        assert_eq!(of(&[]), (STANDALONE_GROUP.into(), GroupKind::Standalone));
        assert_eq!(
            of(&[(COMPOSE_PROJECT, " ")]),
            (STANDALONE_GROUP.into(), GroupKind::Standalone)
        );
        // Pushed sources: Ingest.
        assert_eq!(
            g.group_of(SourceKind::Otlp, &HashMap::new()),
            Some((INGEST_GROUP.into(), GroupKind::Ingest))
        );
    }

    #[test]
    fn label_and_off_modes() {
        let g = Grouping {
            mode: GroupMode::Label,
            label: "team".into(),
        };
        let d = SourceKind::Docker;
        assert_eq!(
            g.group_of(d, &labels(&[("team", "growth"), (COMPOSE_PROJECT, "apps")])),
            Some(("growth".into(), GroupKind::Custom))
        );
        assert_eq!(
            g.group_of(d, &labels(&[(COMPOSE_PROJECT, "apps")])),
            Some((STANDALONE_GROUP.into(), GroupKind::Standalone))
        );
        let off = Grouping {
            mode: GroupMode::Off,
            ..Default::default()
        };
        assert_eq!(off.group_of(d, &labels(&[(COMPOSE_PROJECT, "apps")])), None);
        assert_eq!(off.group_of(SourceKind::Http, &HashMap::new()), None);
        assert!(valid_label("com.example/team_1") && !valid_label("a b") && !valid_label(""));
    }
}
