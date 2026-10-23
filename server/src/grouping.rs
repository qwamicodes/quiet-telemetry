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
//! **Custom groups** ([`CustomGroups`]) are made from the Sources page: named,
//! ordered groups an owner or admin moves sources into by hand. A manual
//! assignment wins over the automatic group of that source in auto and label
//! mode, and custom groups sit above the automatic ones; "Automatic" (or
//! deleting the group) falls back to the automatic group. Off mode shows a
//! flat list but keeps them, so they come back when grouping is turned on
//! again. `QUIET_GROUP_BY` locks the mode only, never the custom groups.
//! They are saved with the settings (`source_groups`), not installed
//! process-wide: `/api/sources` applies them on each read.
//!
//! Process-wide like [`idpolicy`](crate::idpolicy): [`Settings`](crate::settings::Settings)
//! installs the effective value at startup and on every change; tests and
//! `Settings::memory()` never touch it, so the default (auto) holds there.

use crate::hub::SourceKind;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
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
    /// A custom group made on the Sources page (a manual assignment).
    /// Not to be confused with `custom` (a label-derived group).
    Manual,
}

/// At most this many custom groups per instance.
pub const MAX_CUSTOM_GROUPS: usize = 64;
/// Custom group names: 1–48 characters (trimmed), no control characters.
pub const MAX_GROUP_NAME: usize = 48;
/// At most this many manual assignments per instance.
pub const MAX_ASSIGNMENTS: usize = 10_000;

/// One custom group (Sources → New group).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CustomGroup {
    /// Stable id (`g_…`); assignments and the UI's collapse state use it, so a
    /// rename keeps both.
    pub id: String,
    pub name: String,
    /// Position among custom groups, 0 first (always the index in the list).
    pub order: u32,
}

/// The custom groups of the instance and which source sits in which, shared
/// by every user (`GET /api/source-groups`; the list is also in `GET /api/sources`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct CustomGroups {
    /// In display order.
    pub groups: Vec<CustomGroup>,
    /// Source name (the real one, not the display name) → group id.
    pub assigned: BTreeMap<String, String>,
}

impl CustomGroups {
    pub fn get(&self, id: &str) -> Option<&CustomGroup> {
        self.groups.iter().find(|g| g.id == id)
    }

    /// The custom group `source` was moved into, if it still exists.
    pub fn group_for(&self, source: &str) -> Option<&CustomGroup> {
        self.assigned.get(source).and_then(|id| self.get(id))
    }

    /// Sources assigned to `id`.
    #[cfg(test)]
    pub fn members(&self, id: &str) -> usize {
        self.assigned.values().filter(|g| *g == id).count()
    }

    /// `order` = position; assignments to groups that no longer exist dropped.
    pub fn normalize(&mut self) {
        for (i, g) in self.groups.iter_mut().enumerate() {
            g.order = i as u32;
        }
        let ids: std::collections::HashSet<String> =
            self.groups.iter().map(|g| g.id.clone()).collect();
        self.assigned.retain(|_, g| ids.contains(g));
    }

    /// A name taken by another custom group (case-insensitive)?
    pub fn name_taken(&self, name: &str, except: Option<&str>) -> bool {
        let n = name.to_lowercase();
        self.groups
            .iter()
            .any(|g| Some(g.id.as_str()) != except && g.name.to_lowercase() == n)
    }
}

/// A custom group name, trimmed, or why not.
pub fn clean_group_name(name: &str) -> Result<String, &'static str> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_GROUP_NAME || n.chars().any(char::is_control) {
        return Err("name: 1–48 characters");
    }
    Ok(n.to_string())
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
    /// Where `source` sits: its custom group when it was moved into one (in
    /// auto and label mode), else its automatic group. `None` when off.
    /// Returns `(name, kind, custom group)`.
    pub fn place<'a>(
        &self,
        source: &str,
        kind: SourceKind,
        labels: &HashMap<String, String>,
        custom: &'a CustomGroups,
    ) -> Option<(String, GroupKind, Option<&'a CustomGroup>)> {
        if self.mode == GroupMode::Off {
            return None;
        }
        if let Some(g) = custom.group_for(source) {
            return Some((g.name.clone(), GroupKind::Manual, Some(g)));
        }
        self.group_of(kind, labels).map(|(n, k)| (n, k, None))
    }

    /// The automatic group of a source of `kind` whose (first) container carries `labels`.
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

    #[test]
    fn a_manual_assignment_wins_in_auto_and_label_mode_but_not_off() {
        let custom = CustomGroups {
            groups: vec![CustomGroup {
                id: "g_1".into(),
                name: "Dokploy apps".into(),
                order: 0,
            }],
            assigned: [
                ("api".to_string(), "g_1".to_string()),
                ("gone".to_string(), "g_missing".to_string()),
            ]
            .into(),
        };
        let d = SourceKind::Docker;
        let compose = labels(&[(COMPOSE_PROJECT, "apps")]);
        for mode in [GroupMode::Auto, GroupMode::Label] {
            let g = Grouping {
                mode,
                ..Default::default()
            };
            let (name, kind, cg) = g.place("api", d, &compose, &custom).unwrap();
            assert_eq!((name.as_str(), kind), ("Dokploy apps", GroupKind::Manual));
            assert_eq!(cg.unwrap().id, "g_1");
            // Unassigned (or assigned to a group that is gone): automatic.
            let (_, kind, cg) = g.place("web", d, &compose, &custom).unwrap();
            assert!(cg.is_none() && kind != GroupKind::Manual);
            let (_, kind, _) = g.place("gone", d, &labels(&[]), &custom).unwrap();
            assert_eq!(kind, GroupKind::Standalone);
        }
        // Pushed sources can be moved too.
        let g = Grouping::default();
        assert_eq!(
            g.place("api", SourceKind::Otlp, &HashMap::new(), &custom)
                .unwrap()
                .1,
            GroupKind::Manual
        );
        let off = Grouping {
            mode: GroupMode::Off,
            ..Default::default()
        };
        assert!(off.place("api", d, &compose, &custom).is_none());
    }

    #[test]
    fn custom_groups_normalize_and_names_are_checked() {
        let mut c = CustomGroups {
            groups: vec![
                CustomGroup {
                    id: "a".into(),
                    name: "Apps".into(),
                    order: 7,
                },
                CustomGroup {
                    id: "b".into(),
                    name: "Jobs".into(),
                    order: 3,
                },
            ],
            assigned: [
                ("x".to_string(), "a".to_string()),
                ("y".to_string(), "zz".to_string()),
            ]
            .into(),
        };
        c.normalize();
        assert_eq!(c.groups.iter().map(|g| g.order).collect::<Vec<_>>(), [0, 1]);
        assert_eq!(c.assigned.len(), 1, "dangling assignment dropped");
        assert_eq!(c.members("a"), 1);
        assert!(c.name_taken("apps", None) && !c.name_taken("apps", Some("a")));
        assert_eq!(clean_group_name("  Edge  ").unwrap(), "Edge");
        assert!(clean_group_name(" ").is_err());
        assert!(clean_group_name(&"x".repeat(49)).is_err());
        assert!(clean_group_name(&"é".repeat(48)).is_ok());
        assert!(clean_group_name("a\nb").is_err());
    }
}
