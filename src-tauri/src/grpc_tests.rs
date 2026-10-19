use super::*;
use std::{
    convert::Infallible,
    sync::Arc,
    task::{Context, Poll},
};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tonic::{
    body::Body,
    codegen::{BoxFuture, Service},
    server::NamedService,
};

#[derive(Clone)]
struct EchoServer {
    descriptor: MessageDescriptor,
}

impl NamedService for EchoServer {
    const NAME: &'static str = "local.echo.Echo";
}

impl Service<http::Request<Body>> for EchoServer {
    type Response = http::Response<Body>;
    type Error = Infallible;
    type Future = BoxFuture<Self::Response, Self::Error>;
    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn call(&mut self, request: http::Request<Body>) -> Self::Future {
        struct Echo;
        impl tonic::server::StreamingService<DynamicMessage> for Echo {
            type Response = DynamicMessage;
            type ResponseStream = ReceiverStream<Result<DynamicMessage, Status>>;
            type Future = BoxFuture<tonic::Response<Self::ResponseStream>, Status>;
            fn call(&mut self, request: Request<tonic::Streaming<DynamicMessage>>) -> Self::Future {
                Box::pin(async move {
                    let mut stream = request.into_inner();
                    let (tx, rx) = tokio::sync::mpsc::channel(8);
                    tokio::spawn(async move {
                        while let Ok(Some(message)) = stream.message().await {
                            if tx.send(Ok(message)).await.is_err() {
                                break;
                            }
                        }
                    });
                    Ok(tonic::Response::new(ReceiverStream::new(rx)))
                })
            }
        }
        let descriptor = self.descriptor.clone();
        Box::pin(async move {
            let mut grpc = tonic::server::Grpc::new(DynamicCodec(descriptor));
            Ok(grpc.streaming(Echo, request).await)
        })
    }
}

#[tokio::test]
async fn native_grpc_reflection_unary_and_bidirectional_streaming_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("echo.proto");
    std::fs::write(&path, include_str!("../../examples/echo.proto")).unwrap();
    let descriptors = protox::compile([&path], [temp.path()]).unwrap();
    let pool = DescriptorPool::from_file_descriptor_set(descriptors.clone()).unwrap();
    let reflection = tonic_reflection::server::Builder::configure()
        .register_file_descriptor_set(descriptors)
        .build_v1()
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let shutdown = cancel.clone();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(EchoServer {
                descriptor: pool.get_message_by_name("local.echo.Message").unwrap(),
            })
            .add_service(reflection)
            .serve_with_incoming_shutdown(TcpListenerStream::new(listener), shutdown.cancelled())
            .await
            .unwrap();
    });
    let mut request = ApiRequest {
        protocol: "grpc".into(),
        url: format!("http://{address}"),
        ..Default::default()
    };
    let methods = list_methods(&request).await.unwrap();
    assert!(methods.iter().any(|m| m["name"] == "local.echo.Echo/Say"));
    request.grpc.method = "local.echo.Echo/Say".into();
    request.body.text = r#"{"text":"hello","count":42}"#.into();
    let response = execute(&request, None, "test-unary").await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response.body).unwrap(),
        json!({"text":"hello","count":42})
    );
    request.grpc.method = "local.echo.Echo/Chat".into();
    request.body.text = r#"[{"text":"one","count":1},{"text":"two","count":2}]"#.into();
    let response = execute(&request, None, "test-stream").await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response.body).unwrap(),
        json!([{"text":"one","count":1},{"text":"two","count":2}])
    );
    request.grpc.proto_file = path.to_string_lossy().into_owned();
    let response = execute(&request, None, "test-proto").await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response.body)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    cancel.cancel();
    server.await.unwrap();
    // Kept alive until all requests have closed their channels.
    drop(Arc::new(temp));
}

#[tokio::test]
async fn proto_discovery_does_not_require_a_server() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("echo.proto");
    std::fs::write(&path, include_str!("../../examples/echo.proto")).unwrap();
    let mut request = ApiRequest::default();
    request.grpc.proto_file = path.to_string_lossy().into_owned();
    assert_eq!(list_methods(&request).await.unwrap().len(), 2);
}
