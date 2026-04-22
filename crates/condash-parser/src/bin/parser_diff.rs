//! Phase 1 diff harness: parse every README under `<conception>/projects/`
//! in Rust *and* Python, drop the Python-only `files` key, and compare.
//!
//! Exit 0 = byte-identical JSON for every item; exit 1 = at least one
//! mismatch. The binary is a workspace-local dev tool, not something the
//! condash end-user runs — it exists to guard the Rust port as phases 2-4
//! build on top of it.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use condash_parser::parse_readme_content;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug)]
struct Args {
    conception: PathBuf,
    condash_src: PathBuf,
    python: String,
    driver: PathBuf,
}

fn parse_args() -> Args {
    let mut conception = None;
    let mut condash_src = None;
    let mut python = None;
    let mut driver = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--conception" => conception = Some(it.next().expect("--conception VALUE").into()),
            "--condash-src" => condash_src = Some(it.next().expect("--condash-src VALUE").into()),
            "--python" => python = Some(it.next().expect("--python VALUE")),
            "--driver" => driver = Some(it.next().expect("--driver VALUE").into()),
            "-h" | "--help" => {
                eprintln!(
                    "usage: parser-diff \\\n  --conception <base>  \\\n  --condash-src <condash/src>  \\\n  --driver <path-to-py_driver.py>  \\\n  [--python <python-exe>]"
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown arg: {other}");
                std::process::exit(2);
            }
        }
    }
    Args {
        conception: conception.expect("--conception required"),
        condash_src: condash_src.expect("--condash-src required"),
        python: python.unwrap_or_else(|| "python3".into()),
        driver: driver.expect("--driver required"),
    }
}

/// Collect every `README.md` under `root`, sorted, skipping dot-dirs.
fn collect_readmes(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            walk(&path, out);
        } else if name == "README.md" {
            out.push(path);
        }
    }
}

#[derive(Deserialize)]
struct DriverLine {
    path: String,
    data: Option<Value>,
}

/// Spawn the Python driver, stream READMEs to it, collect JSON back.
fn run_python_driver(
    python: &str,
    driver: &Path,
    condash_src: &Path,
    base_dir: &Path,
    readmes: &[PathBuf],
) -> std::io::Result<HashMap<String, Option<Value>>> {
    let mut child = Command::new(python)
        .arg(driver)
        .arg("--condash-src")
        .arg(condash_src)
        .arg("--base-dir")
        .arg(base_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;

    {
        // `take()` moves the ChildStdin out of the Child, so dropping it
        // actually closes the pipe and the Python driver sees EOF on
        // stdin. Using `as_mut()` only borrows — the handle stays alive
        // and the driver blocks forever. Ask me how I know.
        let mut stdin = child.stdin.take().expect("piped stdin");
        for p in readmes {
            writeln!(stdin, "{}", p.display())?;
        }
    } // drop stdin → EOF

    let stdout = child.stdout.take().expect("piped stdout");
    let reader = BufReader::new(stdout);
    let mut map = HashMap::with_capacity(readmes.len());
    for line in reader.lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let parsed: DriverLine = serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("driver emitted malformed JSON {line:?}: {e}"));
        map.insert(parsed.path, parsed.data);
    }

    let status = child.wait()?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "python driver exited with {status}"
        )));
    }
    Ok(map)
}

/// Derive the (slug, rel_path, item_dir, path-string-for-display) tuple
/// from a README path + base_dir. Mirrors what Python's parse_readme
/// would compute from `ctx.base_dir` + `path`.
fn coords(path: &Path, base_dir: &Path) -> Option<(String, String, String)> {
    let rel = path.strip_prefix(base_dir).ok()?;
    let parent = rel.parent()?;
    let slug = parent.file_name()?.to_string_lossy().to_string();
    // Use forward slashes so the output matches Python's `str(PosixPath)`.
    let rel_path = rel.to_string_lossy().replace('\\', "/");
    let item_dir = parent.to_string_lossy().replace('\\', "/");
    Some((slug, rel_path, item_dir))
}

fn parse_in_rust(path: &Path, base_dir: &Path) -> (String, Option<Value>) {
    let (slug, rel_path, item_dir) = coords(path, base_dir).expect("path under base_dir");
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (rel_path, None),
    };
    let parsed = parse_readme_content(&content, &slug, &rel_path, &item_dir, None)
        .and_then(|r| serde_json::to_value(&r).ok());
    (rel_path, parsed)
}

fn main() {
    let args = parse_args();

    let projects = args.conception.join("projects");
    let readmes = collect_readmes(&projects);
    eprintln!(
        "diff: found {} READMEs under {}",
        readmes.len(),
        projects.display()
    );

    let py = run_python_driver(
        &args.python,
        &args.driver,
        &args.condash_src,
        &args.conception,
        &readmes,
    )
    .expect("python driver failed");

    let mut matched = 0usize;
    let mut mismatched = 0usize;
    let mut missing_py = 0usize;

    for path in &readmes {
        let (rel, rust_value) = parse_in_rust(path, &args.conception);
        let py_value = match py.get(&rel) {
            Some(v) => v,
            None => {
                eprintln!("[MISSING-PY] {rel}");
                missing_py += 1;
                continue;
            }
        };
        if py_value == &rust_value {
            matched += 1;
        } else {
            mismatched += 1;
            report_mismatch(&rel, py_value, &rust_value);
        }
    }

    eprintln!(
        "diff: matched={} mismatched={} missing_py={} total={}",
        matched,
        mismatched,
        missing_py,
        readmes.len()
    );

    if mismatched > 0 || missing_py > 0 {
        std::process::exit(1);
    }
}

/// Print the first few differing fields for an item. We don't dump the
/// full JSON — it's thousands of lines for big READMEs — just identify
/// the keys that differ so the next triage pass is cheap.
fn report_mismatch(rel: &str, py: &Option<Value>, rust: &Option<Value>) {
    eprintln!("[MISMATCH] {rel}");
    match (py, rust) {
        (None, None) => unreachable!("equality already checked"),
        (None, Some(_)) => eprintln!("  python: None  rust: Some(…)"),
        (Some(_), None) => eprintln!("  python: Some(…)  rust: None"),
        (Some(py), Some(rust)) => {
            let py_obj = py.as_object();
            let rust_obj = rust.as_object();
            if let (Some(py_obj), Some(rust_obj)) = (py_obj, rust_obj) {
                let mut keys: Vec<_> = py_obj
                    .keys()
                    .chain(rust_obj.keys())
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                keys.sort();
                for k in keys {
                    let p = py_obj.get(k);
                    let r = rust_obj.get(k);
                    if p != r {
                        eprintln!("  key {k}:");
                        eprintln!("    python: {}", truncate(&format!("{:?}", p)));
                        eprintln!("    rust:   {}", truncate(&format!("{:?}", r)));
                    }
                }
            } else {
                eprintln!("  (non-object values)");
            }
        }
    }
}

fn truncate(s: &str) -> String {
    let max = 200;
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}
