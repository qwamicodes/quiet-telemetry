//! TypeScript bindings for the wire types, generated with ts-rs into
//! `web/src/gen/`. This test fails when they are stale.
//!
//! Regenerate: `QUIET_UPDATE_TS=1 cargo test bindings` (or `bun run gen:types` in web/).

use crate::accounts::{Invite, Member, Role, SessionInfo, User};
use crate::api::{About, Frame, GroupingPreview, Health, LinesResponse, SourcesResponse};
use crate::auth_api::{
    AcceptInvite, AuthState, ChangePassword, CompleteReset, CreateInvite, CreatedInvite,
    InviteProblem, LoginRequest, MembersResponse, PasswordChanged, ResetInfo, ResetLink,
    SessionsResponse, SetupRequest, SignedIn, SignedOutOthers, TokenRequest, UpdateMember,
    UpdateProfile,
};
use crate::flow_api::{
    FlowNotFound, FlowParams, FlowResponse, FlowSummariesRequest, FlowSummariesResponse,
};
use crate::search_api::{
    ExportParams, ExportTokenRequest, ExportTokenResponse, SearchParams, SearchResponse,
};
use crate::settings::{
    FlowIdSettings, GeneralSettings, SettingsResponse, SourceSettings, UpdateStorage,
};
use crate::settings_api::{PurgeRequest, Purged, SourceActivity, StorageReport};
use crate::stream_api::{IdCoverageReport, SourceFields, StreamStats};
use crate::system::SystemStatus;
use crate::tokens::{CreateIngestToken, CreatedIngestToken, IngestToken, IngestTokensResponse};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use ts_rs::{Config, TS};

fn out_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/src/gen")
}

fn export_into(dir: &Path) {
    let cfg = Config::new().with_out_dir(dir).with_large_int("number");
    // Roots; their dependencies (LogLine, CorrId, Level, SourceInfo, …) follow.
    Frame::export_all(&cfg).unwrap();
    StreamStats::export_all(&cfg).unwrap();
    SourceFields::export_all(&cfg).unwrap();
    IdCoverageReport::export_all(&cfg).unwrap();
    crate::lint::LintReport::export_all(&cfg).unwrap();
    Health::export_all(&cfg).unwrap();
    About::export_all(&cfg).unwrap();
    GroupingPreview::export_all(&cfg).unwrap();
    crate::settings::UpdateGrouping::export_all(&cfg).unwrap();
    SourcesResponse::export_all(&cfg).unwrap();
    LinesResponse::export_all(&cfg).unwrap();
    SearchParams::export_all(&cfg).unwrap();
    SearchResponse::export_all(&cfg).unwrap();
    ExportParams::export_all(&cfg).unwrap();
    ExportTokenRequest::export_all(&cfg).unwrap();
    ExportTokenResponse::export_all(&cfg).unwrap();
    crate::export_jobs::ExportJobRequest::export_all(&cfg).unwrap();
    crate::export_jobs::ExportJob::export_all(&cfg).unwrap();
    FlowParams::export_all(&cfg).unwrap();
    FlowResponse::export_all(&cfg).unwrap();
    FlowNotFound::export_all(&cfg).unwrap();
    FlowSummariesRequest::export_all(&cfg).unwrap();
    FlowSummariesResponse::export_all(&cfg).unwrap();
    IngestToken::export_all(&cfg).unwrap();
    IngestTokensResponse::export_all(&cfg).unwrap();
    CreateIngestToken::export_all(&cfg).unwrap();
    CreatedIngestToken::export_all(&cfg).unwrap();
    // Accounts.
    Role::export_all(&cfg).unwrap();
    User::export_all(&cfg).unwrap();
    Member::export_all(&cfg).unwrap();
    Invite::export_all(&cfg).unwrap();
    SessionInfo::export_all(&cfg).unwrap();
    AuthState::export_all(&cfg).unwrap();
    SetupRequest::export_all(&cfg).unwrap();
    LoginRequest::export_all(&cfg).unwrap();
    SignedIn::export_all(&cfg).unwrap();
    TokenRequest::export_all(&cfg).unwrap();
    InviteProblem::export_all(&cfg).unwrap();
    AcceptInvite::export_all(&cfg).unwrap();
    ResetInfo::export_all(&cfg).unwrap();
    CompleteReset::export_all(&cfg).unwrap();
    UpdateProfile::export_all(&cfg).unwrap();
    ChangePassword::export_all(&cfg).unwrap();
    PasswordChanged::export_all(&cfg).unwrap();
    SessionsResponse::export_all(&cfg).unwrap();
    SignedOutOthers::export_all(&cfg).unwrap();
    MembersResponse::export_all(&cfg).unwrap();
    UpdateMember::export_all(&cfg).unwrap();
    CreateInvite::export_all(&cfg).unwrap();
    CreatedInvite::export_all(&cfg).unwrap();
    ResetLink::export_all(&cfg).unwrap();
    // Settings, storage, system.
    SettingsResponse::export_all(&cfg).unwrap();
    GeneralSettings::export_all(&cfg).unwrap();
    UpdateStorage::export_all(&cfg).unwrap();
    FlowIdSettings::export_all(&cfg).unwrap();
    SourceSettings::export_all(&cfg).unwrap();
    StorageReport::export_all(&cfg).unwrap();
    PurgeRequest::export_all(&cfg).unwrap();
    Purged::export_all(&cfg).unwrap();
    SourceActivity::export_all(&cfg).unwrap();
    SystemStatus::export_all(&cfg).unwrap();
    crate::normalize::BuiltinIdKey::export_all(&cfg).unwrap();

    // A barrel so the UI imports from one place.
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".ts") && n != "index.ts")
        .map(|n| n.trim_end_matches(".ts").to_string())
        .collect();
    names.sort();
    let mut index = String::from("// Generated by server/src/bindings.rs. Do not edit.\n");
    for n in names {
        index.push_str(&format!("export type {{ {n} }} from './{n}'\n"));
    }
    std::fs::write(dir.join("index.ts"), index).unwrap();
}

fn read_all(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().into_string().ok()?;
                name.ends_with(".ts")
                    .then(|| Some((name, std::fs::read_to_string(e.path()).ok()?)))?
            })
            .collect()
        })
        .unwrap_or_default()
}

#[test]
fn ts_bindings_are_fresh() {
    let fresh = std::env::temp_dir().join(format!("quiet-ts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&fresh);
    std::fs::create_dir_all(&fresh).unwrap();
    export_into(&fresh);
    let want = read_all(&fresh);
    let _ = std::fs::remove_dir_all(&fresh);

    if std::env::var("QUIET_UPDATE_TS").is_ok_and(|v| v == "1") {
        let dir = out_dir();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in &want {
            std::fs::write(dir.join(name), body).unwrap();
        }
        return;
    }
    let have = read_all(&out_dir());
    let stale: Vec<_> = want
        .keys()
        .chain(have.keys())
        .filter(|k| want.get(*k) != have.get(*k))
        .collect();
    assert!(
        stale.is_empty(),
        "web/src/gen is stale ({stale:?}). Run `QUIET_UPDATE_TS=1 cargo test bindings` in server/ \
         (or `bun run gen:types` in web/) and commit the result."
    );
}
