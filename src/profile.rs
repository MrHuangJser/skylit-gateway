//! Read-only normal SDK resource projection. No credentials, logging or Debug output.
use serde_json::{Map, Value};
use std::{path::Path, time::{SystemTime, UNIX_EPOCH}};
use tokio::io::AsyncReadExt;

const MAX_PROFILE_BYTES: usize = 64 * 1024;
pub(crate) struct Unavailable;
pub(crate) struct BrowserProfile {
    pub(crate) user: Value,
    pub(crate) session: Value,
    pub(crate) organization: Value,
}

fn fields(value: &Value, strings: &[&str], nullable: &[&str]) -> Result<Map<String, Value>, Unavailable> {
    let object = value.as_object().ok_or(Unavailable)?;
    let mut result = Map::new();
    for &key in strings {
        let value = object.get(key).filter(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())).ok_or(Unavailable)?;
        result.insert(key.into(), value.clone());
    }
    for &key in nullable {
        let value = object.get(key).filter(|v| v.is_null() || v.is_string()).ok_or(Unavailable)?;
        result.insert(key.into(), value.clone());
    }
    Ok(result)
}
fn metadata(source: &Value, output: &mut Map<String, Value>) -> Result<(), Unavailable> {
    let value = source.get("publicMetadata").filter(|v| v.is_object()).ok_or(Unavailable)?;
    output.insert("publicMetadata".into(), value.clone());
    Ok(())
}
fn organization(value: &Value) -> Result<Value, Unavailable> {
    let mut output = fields(value, &["id", "name"], &["slug", "imageUrl"])?;
    metadata(value, &mut output)?;
    Ok(Value::Object(output))
}
impl BrowserProfile {
    pub(crate) async fn load(session_file: &Path, verified_user_id: &str) -> Result<Self, Unavailable> {
        let file = tokio::fs::File::open(session_file.with_file_name("browser-profile.json")).await.map_err(|_| Unavailable)?;
        let mut bytes = Vec::new();
        file.take((MAX_PROFILE_BYTES + 1) as u64).read_to_end(&mut bytes).await.map_err(|_| Unavailable)?;
        if bytes.len() > MAX_PROFILE_BYTES { return Err(Unavailable); }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| Unavailable)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| Unavailable)?.as_secs();
        let captured = value.get("capturedAt").and_then(Value::as_u64).ok_or(Unavailable)?;
        if value.get("source").and_then(Value::as_str) != Some("normal-clerk-session")
            || captured.saturating_sub(now) > 30 || now.saturating_sub(captured) > 120 {
            return Err(Unavailable);
        }
        let user = value.get("user").ok_or(Unavailable)?;
        let mut user_out = fields(user, &["id"], &["firstName", "lastName", "fullName", "username", "imageUrl", "createdAt", "updatedAt", "primaryEmailAddressId"])?;
        if user.get("id").and_then(Value::as_str) != Some(verified_user_id) { return Err(Unavailable); }
        metadata(user, &mut user_out)?;
        let memberships = user.get("organizationMemberships").and_then(Value::as_array).ok_or(Unavailable)?;
        let memberships = memberships.iter().map(|membership| {
            let mut output = fields(membership, &["id", "role"], &[])?;
            output.insert("organization".into(), organization(membership.get("organization").ok_or(Unavailable)?)?);
            Ok(Value::Object(output))
        }).collect::<Result<Vec<_>, Unavailable>>()?;
        user_out.insert("organizationMemberships".into(), Value::Array(memberships));
        let emails = user.get("emailAddresses").and_then(Value::as_array).ok_or(Unavailable)?;
        let emails = emails.iter().map(|email| fields(email, &["id", "emailAddress"], &[]).map(Value::Object)).collect::<Result<Vec<_>, _>>()?;
        user_out.insert("emailAddresses".into(), Value::Array(emails));
        let session = value.get("session").ok_or(Unavailable)?;
        let mut session_out = fields(session, &["id", "status"], &["expireAt", "lastActiveAt"])?;
        if session.get("status").and_then(Value::as_str) != Some("active") { return Err(Unavailable); }
        let actor = session.get("actor").ok_or(Unavailable)?;
        let actor = if actor.is_null() { Value::Null } else {
            let object = actor.as_object().ok_or(Unavailable)?;
            let mut output = Map::new();
            for key in ["sub", "iss", "sid"] {
                if let Some(value) = object.get(key) {
                    if !value.is_null() && !value.is_string() { return Err(Unavailable); }
                    output.insert(key.into(), value.clone());
                }
            }
            Value::Object(output)
        };
        session_out.insert("actor".into(), actor);
        let org = value.get("organization").ok_or(Unavailable)?;
        Ok(Self { user: Value::Object(user_out), session: Value::Object(session_out), organization: if org.is_null() { Value::Null } else { organization(org)? } })
    }
}
