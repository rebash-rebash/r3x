use super::context::get_client;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ContainerPort {
    pub container_name: String,
    pub port: u16,
    pub protocol: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PortForwardSession {
    pub id: String,
    pub namespace: String,
    pub pod_name: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub status: String,
}

type SessionData = (tokio::sync::oneshot::Sender<()>, PortForwardSession);
type Sessions = Arc<Mutex<HashMap<String, SessionData>>>;

static PORT_FORWARD_SESSIONS: std::sync::OnceLock<Sessions> = std::sync::OnceLock::new();

fn sessions() -> &'static Sessions {
    PORT_FORWARD_SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

#[tauri::command]
pub async fn get_pod_ports(
    context: String,
    namespace: String,
    pod_name: String,
) -> Result<Vec<ContainerPort>, String> {
    let client = get_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let pod = api
        .get(&pod_name)
        .await
        .map_err(|e| format!("Failed to get pod: {}", e))?;

    let mut ports = Vec::new();
    if let Some(spec) = pod.spec {
        for container in &spec.containers {
            if let Some(container_ports) = &container.ports {
                for p in container_ports {
                    ports.push(ContainerPort {
                        container_name: container.name.clone(),
                        port: p.container_port as u16,
                        protocol: p.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                        name: p.name.clone(),
                    });
                }
            }
        }
    }

    Ok(ports)
}

#[tauri::command]
pub async fn start_port_forward(
    context: String,
    namespace: String,
    pod_name: String,
    local_port: u16,
    remote_port: u16,
) -> Result<PortForwardSession, String> {
    let client = get_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);

    // Verify pod exists
    api.get(&pod_name)
        .await
        .map_err(|e| format!("Pod not found: {}", e))?;

    let session_id = format!(
        "pf-{}-{}-{}-{}",
        namespace, pod_name, local_port, remote_port
    );

    // Check if already running
    {
        let guard = sessions().lock().await;
        if guard.contains_key(&session_id) {
            return Err(format!(
                "Port forward already active: localhost:{} -> {}:{}",
                local_port, pod_name, remote_port
            ));
        }
    }

    // Bind local port
    let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port))
        .await
        .map_err(|e| format!("Failed to bind port {}: {}", local_port, e))?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    let session_info = PortForwardSession {
        id: session_id.clone(),
        namespace: namespace.clone(),
        pod_name: pod_name.clone(),
        local_port,
        remote_port,
        status: "Active".to_string(),
    };

    {
        let mut guard = sessions().lock().await;
        guard.insert(session_id.clone(), (cancel_tx, session_info));
    }

    let sid = session_id.clone();
    let ns = namespace.clone();
    let pn = pod_name.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((mut tcp_stream, _)) => {
                            let api: Api<Pod> = Api::namespaced(client.clone(), &ns);
                            let rp = remote_port;
                            let pn2 = pn.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(&api, &pn2, rp, &mut tcp_stream).await {
                                    eprintln!("Port forward connection error: {}", e);
                                }
                            });
                        }
                        Err(e) => {
                            eprintln!("Accept error: {}", e);
                            break;
                        }
                    }
                }
                _ = &mut cancel_rx => {
                    break;
                }
            }
        }
        // Cleanup
        let mut guard = sessions().lock().await;
        guard.remove(&sid);
    });

    Ok(PortForwardSession {
        id: session_id.clone(),
        namespace,
        pod_name,
        local_port,
        remote_port,
        status: "Active".to_string(),
    })
}

async fn handle_connection(
    api: &Api<Pod>,
    pod_name: &str,
    remote_port: u16,
    tcp_stream: &mut tokio::net::TcpStream,
) -> Result<(), String> {
    let mut pf = api
        .portforward(pod_name, &[remote_port])
        .await
        .map_err(|e| format!("Portforward failed: {}", e))?;

    let mut upstream = pf
        .take_stream(remote_port)
        .ok_or("Failed to get port forward stream")?;

    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
    let (mut up_read, mut up_write) = tokio::io::split(&mut upstream);

    let client_to_pod = async {
        let mut buf = vec![0u8; 8192];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if up_write.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    let pod_to_client = async {
        let mut buf = vec![0u8; 8192];
        loop {
            match up_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tcp_write.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    tokio::select! {
        _ = client_to_pod => {}
        _ = pod_to_client => {}
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_port_forward(session_id: String) -> Result<String, String> {
    let mut guard = sessions().lock().await;
    if let Some((cancel_tx, _info)) = guard.remove(&session_id) {
        let _ = cancel_tx.send(());
        Ok(format!("Stopped port forward: {}", session_id))
    } else {
        Err(format!("No active port forward with id: {}", session_id))
    }
}

#[tauri::command]
pub async fn list_port_forwards() -> Result<Vec<PortForwardSession>, String> {
    let guard = sessions().lock().await;
    Ok(guard.values().map(|(_tx, info)| info.clone()).collect())
}
