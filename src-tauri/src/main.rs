// Windows: no console window behind the app in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! A thin shell around `aiax-router board`.
//!
//! It starts the bundled server, waits for it to say which port it took, points
//! the window at it, and kills it on the way out. There is no application logic
//! here on purpose: everything the user sees is served by the same server that
//! `aiax-router board` runs from a terminal.

use std::sync::Mutex;

use tauri::{Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The one child process the shell owns.
#[derive(Default)]
struct Server(Mutex<Option<CommandChild>>);

/// The server prints exactly one line like `The board is at http://127.0.0.1:5123`.
fn board_url(line: &str) -> Option<String> {
    let at = line.find("http://127.0.0.1:")?;
    let rest = &line[at..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']);
    // A bare host with no port is not a board.
    url.rsplit(':').next()?.parse::<u16>().ok()?;
    Some(url.to_string())
}

/// Loopback only. The board never listens anywhere else, so nothing else should
/// ever load in this window.
fn is_local(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" => matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")),
        // The starting screen and the asset protocol.
        "tauri" | "asset" | "ipc" => true,
        _ => false,
    }
}

fn start_server(app: &tauri::AppHandle, window: WebviewWindow) -> tauri::Result<()> {
    // A single executable has no package directory around it, so the server is
    // told where its data files were unpacked.
    let assets = app.path().resource_dir()?;

    let (mut rx, child) = app
        .shell()
        .sidecar("aiax-router-server")
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .env("AIAX_ROUTER_ASSETS", assets.to_string_lossy().to_string())
        // The shell holds the server's stdin. If this process dies without
        // getting to kill the server, the pipe closes and the server stops on
        // its own, so no board is ever left running behind a closed window.
        .env("AIAX_ROUTER_WATCH_STDIN", "1")
        // Port 0: the app picks whatever is free, so it can run next to a
        // terminal already serving the board on 4300.
        .args(["board", "--port", "0", "--no-open"])
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;

    app.state::<Server>().0.lock().unwrap().replace(child);

    tauri::async_runtime::spawn(async move {
        let mut opened = false;
        while let Some(event) = rx.recv().await {
            let line = match &event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    String::from_utf8_lossy(bytes).into_owned()
                }
                CommandEvent::Error(message) => {
                    eprintln!("server: {message}");
                    continue;
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("server stopped: {payload:?}");
                    continue;
                }
                _ => continue,
            };
            eprintln!("server: {}", line.trim_end());
            if opened {
                continue;
            }
            if let Some(url) = board_url(&line).and_then(|u| tauri::Url::parse(&u).ok()) {
                opened = true;
                if let Err(err) = window.navigate(url) {
                    eprintln!("could not open the board: {err}");
                }
            }
        }
    });

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Server::default())
        .setup(|app| {
            // Built here rather than declared in tauri.conf.json, because the
            // loopback guard is a window builder option and it is the only
            // thing keeping a remote page out of this window.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AiAx Router")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                .center()
                .on_navigation(is_local)
                .build()?;
            start_server(&app.handle().clone(), window)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            // Both events fire on a normal quit; killing twice is a no-op
            // because the child is taken out of the slot.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                let server: State<Server> = app.state();
                let child = server.0.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{board_url, is_local};

    #[test]
    fn reads_the_port_the_server_reports() {
        assert_eq!(
            board_url("The board is at http://127.0.0.1:61036\n").as_deref(),
            Some("http://127.0.0.1:61036")
        );
        assert_eq!(board_url("nothing here"), None);
        assert_eq!(board_url("http://127.0.0.1/"), None);
    }

    #[test]
    fn only_loopback_may_load() {
        let ok = |u: &str| is_local(&tauri::Url::parse(u).unwrap());
        assert!(ok("http://127.0.0.1:4300/"));
        assert!(ok("http://localhost:4300/"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("http://10.0.0.5:4300/"));
        assert!(!ok("file:///etc/passwd"));
    }
}
