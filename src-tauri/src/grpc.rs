use crate::models::{ApiRequest, Pair, ResponseData};
use base64::{engine::general_purpose::STANDARD, Engine};
use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::Emitter;
use tonic::{
    codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder},
    transport::{Channel, ClientTlsConfig, Endpoint},
    Request, Status,
};
use tonic_reflection::pb::v1::{
    server_reflection_request::MessageRequest, server_reflection_response::MessageResponse,
    ServerReflectionRequest, ServerReflectionResponse,
};

#[cfg(test)]
#[path = "grpc_tests.rs"]
mod tests;

struct DynamicCodec(MessageDescriptor);
struct DynamicEncoder;
struct DynamicDecoder(MessageDescriptor);

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;
    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }
    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder(self.0.clone())
    }
}

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn encode(&mut self, item: Self::Item, target: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(target)
            .map_err(|e| Status::internal(e.to_string()))
    }
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn decode(&mut self, source: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Status> {
        DynamicMessage::decode(self.0.clone(), source)
            .map(Some)
            .map_err(|e| Status::internal(e.to_string()))
    }
}

async fn channel(request: &ApiRequest) -> Result<Channel, String> {
    let url = if request.url.contains("://") {
        request.url.clone()
    } else {
        format!("http://{}", request.url)
    };
    if !request.settings.proxy.is_empty() {
        return Err("gRPC proxy is not supported yet".into());
    }
    if url.starts_with("https://") && !request.settings.validate_certificates {
        return Err("gRPC TLS requires a trusted certificate".into());
    }
    let mut endpoint = Endpoint::from_shared(url.clone())
        .map_err(|e| e.to_string())?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_millis(
            request.settings.timeout_ms.clamp(100, 600_000),
        ));
    if url.starts_with("https://") {
        endpoint = endpoint
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|e| e.to_string())?;
    }
    endpoint
        .connect()
        .await
        .map_err(|e| format!("gRPC connection failed: {e}"))
}

fn authenticated<T>(message: T, request: &ApiRequest) -> Result<Request<T>, String> {
    let mut result = Request::new(message);
    *result.metadata_mut() =
        tonic::metadata::MetadataMap::from_headers(crate::http_client::request_headers(request)?);
    result.set_timeout(Duration::from_millis(
        request.settings.timeout_ms.clamp(100, 600_000),
    ));
    Ok(result)
}

async fn reflect(
    channel: Channel,
    message: MessageRequest,
    request: &ApiRequest,
    alpha: bool,
) -> Result<MessageResponse, String> {
    let mut client = tonic::client::Grpc::new(channel);
    client.ready().await.map_err(|e| e.to_string())?;
    let stream = tokio_stream::iter([ServerReflectionRequest {
        host: String::new(),
        message_request: Some(message),
    }]);
    let path = http::uri::PathAndQuery::from_static(if alpha {
        "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo"
    } else {
        "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo"
    });
    let response = client
        .streaming(
            authenticated(stream, request)?,
            path,
            tonic_prost::ProstCodec::<ServerReflectionRequest, ServerReflectionResponse>::default(),
        )
        .await
        .map_err(|e| e.to_string())?;
    let response = response
        .into_inner()
        .message()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Empty reflection response")?;
    match response.message_response {
        Some(MessageResponse::ErrorResponse(error)) => Err(format!(
            "Reflection error {}: {}",
            error.error_code, error.error_message
        )),
        Some(value) => Ok(value),
        None => Err("Missing reflection response".into()),
    }
}

async fn descriptor_pool(request: &ApiRequest, channel: Channel) -> Result<DescriptorPool, String> {
    if !request.grpc.proto_file.is_empty() {
        let file = PathBuf::from(&request.grpc.proto_file);
        let mut includes = vec![file.parent().ok_or("Invalid .proto path")?.to_path_buf()];
        includes.extend(request.grpc.include_dirs.iter().map(PathBuf::from));
        let descriptors =
            protox::compile([file], includes).map_err(|e| format!("Protobuf compilation: {e}"))?;
        return DescriptorPool::from_file_descriptor_set(descriptors).map_err(|e| e.to_string());
    }
    let (services, alpha) = match reflect(
        channel.clone(),
        MessageRequest::ListServices(String::new()),
        request,
        false,
    )
    .await
    {
        Ok(value) => (value, false),
        Err(_) => (
            reflect(
                channel.clone(),
                MessageRequest::ListServices(String::new()),
                request,
                true,
            )
            .await?,
            true,
        ),
    };
    let services = match services {
        MessageResponse::ListServicesResponse(value) => value.service,
        _ => return Err("Reflection did not return services".into()),
    };
    let mut files = std::collections::BTreeMap::new();
    for service in services
        .iter()
        .filter(|s| !s.name.starts_with("grpc.reflection."))
    {
        let response = reflect(
            channel.clone(),
            MessageRequest::FileContainingSymbol(service.name.clone()),
            request,
            alpha,
        )
        .await?;
        if let MessageResponse::FileDescriptorResponse(value) = response {
            for bytes in value.file_descriptor_proto {
                let file = prost_types::FileDescriptorProto::decode(bytes.as_slice())
                    .map_err(|e| e.to_string())?;
                files.insert(file.name.clone().unwrap_or_default(), file);
            }
        }
    }
    // Some servers only return immediate dependencies. Fetch any remaining imports explicitly.
    for _ in 0..32 {
        let missing: Vec<String> = files
            .values()
            .flat_map(|f| f.dependency.iter())
            .filter(|d| !files.contains_key(*d))
            .cloned()
            .collect();
        if missing.is_empty() {
            break;
        }
        let before = files.len();
        for name in missing {
            if let MessageResponse::FileDescriptorResponse(value) = reflect(
                channel.clone(),
                MessageRequest::FileByFilename(name),
                request,
                alpha,
            )
            .await?
            {
                for bytes in value.file_descriptor_proto {
                    let file = prost_types::FileDescriptorProto::decode(bytes.as_slice())
                        .map_err(|e| e.to_string())?;
                    files.insert(file.name.clone().unwrap_or_default(), file);
                }
            }
        }
        if files.len() == before {
            return Err("Reflection server did not provide imported .proto files".into());
        }
    }
    DescriptorPool::from_file_descriptor_set(prost_types::FileDescriptorSet {
        file: files.into_values().collect(),
    })
    .map_err(|e| e.to_string())
}

pub async fn list_methods(request: &ApiRequest) -> Result<Vec<Value>, String> {
    // Local proto inspection works without a running server.
    let connection = if request.grpc.proto_file.is_empty() {
        channel(request).await?
    } else {
        Endpoint::from_static("http://127.0.0.1:1").connect_lazy()
    };
    let pool = descriptor_pool(request, connection).await?;
    Ok(pool.services().flat_map(|service| service.methods().map(|method|json!({"name":format!("{}/{}", service.full_name(), method.name()),"clientStreaming":method.is_client_streaming(),"serverStreaming":method.is_server_streaming(),"input":method.input().full_name(),"output":method.output().full_name()})).collect::<Vec<_>>()).collect())
}

pub async fn execute(
    request: &ApiRequest,
    app: Option<&tauri::AppHandle>,
    operation_id: &str,
) -> Result<ResponseData, String> {
    let started = Instant::now();
    let connection = channel(request).await?;
    let pool = descriptor_pool(request, connection.clone()).await?;
    let method_path = request.grpc.method.trim_start_matches('/');
    let (service, method_name) = method_path
        .rsplit_once('/')
        .ok_or("Select a gRPC method (package.Service/Method)")?;
    let service = pool
        .get_service_by_name(service)
        .ok_or("Service not found in descriptors")?;
    let method = service
        .methods()
        .find(|m| m.name() == method_name)
        .ok_or("Method not found in descriptors")?;
    let input: Value = serde_json::from_str(if request.body.text.trim().is_empty() {
        "{}"
    } else {
        &request.body.text
    })
    .map_err(|e| format!("Invalid gRPC JSON: {e}"))?;
    let values = if method.is_client_streaming() {
        input.as_array().cloned().unwrap_or_else(|| vec![input])
    } else {
        vec![input]
    };
    let messages: Result<Vec<_>, _> = values
        .iter()
        .map(|value| DynamicMessage::deserialize(method.input(), value).map_err(|e| e.to_string()))
        .collect();
    let mut client = tonic::client::Grpc::new(connection)
        .max_decoding_message_size(request.settings.max_response_mb.clamp(1, 100) * 1024 * 1024);
    client.ready().await.map_err(|e| e.to_string())?;
    let path = format!("/{method_path}")
        .parse::<http::uri::PathAndQuery>()
        .map_err(|e| e.to_string())?;
    let response = client
        .streaming(
            authenticated(tokio_stream::iter(messages?), request)?,
            path,
            DynamicCodec(method.output()),
        )
        .await
        .map_err(|e| format!("gRPC: {e}"))?;
    let mut headers: Vec<Pair> = response
        .metadata()
        .clone()
        .into_headers()
        .iter()
        .map(|(name, value)| Pair {
            name: name.to_string(),
            value: value.to_str().unwrap_or("[binary]").into(),
            ..Default::default()
        })
        .collect();
    let mut stream = response.into_inner();
    let mut values = Vec::new();
    let mut size = 0;
    let mut truncated = false;
    while let Some(message) = stream.message().await.map_err(|e| format!("gRPC: {e}"))? {
        let value = serde_json::to_value(message).map_err(|e| e.to_string())?;
        size += value.to_string().len();
        if size > request.settings.max_response_mb.clamp(1, 100) * 1024 * 1024 {
            truncated = true;
            break;
        }
        if let Some(app) = app {
            let _ = app.emit("grpc-message", json!({"operationId":operation_id,"message":value,"timestamp":crate::models::now()}));
        }
        values.push(value);
    }
    if !truncated {
        if let Some(trailers) = stream.trailers().await.map_err(|e| e.to_string())? {
            headers.extend(trailers.into_headers().iter().map(|(name, value)| Pair {
                name: name.to_string(),
                value: value.to_str().unwrap_or("[binary]").into(),
                ..Default::default()
            }));
        }
    }
    let value = if !method.is_server_streaming() && values.len() == 1 {
        values.remove(0)
    } else {
        json!(values)
    };
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    Ok(ResponseData {
        id: uuid::Uuid::new_v4().to_string(),
        request_id: request.id.clone(),
        status: 0,
        status_text: "OK".into(),
        url: request.url.clone(),
        headers,
        body_base64: STANDARD.encode(&body),
        size: body.len(),
        body,
        elapsed_ms: started.elapsed().as_millis() as u64,
        timestamp: crate::models::now(),
        truncated,
        protocol: "grpc".into(),
        logs: vec![],
    })
}
