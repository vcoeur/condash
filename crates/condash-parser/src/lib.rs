//! Rust port of condash's markdown parser (`src/condash/parser.py`).
//!
//! Phase 1 scope: the pure string-level primitives. The filesystem-walking
//! entry points (collect_items, collect_knowledge, _list_item_tree) and
//! the top-level `parse_readme` wrapper that reads a file off disk land in
//! later phases alongside the route port, so this crate stays pure and
//! easy to unit-test against the Python output.

pub mod deliverables;
pub mod readme;
pub mod regexes;
pub mod sections;

pub use deliverables::{parse_deliverables, Deliverable};
pub use readme::{parse_readme_content, ItemReadme};
pub use sections::{parse_sections, CheckboxStatus, Section, SectionItem};

/// Ordered priority / status enum. The order of variants mirrors Python's
/// `PRIORITIES` tuple — call sites that sort by `as usize` get the same
/// total order the Python dashboard uses.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Now,
    Soon,
    Later,
    Backlog,
    Review,
    Done,
}

impl Priority {
    pub const ALL: [Priority; 6] = [
        Priority::Now,
        Priority::Soon,
        Priority::Later,
        Priority::Backlog,
        Priority::Review,
        Priority::Done,
    ];

    /// Match Python's lowercase string parsing; returns `None` for unknown
    /// values (parse_readme coerces those to `Backlog` and records the raw
    /// input in `invalid_status`).
    pub fn from_lowercase(value: &str) -> Option<Priority> {
        match value {
            "now" => Some(Priority::Now),
            "soon" => Some(Priority::Soon),
            "later" => Some(Priority::Later),
            "backlog" => Some(Priority::Backlog),
            "review" => Some(Priority::Review),
            "done" => Some(Priority::Done),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Priority::Now => "now",
            Priority::Soon => "soon",
            Priority::Later => "later",
            Priority::Backlog => "backlog",
            Priority::Review => "review",
            Priority::Done => "done",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Project,
    Incident,
    Document,
}

impl Kind {
    pub fn from_lowercase(value: &str) -> Option<Kind> {
        match value {
            "project" => Some(Kind::Project),
            "incident" => Some(Kind::Incident),
            "document" => Some(Kind::Document),
            _ => None,
        }
    }
}
