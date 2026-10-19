use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Pair {
    pub name: String,
    pub value: String,
    pub disabled: bool,
    #[serde(rename = "type")]
    pub kind: String,
    pub file_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Body {
    pub mime_type: String,
    pub text: String,
    pub params: Vec<Pair>,
    pub file_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestSettings {
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub validate_certificates: bool,
    pub send_cookies: bool,
    pub store_cookies: bool,
    pub proxy: String,
    pub max_response_mb: usize,
}

impl Default for RequestSettings {
    fn default() -> Self {
        Self {
            timeout_ms: 30_000,
            follow_redirects: true,
            validate_certificates: true,
            send_cookies: true,
            store_cookies: true,
            proxy: String::new(),
            max_response_mb: 10,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GrpcConfig {
    pub proto_file: String,
    pub include_dirs: Vec<String>,
    pub method: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiRequest {
    pub id: String,
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub method: String,
    pub url: String,
    pub parameters: Vec<Pair>,
    pub headers: Vec<Pair>,
    pub body: Body,
    pub authentication: Value,
    pub settings: RequestSettings,
    pub grpc: GrpcConfig,
    pub pre_request_script: String,
    pub after_response_script: String,
    pub description: String,
    pub source: Option<Value>,
}

impl Default for ApiRequest {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            collection_id: String::new(),
            folder_id: None,
            name: "New request".into(),
            protocol: "http".into(),
            method: "GET".into(),
            url: String::new(),
            parameters: vec![],
            headers: vec![],
            body: Body::default(),
            authentication: json!({"type":"none"}),
            settings: RequestSettings::default(),
            grpc: GrpcConfig::default(),
            pre_request_script: String::new(),
            after_response_script: String::new(),
            description: String::new(),
            source: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseData {
    pub id: String,
    pub request_id: String,
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: Vec<Pair>,
    pub body: String,
    pub body_base64: String,
    pub elapsed_ms: u64,
    pub size: usize,
    pub timestamp: u64,
    pub truncated: bool,
    pub protocol: String,
    pub logs: Vec<String>,
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn text_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
