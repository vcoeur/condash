// Prevents additional console window on Windows in release. Does not
// affect Linux/macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    condash_lib::run()
}
