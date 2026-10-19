use crate::models::{text_field, ApiRequest, Pair, ResponseData};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use reqwest::{
    cookie::{CookieStore, Jar},
    header, redirect, Client,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub fn request_url(request: &ApiRequest) -> Result<url::Url, String> {
    let mut url = url::Url::parse(&request.url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !["http", "https", "ws", "wss"].contains(&url.scheme()) {
        return Err("Only HTTP(S) and WS(S) URLs are supported".into());
    }
    for pair in &request.parameters {
        if !pair.disabled && !pair.name.is_empty() {
            url.query_pairs_mut().append_pair(&pair.name, &pair.value);
        }
    }
    let auth = &request.authentication;
    if auth.get("disabled").and_then(|v| v.as_bool()) != Some(true)
        && text_field(auth, "type") == "apikey"
        && text_field(auth, "addTo") == "query"
    {
        url.query_pairs_mut()
            .append_pair(text_field(auth, "key"), text_field(auth, "value"));
    }
    Ok(url)
}

pub fn request_headers(request: &ApiRequest) -> Result<header::HeaderMap, String> {
    let mut headers = header::HeaderMap::new();
    for pair in request
        .headers
        .iter()
        .filter(|p| !p.disabled && !p.name.is_empty())
    {
        headers.append(
            header::HeaderName::from_bytes(pair.name.as_bytes())
                .map_err(|e| format!("Invalid header {}: {e}", pair.name))?,
            header::HeaderValue::from_str(&pair.value)
                .map_err(|e| format!("Invalid header {}: {e}", pair.name))?,
        );
    }
    let auth = &request.authentication;
    if auth.get("disabled").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(headers);
    }
    let authorization = match text_field(auth, "type") {
        "basic" => Some(format!(
            "Basic {}",
            STANDARD.encode(format!(
                "{}:{}",
                text_field(auth, "username"),
                text_field(auth, "password")
            ))
        )),
        "bearer" => Some(format!(
            "{} {}",
            if text_field(auth, "prefix").is_empty() {
                "Bearer"
            } else {
                text_field(auth, "prefix")
            },
            text_field(auth, "token")
        )),
        "oauth2" if !text_field(auth, "accessToken").is_empty() => {
            Some(format!("Bearer {}", text_field(auth, "accessToken")))
        }
        "apikey" if text_field(auth, "addTo") != "query" => {
            headers.insert(
                header::HeaderName::from_bytes(text_field(auth, "key").as_bytes())
                    .map_err(|e| e.to_string())?,
                header::HeaderValue::from_str(text_field(auth, "value"))
                    .map_err(|e| e.to_string())?,
            );
            None
        }
        "" | "none" | "apikey" => None,
        kind => {
            return Err(format!(
            "Authentication type '{kind}' requires an explicit token/header or a request plugin"
        ))
        }
    };
    if let Some(auth) = authorization {
        headers.insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_str(&auth).map_err(|e| e.to_string())?,
        );
    }
    Ok(headers)
}

pub async fn execute(request: &ApiRequest, jar: Arc<Jar>) -> Result<ResponseData, String> {
    let started = Instant::now();
    let url = request_url(request)?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err("Select the WebSocket protocol for WS(S) requests".into());
    }
    let settings = &request.settings;
    let mut client = Client::builder()
        .timeout(Duration::from_millis(
            settings.timeout_ms.clamp(100, 600_000),
        ))
        .connect_timeout(Duration::from_secs(20))
        .danger_accept_invalid_certs(!settings.validate_certificates)
        .user_agent("InsomniaLocal/0.1")
        .redirect(if settings.follow_redirects {
            redirect::Policy::limited(10)
        } else {
            redirect::Policy::none()
        });
    // A shared cookie provider handles cookies across redirects when both operations are enabled.
    if settings.send_cookies && settings.store_cookies {
        client = client.cookie_provider(jar.clone());
    }
    if !settings.proxy.trim().is_empty() {
        client = client.proxy(reqwest::Proxy::all(&settings.proxy).map_err(|e| e.to_string())?);
    }
    let client = client.build().map_err(|e| e.to_string())?;
    let method =
        reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut headers = request_headers(request)?;
    if settings.send_cookies && !settings.store_cookies && !headers.contains_key(header::COOKIE) {
        if let Some(cookies) = jar.cookies(&url) {
            headers.insert(header::COOKIE, cookies);
        }
    }
    // The encoder owns the multipart boundary, including for imported requests.
    if request.body.mime_type == "multipart/form-data" {
        headers.remove(header::CONTENT_TYPE);
    }
    let has_content_type = headers.contains_key(header::CONTENT_TYPE);
    let mut builder = client.request(method, url.clone()).headers(headers);
    let body = &request.body;
    match body.mime_type.as_str() {
        "application/x-www-form-urlencoded" => {
            let fields: Vec<_> = body
                .params
                .iter()
                .filter(|p| !p.disabled && !p.name.is_empty())
                .map(|p| (&p.name, &p.value))
                .collect();
            builder = builder.form(&fields);
        }
        "multipart/form-data" => {
            let mut form = reqwest::multipart::Form::new();
            for pair in body
                .params
                .iter()
                .filter(|p| !p.disabled && !p.name.is_empty())
            {
                if pair.kind == "file" {
                    let bytes = tokio::fs::read(&pair.file_name)
                        .await
                        .map_err(|e| format!("Cannot read upload {}: {e}", pair.file_name))?;
                    let filename = std::path::Path::new(&pair.file_name)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    form = form.part(
                        pair.name.clone(),
                        reqwest::multipart::Part::bytes(bytes).file_name(filename),
                    );
                } else {
                    form = form.text(pair.name.clone(), pair.value.clone());
                }
            }
            builder = builder.multipart(form);
        }
        "application/octet-stream" if !body.file_name.is_empty() => {
            builder = builder.body(
                tokio::fs::read(&body.file_name)
                    .await
                    .map_err(|e| format!("Cannot read request body: {e}"))?,
            );
            if !has_content_type {
                builder = builder.header(header::CONTENT_TYPE, &body.mime_type);
            }
        }
        mime => {
            if !body.text.is_empty() {
                builder = builder.body(body.text.clone());
            }
            if !mime.is_empty() && !has_content_type {
                builder = builder.header(
                    header::CONTENT_TYPE,
                    if mime == "application/graphql" {
                        "application/json"
                    } else {
                        mime
                    },
                );
            }
        }
    }
    let response = builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status();
    let response_url = response.url().to_string();
    if settings.store_cookies && !settings.send_cookies {
        for cookie in response.headers().get_all(header::SET_COOKIE) {
            if let Ok(cookie) = cookie.to_str() {
                jar.add_cookie_str(cookie, response.url());
            }
        }
    }
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| Pair {
            name: name.to_string(),
            value: value.to_str().unwrap_or("[binary]").into(),
            ..Default::default()
        })
        .collect();
    let limit = settings.max_response_mb.clamp(1, 100) * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Response read failed: {e}"))?;
        let remaining = limit.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ResponseData {
        id: uuid::Uuid::new_v4().to_string(),
        request_id: request.id.clone(),
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        url: response_url,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        body_base64: STANDARD.encode(&bytes),
        elapsed_ms: started.elapsed().as_millis() as u64,
        size: bytes.len(),
        timestamp: crate::models::now(),
        truncated,
        protocol: "http".into(),
        logs: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[tokio::test]
    async fn sends_post_query_auth_and_body_and_keeps_error_responses() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        let received = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 11\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
            request
        });
        let mut request = ApiRequest {
            url: format!("http://{addr}/echo?old=1"),
            method: "POST".into(),
            authentication: json!({"type":"bearer","token":"test-secret"}),
            ..Default::default()
        };
        request.parameters.push(Pair {
            name: "q".into(),
            value: "a b".into(),
            ..Default::default()
        });
        request.body.text = "{\"hello\":1}".into();
        request.body.mime_type = "application/json".into();
        let response = execute(&request, Arc::new(Jar::default())).await.unwrap();
        assert_eq!(response.status, 422);
        assert_eq!(response.body, "{\"ok\":true}");
        let received = received.await.unwrap();
        assert!(received.contains("POST /echo?old=1&q=a+b"));
        assert!(received.contains("authorization: Bearer test-secret"));
        assert!(received.contains("{\"hello\":1}"));
    }

    #[test]
    fn blocks_unsupported_schemes_and_unknown_auth_instead_of_silently_ignoring() {
        let mut request = ApiRequest {
            url: "file:///etc/passwd".into(),
            ..Default::default()
        };
        assert!(request_url(&request).is_err());
        request.authentication = json!({"type":"ntlm"});
        assert!(request_headers(&request).is_err());
    }

    #[tokio::test]
    async fn multipart_encoder_sets_boundary_and_sends_real_file_contents() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let received = read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            received
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "uploaded contents").unwrap();
        let mut request = ApiRequest {
            url: format!("http://{address}"),
            method: "POST".into(),
            ..Default::default()
        };
        request.headers.push(Pair {
            name: "Content-Type".into(),
            value: "multipart/form-data".into(),
            ..Default::default()
        });
        request.body.mime_type = "multipart/form-data".into();
        request.body.params.push(Pair {
            name: "file".into(),
            kind: "file".into(),
            file_name: path.to_string_lossy().into_owned(),
            ..Default::default()
        });
        execute(&request, Arc::new(Jar::default())).await.unwrap();
        let received = server.await.unwrap();
        assert!(received.contains("multipart/form-data; boundary="));
        assert!(received.contains("uploaded contents"));
        assert!(received.contains("filename=\"test.txt\""));
    }

    #[tokio::test]
    async fn persists_session_cookies_and_honors_send_switch() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_request(&mut socket).await);
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nSet-Cookie: session=abc; Path=/\r\nConnection: close\r\n\r\n").await.unwrap();
            }
            requests
        });
        let mut request = ApiRequest {
            url: format!("http://{address}/cookies"),
            ..Default::default()
        };
        let jar = Arc::new(Jar::default());
        execute(&request, jar.clone()).await.unwrap();
        execute(&request, jar.clone()).await.unwrap();
        request.settings.send_cookies = false;
        execute(&request, jar).await.unwrap();
        let requests = server.await.unwrap();
        assert!(requests[1].to_lowercase().contains("cookie: session=abc"));
        assert!(!requests[2].to_lowercase().contains("cookie:"));
    }

    #[tokio::test]
    async fn truncates_large_responses_and_keeps_exact_binary_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 1048609\r\nConnection: close\r\n\r\n",
                )
                .await;
            let _ = socket.write_all(&vec![255u8; 1048609]).await;
        });
        let mut request = ApiRequest {
            url: format!("http://{address}"),
            ..Default::default()
        };
        request.settings.max_response_mb = 1;
        let response = execute(&request, Arc::new(Jar::default())).await.unwrap();
        assert!(response.truncated);
        assert_eq!(response.size, 1048576);
        assert_eq!(
            STANDARD.decode(response.body_base64).unwrap(),
            vec![255u8; 1048576]
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn request_timeout_is_enforced() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let mut request = ApiRequest {
            url: format!("http://{address}"),
            ..Default::default()
        };
        request.settings.timeout_ms = 100;
        assert!(execute(&request, Arc::new(Jar::default())).await.is_err());
        server.abort();
    }
}
