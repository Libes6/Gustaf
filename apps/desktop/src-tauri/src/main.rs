// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Child mode for PDF text extraction (isolates parser crashes from the app); see knowledge.rs.
    if gustaf_lib::pdf_child_main() {
        return;
    }
    gustaf_lib::run()
}
