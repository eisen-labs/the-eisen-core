use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Emitter;

struct HostProcess {
    stdin: std::process::ChildStdin,
    _child: Child,
}

struct AppState {
    host: Mutex<Option<HostProcess>>,
}

#[tauri::command]
fn get_launch_cwd() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2)
        .find(|pair| pair[0] == "--cwd")
        .map(|pair| pair[1].clone())
}

#[tauri::command]
fn spawn_host(cwd: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut guard = state.host.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Host already running".into());
    }

    let bin = find_host_binary()?;
    log::info!("Spawning host: {} --cwd {}", bin.display(), cwd);

    let mut child = Command::new(&bin)
        .args(["--cwd", &cwd])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn host at {}: {}", bin.display(), e))?;

    let stdin = child.stdin.take().ok_or("Failed to capture host stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture host stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture host stderr")?;

    let app_stdout = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    let _ = app_stdout.emit("host-stdout", &l);
                }
                Err(e) => {
                    log::error!("Host stdout read error: {}", e);
                    break;
                }
                _ => {}
            }
        }
        let _ = app_stdout.emit("host-close", 0);
    });

    let app_stderr = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    log::error!("[eisen-host] {}", l);
                    let _ = app_stderr.emit("host-stderr", &l);
                }
                Err(_) => break,
                _ => {}
            }
        }
    });

    *guard = Some(HostProcess { stdin, _child: child });
    Ok(())
}

#[tauri::command]
fn send_to_host(message: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.host.lock().map_err(|e| e.to_string())?;
    let host = guard.as_mut().ok_or("Host not running")?;
    host.stdin
        .write_all(message.as_bytes())
        .map_err(|e| format!("Failed to write to host stdin: {}", e))
}

fn find_host_binary() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or("no exe dir")?;
    let name = host_binary_name();

    let candidates = [
        exe_dir.join("..").join("..").join("bin").join(&name),
        exe_dir.join("..").join("..").join("app").join("src-tauri").join("bin").join(&name),
    ];

    for path in &candidates {
        if path.exists() {
            return path.canonicalize().map_err(|e| e.to_string());
        }
    }

    Err(format!(
        "Host binary not found. Tried:\n  • {}\n  • {}\nRun 'bun run host:build' from the app directory, then try again.",
        candidates[0].display(),
        candidates[1].display()
    ))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn host_binary_name() -> String {
    "eisen-host-x86_64-unknown-linux-gnu".into()
}
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn host_binary_name() -> String {
    "eisen-host-aarch64-unknown-linux-gnu".into()
}
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn host_binary_name() -> String {
    "eisen-host-x86_64-apple-darwin".into()
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn host_binary_name() -> String {
    "eisen-host-aarch64-apple-darwin".into()
}
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn host_binary_name() -> String {
    "eisen-host-x86_64-pc-windows-msvc.exe".into()
}
#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn host_binary_name() -> String {
    unimplemented!("unsupported target for eisen-host")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(AppState {
            host: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_launch_cwd, spawn_host, send_to_host])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
