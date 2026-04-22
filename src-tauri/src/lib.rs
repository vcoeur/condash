// Phase 0 scaffold: the single Tauri builder entry. Later phases will
// mount axum handlers, wire up a state struct for the parser/cache, and
// expose IPC commands here — today it just opens a window pointed at the
// existing dashboard.html. API fetches the frontend makes will 404,
// which is the documented Phase 0 exit gate.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running condash Tauri application");
}
