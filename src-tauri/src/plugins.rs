use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

pub async fn run(input: Value, executable: &str) -> Result<Value, String> {
    let mut command = Command::new(if executable.is_empty() {
        "node"
    } else {
        executable
    });
    command
        .args(["-e", include_str!("../../scripts/plugin-runner.cjs")])
        .env("INSOMNIA_PLUGIN_WORKER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Node.js is required for plugins/scripts: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Missing plugin worker input")?;
    let data = serde_json::to_vec(&input).map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = stdin.write_all(&data).await;
    });
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| "Plugin/script exceeded the 15 second limit")?
        .map_err(|e| e.to_string())?;
    if output.stdout.len() > 64 * 1024 * 1024 {
        return Err("Plugin output exceeds 64 MiB".into());
    }
    let output: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid plugin output: {e}"))?;
    if output["ok"] != true {
        return Err(format!(
            "Plugin/script: {}",
            output["error"].as_str().unwrap_or("Unknown error")
        ));
    }
    Ok(output["result"].clone())
}

pub fn inspect(directory: &Path) -> Result<Value, String> {
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(directory.join("package.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(
        json!({"path":directory.to_string_lossy(),"name":manifest["name"],"version":manifest["version"],"description":manifest["description"],"enabled":false}),
    )
}
