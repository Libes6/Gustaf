//! The knowledge base extracts PDF text in a child process (the app binary itself) so a parser crash cannot take the app
//! down. This runs the real binary built by cargo.
use std::path::Path;

fn tiny_pdf(text: &str) -> Vec<u8> {
    let stream = format!("BT /F1 18 Tf 72 700 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for o in &offsets {
        out.extend(format!("{o:010} 00000 n \n").bytes());
    }
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
    out
}

#[test]
fn child_process_extracts_pdf_text_and_reports_bad_files() {
    let exe = Path::new(env!("CARGO_BIN_EXE_mcode"));
    let dir = std::env::temp_dir().join(format!("gustaf-pdf-child-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let good = dir.join("good.pdf");
    std::fs::write(&good, tiny_pdf("hello from the child process")).unwrap();
    let pages = mcode_lib::extract_pdf_with_exe(exe, &good).unwrap();
    assert_eq!(pages.len(), 1);
    assert!(pages[0].contains("hello from the child process"), "{pages:?}");

    let bad = dir.join("bad.pdf");
    std::fs::write(&bad, b"%PDF-1.4 not really").unwrap();
    assert!(mcode_lib::extract_pdf_with_exe(exe, &bad).is_err());
    assert!(mcode_lib::extract_pdf_with_exe(exe, &dir.join("missing.pdf")).is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}
