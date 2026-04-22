// Prevents additional console window on Windows in release. Does not
// affect Linux/macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK 2.42+ enables a DMA-BUF renderer by default. On GNOME
    // mutter with `scale-monitor-framebuffer` (the fractional-scaling
    // path, engaged even at integer scales) this produces noticeably
    // blurry text and borders in the webview. Disabling the DMA-BUF
    // renderer switches back to the sharp GL path. Set before any GTK
    // init so WebKit picks it up. Respect an existing value so power
    // users can re-enable it.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    condash_lib::run()
}
