mod git;
mod grpc;
mod http_client;
mod models;
mod plugins;
mod storage;
mod template;
mod websocket;

use base64::{engine::general_purpose::STANDARD, Engine};
use models::ApiRequest;
use reqwest::cookie::Jar;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};
use tokio_util::sync::CancellationToken;

struct AppState {
    database: storage::Database,
    operations: Mutex<HashMap<String, CancellationToken>>,
    cookies: Mutex<HashMap<String, Arc<Jar>>>,
    sockets: websocket::Connections,
    plugin_lock: tokio::sync::Mutex<()>,
}

#[tauri::command]
fn load_workspace(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(
        json!({"workspace":state.database.load("workspace")?,"preferences":state.database.load("preferences")?}),
    )
}

#[tauri::command]
fn save_workspace(state: State<'_, AppState>, workspace: Value) -> Result<(), String> {
    if workspace["version"] != 1
        || !workspace["collections"].is_array()
        || !workspace["requests"].is_array()
    {
        return Err("Invalid workspace schema; existing data has not been overwritten".into());
    }
    state.database.save("workspace", &workspace)
}

#[tauri::command]
fn save_preferences(state: State<'_, AppState>, preferences: Value) -> Result<(), String> {
    if !preferences.is_object() {
        return Err("Invalid preferences".into());
    }
    state.database.save("preferences", &preferences)
}

fn render_request(mut request: ApiRequest, environment: &Value) -> Result<ApiRequest, String> {
    request.url = template::render(&request.url, environment)?;
    for pair in request
        .headers
        .iter_mut()
        .chain(request.parameters.iter_mut())
        .chain(request.body.params.iter_mut())
        .filter(|p| !p.disabled)
    {
        pair.name = template::render(&pair.name, environment)?;
        pair.value = template::render(&pair.value, environment)?;
        pair.file_name = template::render(&pair.file_name, environment)?;
    }
    request.body.text = template::render(&request.body.text, environment)?;
    request.body.file_name = template::render(&request.body.file_name, environment)?;
    template::render_value(&mut request.authentication, environment)?;
    Ok(request)
}

#[tauri::command]
async fn execute_request(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    operation_id: String,
    request: ApiRequest,
    environment: Value,
) -> Result<Value, String> {
    let cancel = CancellationToken::new();
    {
        let mut operations = state.operations.lock().map_err(|e| e.to_string())?;
        if operations.contains_key(&operation_id) {
            return Err("Operation already running".into());
        }
        operations.insert(operation_id.clone(), cancel.clone());
    }
    let duration = Duration::from_millis(request.settings.timeout_ms.clamp(100, 600_000));
    let work = async {
        let preferences = state.database.load("preferences")?.unwrap_or(json!({}));
        let enabled: Vec<String> = preferences["plugins"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["enabled"] == true)
            .filter_map(|p| p["path"].as_str().map(String::from))
            .collect();
        let scripts = preferences["scriptsEnabled"] == true;
        // Serialize plugin store read/modify/write, while ordinary HTTP requests remain concurrent.
        let _plugin_guard = if scripts || !enabled.is_empty() {
            Some(state.plugin_lock.lock().await)
        } else {
            None
        };
        let mut request = request;
        if !scripts
            && (!request.pre_request_script.trim().is_empty()
                || !request.after_response_script.trim().is_empty())
        {
            return Err(
                "This request has scripts. Enable trusted scripts in Settings before running it."
                    .into(),
            );
        }
        let mut environment = environment;
        let mut logs: Vec<String> = vec![];
        let mut stores = state.database.load("pluginStores")?.unwrap_or(json!({}));
        let node = preferences["nodePath"].as_str().unwrap_or("");
        if scripts || !enabled.is_empty() {
            let result = plugins::run(json!({"phase":"request","request":request,"environment":environment,"plugins":enabled,"stores":stores,"scriptsEnabled":scripts}), node).await?;
            request =
                serde_json::from_value(result["request"].clone()).map_err(|e| e.to_string())?;
            environment = result["environment"].clone();
            stores = result["stores"].clone();
            logs.extend(
                result["logs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(String::from)),
            );
        }
        let rendered = render_request(request.clone(), &environment)?;
        let mut response = match rendered.protocol.as_str() {
            "http" | "graphql" => {
                let jar = state
                    .cookies
                    .lock()
                    .map_err(|e| e.to_string())?
                    .entry(rendered.collection_id.clone())
                    .or_default()
                    .clone();
                http_client::execute(&rendered, jar).await?
            }
            "grpc" => grpc::execute(&rendered, Some(&app), &operation_id).await?,
            _ => return Err("Use Connect for WebSocket requests".into()),
        };
        if scripts || !enabled.is_empty() {
            match plugins::run(json!({"phase":"response","request":rendered,"response":response,"environment":environment,"plugins":enabled,"stores":stores,"scriptsEnabled":scripts}), node).await {
                Ok(result) => {
                    response = serde_json::from_value(result["response"].clone()).map_err(|e|e.to_string())?;
                    environment = result["environment"].clone();
                    stores = result["stores"].clone();
                    logs.extend(result["logs"].as_array().into_iter().flatten().filter_map(|v|v.as_str().map(String::from)));
                }
                Err(error) => logs.push(error),
            }
            state.database.save("pluginStores", &stores)?;
        }
        response.logs = logs;
        if let Err(error) = state.database.record(&response) {
            response
                .logs
                .push(format!("History was not saved: {error}"));
        }
        Ok(json!({"response":response,"environment":environment}))
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("Request cancelled".into()),
        result = tokio::time::timeout(duration, work) => result.unwrap_or_else(|_|Err(format!("Request timed out after {} ms", duration.as_millis()))),
    };
    state
        .operations
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&operation_id);
    result
}

#[tauri::command]
fn cancel_request(state: State<'_, AppState>, operation_id: String) -> Result<(), String> {
    if let Some(cancel) = state
        .operations
        .lock()
        .map_err(|e| e.to_string())?
        .get(&operation_id)
    {
        cancel.cancel();
    }
    Ok(())
}

#[tauri::command]
async fn websocket_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    request: ApiRequest,
    environment: Value,
) -> Result<(), String> {
    let request = render_request(request, &environment)?;
    tokio::time::timeout(
        Duration::from_millis(request.settings.timeout_ms.clamp(100, 600_000)),
        websocket::connect(app, state.sockets.clone(), connection_id, request),
    )
    .await
    .map_err(|_| "WebSocket connection timed out")?
}

#[tauri::command]
async fn websocket_send(
    state: State<'_, AppState>,
    connection_id: String,
    data: String,
    close: bool,
) -> Result<(), String> {
    websocket::send(&state.sockets, &connection_id, data, close).await
}

#[tauri::command]
async fn grpc_methods(request: ApiRequest, environment: Value) -> Result<Vec<Value>, String> {
    let request = render_request(request, &environment)?;
    tokio::time::timeout(Duration::from_secs(30), grpc::list_methods(&request))
        .await
        .map_err(|_| "gRPC discovery timed out")?
}

#[tauri::command]
fn request_history(state: State<'_, AppState>, request_id: String) -> Result<Vec<Value>, String> {
    state.database.history(&request_id)
}

#[tauri::command]
fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    state.database.clear_history()
}

#[tauri::command]
fn clear_cookies(state: State<'_, AppState>) -> Result<(), String> {
    state.cookies.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

#[tauri::command]
async fn import_file() -> Result<Option<Value>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("API collections", &["json", "yaml", "yml", "har"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    if std::fs::metadata(file.path())
        .map_err(|e| e.to_string())?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("Import exceeds 64 MiB".into());
    }
    let contents = tokio::fs::read_to_string(file.path())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(json!({"name":file.file_name(),"contents":contents})))
}

#[tauri::command]
async fn export_file(
    name: String,
    contents: String,
    binary: bool,
) -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(name)
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let bytes = if binary {
        STANDARD.decode(contents).map_err(|e| e.to_string())?
    } else {
        contents.into_bytes()
    };
    git::atomic_write(file.path(), &bytes)?;
    Ok(Some(file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn choose_path(kind: String) -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new();
    let selected = match kind.as_str() {
        "folder" => dialog.pick_folder().await,
        "proto" => {
            dialog
                .add_filter("Protocol buffers", &["proto"])
                .pick_file()
                .await
        }
        _ => dialog.pick_file().await,
    };
    Ok(selected.map(|f| f.path().to_string_lossy().into_owned()))
}

#[tauri::command]
fn inspect_plugin(directory: String) -> Result<Value, String> {
    plugins::inspect(std::path::Path::new(&directory))
}

#[tauri::command]
async fn git_operation(
    directory: String,
    action: String,
    message: String,
    snapshot: Option<Value>,
) -> Result<Value, String> {
    git::operate(&directory, &action, &message, snapshot).await
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(
        json!({"version":env!("CARGO_PKG_VERSION"),"dataDirectory":app.path().app_data_dir().map_err(|e|e.to_string())?.to_string_lossy(),"engine":"Rust · Tauri 2 · SQLite"}),
    )
}

#[tauri::command]
async fn oauth_token(request: ApiRequest, environment: Value) -> Result<Value, String> {
    let request = render_request(request, &environment)?;
    let auth = &request.authentication;
    let grant = models::text_field(auth, "grantType");
    if !["client_credentials", "password", "refresh_token"].contains(&grant) {
        return Err("Supported grants: client_credentials, password, refresh_token. Paste tokens for browser authorization flows.".into());
    }
    let mut token_request = ApiRequest {
        url: models::text_field(auth, "accessTokenUrl").into(),
        method: "POST".into(),
        settings: request.settings.clone(),
        ..Default::default()
    };
    token_request.body.mime_type = "application/x-www-form-urlencoded".into();
    token_request.body.params.push(models::Pair {
        name: "grant_type".into(),
        value: grant.into(),
        ..Default::default()
    });
    for (key, name) in [
        ("clientId", "client_id"),
        ("clientSecret", "client_secret"),
        ("scope", "scope"),
        ("username", "username"),
        ("password", "password"),
        ("refreshToken", "refresh_token"),
    ] {
        let value = models::text_field(auth, key);
        if !value.is_empty() {
            token_request.body.params.push(models::Pair {
                name: name.into(),
                value: value.into(),
                ..Default::default()
            });
        }
    }
    let response = http_client::execute(&token_request, Arc::new(Jar::default())).await?;
    if response.status >= 400 {
        return Err(format!(
            "Token endpoint {}: {}",
            response.status, response.body
        ));
    }
    serde_json::from_str(&response.body).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let database = storage::Database::open(&directory.join("workspace.sqlite"))
                .map_err(std::io::Error::other)?;
            app.manage(AppState {
                database,
                operations: Mutex::new(HashMap::new()),
                cookies: Mutex::new(HashMap::new()),
                sockets: Default::default(),
                plugin_lock: tokio::sync::Mutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            save_preferences,
            execute_request,
            cancel_request,
            websocket_connect,
            websocket_send,
            grpc_methods,
            request_history,
            clear_history,
            clear_cookies,
            import_file,
            export_file,
            choose_path,
            inspect_plugin,
            git_operation,
            app_info,
            oauth_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running Insomnia Local");
}
