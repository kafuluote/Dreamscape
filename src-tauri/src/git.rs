use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

const SNAPSHOT: &str = "insomnia-local.json";

async fn git(directory: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(directory)
        .args(["-c", "protocol.ext.allow=never"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "Git exceeded 60 seconds")?
        .map_err(|e| format!("Git is required: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub async fn operate(
    directory: &str,
    action: &str,
    message: &str,
    snapshot: Option<Value>,
) -> Result<Value, String> {
    let path = std::fs::canonicalize(directory)
        .map_err(|e| format!("Select an existing Git directory: {e}"))?;
    if !path.is_dir() {
        return Err("Git path is not a directory".into());
    }
    match action {
        "init" => {
            git(&path, &["init"]).await?;
        }
        "status" => (),
        "commit" => {
            if message.trim().is_empty() {
                return Err("Enter a commit message".into());
            }
            let snapshot = snapshot.ok_or("No workspace to commit")?;
            atomic_write(
                &path.join(SNAPSHOT),
                &serde_json::to_vec_pretty(&snapshot).map_err(|e| e.to_string())?,
            )?;
            git(&path, &["add", "--", SNAPSHOT]).await?;
            // --only prevents committing unrelated files the user has already staged.
            git(&path, &["commit", "--only", "-m", message, "--", SNAPSHOT]).await?;
        }
        "pull" => {
            if !git(&path, &["status", "--porcelain"])
                .await?
                .trim()
                .is_empty()
            {
                return Err("Commit or move local Git changes before pulling".into());
            }
            git(&path, &["pull", "--ff-only"]).await?;
        }
        "push" => {
            git(&path, &["push"]).await?;
        }
        "read" => (),
        _ => return Err("Unsupported Git action".into()),
    }
    let status = git(&path, &["status", "--short", "--branch"]).await?;
    let mut output = json!({"status":status});
    if ["pull", "read"].contains(&action) {
        let file = path.join(SNAPSHOT);
        if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
            return Err("Git snapshot exceeds 64 MiB".into());
        }
        output["snapshot"] =
            serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
    }
    Ok(output)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid output path")?)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn snapshot_commit_never_includes_unrelated_staged_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let name = path.to_string_lossy();
        operate(&name, "init", "", None).await.unwrap();
        git(path, &["config", "user.name", "Local Test"])
            .await
            .unwrap();
        git(
            path,
            &["config", "user.email", "local-test@example.invalid"],
        )
        .await
        .unwrap();
        // Establish HEAD so --only has an existing tree to compare against.
        git(path, &["commit", "--allow-empty", "-m", "init"])
            .await
            .unwrap();
        std::fs::write(path.join("unrelated.txt"), "must remain staged").unwrap();
        git(path, &["add", "--", "unrelated.txt"]).await.unwrap();
        let snapshot = json!({"version":1,"collections":[],"requests":[],"folders":[],"environments":[],"unmigrated":[]});
        operate(&name, "commit", "API workspace", Some(snapshot.clone()))
            .await
            .unwrap();
        let committed = git(path, &["show", "--pretty=", "--name-only", "HEAD"])
            .await
            .unwrap();
        assert_eq!(committed.trim(), SNAPSHOT);
        assert!(git(path, &["status", "--porcelain"])
            .await
            .unwrap()
            .contains("A  unrelated.txt"));
        assert_eq!(
            operate(&name, "read", "", None).await.unwrap()["snapshot"],
            snapshot
        );
        assert!(operate(&name, "pull", "", None)
            .await
            .unwrap_err()
            .contains("local Git changes"));
    }
}
