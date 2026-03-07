use super::context::get_client;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams};
use std::sync::Arc;
use tauri::{Emitter, Listener, Window};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn exec_pod(
    window: Window,
    context: String,
    namespace: String,
    pod_name: String,
    container: Option<String>,
) -> Result<String, String> {
    let client = get_client(&context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    let session_id = format!(
        "exec-{}-{}-{}",
        namespace,
        pod_name,
        chrono::Utc::now().timestamp_millis()
    );
    let stdout_event = format!("{}-stdout", session_id);
    let stdin_event = format!("{}-stdin", session_id);
    let exit_event = format!("{}-exit", session_id);

    let mut ap = AttachParams::interactive_tty();
    if let Some(c) = container {
        ap = ap.container(c);
    }

    let session_id_clone = session_id.clone();
    let stdout_event_clone = stdout_event.clone();
    let exit_event_clone = exit_event.clone();
    let stdin_event_clone = stdin_event.clone();

    tokio::spawn(async move {
        match api
            .exec(
                &pod_name,
                vec![
                    "sh",
                    "-c",
                    "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi",
                ],
                &ap,
            )
            .await
        {
            Ok(mut attached) => {
                let mut stdout = attached.stdout().expect("stdout not available");
                let stdin = attached.stdin().expect("stdin not available");
                let stdin = Arc::new(Mutex::new(stdin));

                // Listen for stdin from frontend
                let stdin_clone = stdin.clone();
                let _listener = window.listen(stdin_event_clone, move |event| {
                    let raw = event.payload().to_string();
                    // Tauri serializes event payload as JSON — deserialize to get the actual string
                    let data: String = serde_json::from_str(&raw).unwrap_or(raw);
                    let stdin_clone = stdin_clone.clone();
                    tokio::spawn(async move {
                        let mut guard = stdin_clone.lock().await;
                        let _ = guard.write_all(data.as_bytes()).await;
                        let _ = guard.flush().await;
                    });
                });

                // Read stdout and emit to frontend
                let window_clone = window.clone();
                let stdout_ev = stdout_event_clone.clone();
                loop {
                    let mut buf = vec![0u8; 4096];
                    match tokio::io::AsyncReadExt::read(&mut stdout, &mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.truncate(n);
                            let text = String::from_utf8_lossy(&buf).to_string();
                            let _ = window_clone.emit(&stdout_ev, &text);
                        }
                        Err(_) => break,
                    }
                }

                let _ = window.emit(&exit_event_clone, "Session ended");
            }
            Err(e) => {
                let _ = window.emit(
                    &stdout_event_clone,
                    format!("Failed to exec: {}\r\n", e),
                );
                let _ = window.emit(&exit_event_clone, "Session failed");
            }
        }
    });

    Ok(session_id_clone)
}
