use crate::{http_client, models::ApiRequest};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};

#[derive(Clone, Default)]
pub struct Connections(pub Arc<Mutex<HashMap<String, mpsc::Sender<Message>>>>);

pub async fn connect(
    app: tauri::AppHandle,
    connections: Connections,
    connection_id: String,
    request: ApiRequest,
) -> Result<(), String> {
    let socket = open_socket(&request).await?;
    let (sender, mut outgoing) = mpsc::channel::<Message>(64);
    connections
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(connection_id.clone(), sender);
    let _ = app.emit(
        "socket-event",
        json!({"connectionId":connection_id,"kind":"open","timestamp":crate::models::now()}),
    );
    tauri::async_runtime::spawn(async move {
        let (mut sink, mut stream) = socket.split();
        loop {
            let result: Result<bool, String> = tokio::select! {
                message = outgoing.recv() => match message {
                    Some(message) => {
                        let closing = message.is_close();
                        sink.send(message).await.map(|_| closing).map_err(|e| e.to_string())
                    }
                    None => Ok(true),
                },
                message = stream.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        let _ = app.emit("socket-event", json!({"connectionId":connection_id,"kind":"message","data":text.as_str(),"timestamp":crate::models::now()}));
                        Ok(false)
                    },
                    Some(Ok(Message::Binary(bytes))) => {
                        let _ = app.emit("socket-event", json!({"connectionId":connection_id,"kind":"binary","data":STANDARD.encode(bytes),"timestamp":crate::models::now()}));
                        Ok(false)
                    },
                    Some(Ok(Message::Ping(bytes))) => sink.send(Message::Pong(bytes)).await.map(|_|false).map_err(|e|e.to_string()),
                    Some(Ok(Message::Close(_))) | None => Ok(true),
                    Some(Err(e)) => Err(e.to_string()),
                    _ => Ok(false),
                }
            };
            match result {
                Ok(false) => (),
                Ok(true) => break,
                Err(error) => {
                    let _ = app.emit("socket-event", json!({"connectionId":connection_id,"kind":"error","data":error,"timestamp":crate::models::now()}));
                    break;
                }
            }
        }
        if let Ok(mut items) = connections.0.lock() {
            items.remove(&connection_id);
        }
        let _ = app.emit(
            "socket-event",
            json!({"connectionId":connection_id,"kind":"close","timestamp":crate::models::now()}),
        );
    });
    Ok(())
}

async fn open_socket(
    request: &ApiRequest,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let url = http_client::request_url(request)?;
    if !["ws", "wss"].contains(&url.scheme()) {
        return Err("WebSocket URL must start with ws:// or wss://".into());
    }
    if !request.settings.validate_certificates {
        return Err("WebSocket requires a trusted TLS certificate".into());
    }
    if !request.settings.proxy.is_empty() {
        return Err("WebSocket proxy is not supported yet".into());
    }
    let mut handshake = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    for (name, value) in http_client::request_headers(request)?.iter() {
        handshake.headers_mut().insert(name, value.clone());
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(10 * 1024 * 1024))
        .max_frame_size(Some(10 * 1024 * 1024));
    let (socket, _) = connect_async_with_config(handshake, Some(config), false)
        .await
        .map_err(|e| format!("WebSocket handshake failed: {e}"))?;
    Ok(socket)
}

pub async fn send(
    connections: &Connections,
    id: &str,
    data: String,
    close: bool,
) -> Result<(), String> {
    let sender = connections
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("WebSocket is not connected")?;
    sender
        .send(if close {
            Message::Close(None)
        } else {
            Message::Text(data.into())
        })
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn real_websocket_handshake_and_text_echo() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut websocket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let message = websocket.next().await.unwrap().unwrap();
            websocket.send(message).await.unwrap();
        });
        let request = ApiRequest {
            url: format!("ws://{address}/echo"),
            protocol: "websocket".into(),
            ..Default::default()
        };
        let mut socket = open_socket(&request).await.unwrap();
        socket
            .send(Message::Text("hello from Rust".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "hello from Rust"
        );
        server.await.unwrap();
    }
}
