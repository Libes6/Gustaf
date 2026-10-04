// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Child mode for PDF text extraction (isolates parser crashes from the app); see knowledge.rs.
    if mcode_lib::pdf_child_main() {
        return;
    }
    mcode_lib::run()
}
